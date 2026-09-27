import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiFeedbackPayload,
  appendFailedPreflightEntry,
  appendFailedRunEntry,
  firstRunnableClaudeModel,
  capturedFailureDetail,
  hydrateAiFeedback,
  parseRunsFromLog,
  preflightRunConfig,
  qualityStateFromRun,
  resolveClaudeModel,
  resolveClaudePermissionMode,
  resolveCodexReasoningEffort,
  runsWithPinnedLatestFailure,
} from '../server-core.js'
import {
  runFailureDetail,
  runHistorySummary,
  runOutputDetail,
} from '../src/lib/runHistory.js'
import {
  newestFailedRunKey,
  runHistoryKey,
} from '../src/lib/runSignals.js'
import { incubatorLauncherScript } from '../server/incubator-templates.js'
import { staleSourceRestartPlan, validateSourceForRestart } from '../server/service-health.js'
import { breakage, checksAllowCompletion, checksLine, insertIntoRunSection, isUnproductive, nextStage, parseBrief, parseReview, milestoneSnapshot, runChecks } from './lib/session.mjs'
import { commitHeadline } from './lib/incubator-run.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function tempDir(name) {
  return fs.mkdtempSync(join(os.tmpdir(), `pi-pulse-${name}-`))
}

// server.js is the route table; the logic lives in server/*.js. Source-contract
// assertions read them together so moving code between modules stays free.
function serverSource() {
  const moduleDir = join(root, 'server')
  const files = [join(root, 'server.js'), ...fs.readdirSync(moduleDir).filter(name => name.endsWith('.js')).sort().map(name => join(moduleDir, name))]
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}

// Codex and Claude share one runner; the shims only pick the agent.
function runnerSource() {
  return ['run-incubator.sh', join('lib', 'incubator-run.mjs')]
    .map(file => fs.readFileSync(join(root, 'scripts', file), 'utf8'))
    .join('\n')
}

function assertIncludes(haystack, needle, message) {
  assert.ok(String(haystack).includes(needle), `${message}: expected "${haystack}" to include "${needle}"`)
}

function testStdoutFailedRunsShowCommandError() {
  const dir = tempDir('stdout-failed')
  const runLogPath = join(dir, 'RUN_LOG.md')
  const capturePath = join(dir, 'capture.log')
  fs.writeFileSync(capturePath, [
    'starting run',
    'bash: line 7: codex: command not found',
    'cleanup: preserving temp transcript',
    'scheduler: marked child process closed',
    'exit status 127',
    '',
  ].join('\n'))

  appendFailedRunEntry({ runLogPath, capturePath, code: 127, signal: null, num: 105 })
  const runs = parseRunsFromLog(fs.readFileSync(runLogPath, 'utf8'))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assert.equal(runs[0].num, 105)
  assertIncludes(runs[0].Failure, 'exit 127', 'failure summary should include process exit')
  assertIncludes(runs[0].Failure, 'codex: command not found', 'failure summary should include the command error')
  assertIncludes(runs[0].detail, 'scheduler: marked child process closed', 'failure detail should keep the captured tail')
  assertIncludes(runs[0].detail, 'codex: command not found', 'failure detail should expose command error')
}

function testCapturedFailureDetailIsReusableForStatusReceipts() {
  const dir = tempDir('captured-failure-detail')
  const capturePath = join(dir, 'capture.log')
  fs.writeFileSync(capturePath, [
    'launcher selected Claude relay',
    'bash: line 12: claude: command not found',
    'runner exited before status write',
    'exit status 127',
    '',
  ].join('\n'))

  const detail = capturedFailureDetail(capturePath)
  assertIncludes(detail, 'claude: command not found', 'captured status failure should expose command error')
  assertIncludes(detail, 'runner exited before status write', 'captured status failure should keep useful tail detail')
}

function testScheduledPreflightPersistsUsefulFailureDetail() {
  const dir = tempDir('scheduled-preflight')
  const runLogPath = join(dir, 'RUN_LOG.md')
  appendFailedPreflightEntry({
    runLogPath,
    num: 106,
    preflight: {
      ok: false,
      error: 'codex not found in PATH',
      checks: [
        { label: 'codex binary', ok: false, detail: 'codex not found in PATH', path: '/missing/codex' },
        { label: 'prompt directory', ok: false, detail: 'not found', path: '/missing/prompts' },
      ],
    },
  })

  const runs = parseRunsFromLog(fs.readFileSync(runLogPath, 'utf8'))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, '[run failed - scheduled preflight]', 'scheduled preflight should be marked failed')
  assertIncludes(runs[0].detail, 'prompt directory: not found (/missing/prompts)', 'scheduled preflight should keep failed check detail')
}

function testManualPreflightPersistsUsefulFailureDetail() {
  const dir = tempDir('manual-preflight')
  const runLogPath = join(dir, 'RUN_LOG.md')
  appendFailedPreflightEntry({
    runLogPath,
    num: 107,
    source: 'manual-preflight',
    label: 'manual preflight',
    preflight: {
      ok: false,
      error: 'claude not found in PATH',
      command: 'bash /home/admin/lab/projects/new-slot/run-new-slot.sh /home/admin/lab/projects/new-slot/status.json mutate',
      checks: [
        { label: 'run script', ok: true, detail: 'ok', path: '/home/admin/run-new-slot.sh' },
        { label: 'claude binary', ok: false, detail: 'claude not found in PATH' },
        { label: 'Claude model', ok: false, detail: 'missing Claude model' },
      ],
    },
  })

  const runs = parseRunsFromLog(fs.readFileSync(runLogPath, 'utf8'))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, '[run failed - manual preflight]', 'manual preflight should be marked failed')
  assertIncludes(runs[0].detail, 'Launch command: bash /home/admin/lab/projects/new-slot/run-new-slot.sh', 'manual preflight should keep the exact launch command')
  assertIncludes(runs[0].detail, 'claude binary: claude not found in PATH', 'manual preflight should keep the runner command error')
  assertIncludes(runs[0].detail, 'Claude model: missing Claude model', 'manual preflight should keep model detail')
}

function testPreflightBlocksBadCodexRunBeforeLaunch() {
  const dir = tempDir('preflight')
  const repo = join(dir, 'repo')
  const prompts = join(repo, 'prompts')
  const logDir = join(dir, 'logs')
  const statusPath = join(dir, 'status.json')
  const runScript = join(dir, 'run.sh')
  const fakeCodex = join(dir, 'codex')
  fs.mkdirSync(prompts, { recursive: true })
  fs.mkdirSync(logDir)
  fs.writeFileSync(statusPath, '{}\n')
  fs.writeFileSync(runScript, '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(fakeCodex, '#!/usr/bin/env bash\nexit 0\n')
  fs.chmodSync(runScript, 0o755)
  fs.chmodSync(fakeCodex, 0o755)

  const oldCodexBin = process.env.CODEX_BIN
  process.env.CODEX_BIN = fakeCodex
  try {
    const preflight = preflightRunConfig({
      id: 'fixture',
      project: 'fixture',
      runner: 'codex',
      runScript,
      repo,
      runLog: join(logDir, 'RUN_LOG.md'),
      statusPath,
      promptDir: prompts,
      runTypes: ['mutate'],
    })
    assert.equal(preflight.ok, false)
    assert.equal(preflight.error, 'not found')
    assert.equal(preflight.checks.find(c => c.id === 'prompt')?.ok, false)
  } finally {
    if (oldCodexBin == null) delete process.env.CODEX_BIN
    else process.env.CODEX_BIN = oldCodexBin
  }
}

function testClaudePreflightUsesConfiguredBinaryFallback() {
  const dir = tempDir('claude-fallback')
  const repo = join(dir, 'repo')
  const prompts = join(repo, 'prompts')
  const logDir = join(dir, 'logs')
  const statusPath = join(dir, 'status.json')
  const runScript = join(dir, 'run-claude-incubator.sh')
  const fakeClaude = join(dir, 'bin', 'claude')
  fs.mkdirSync(prompts, { recursive: true })
  fs.mkdirSync(logDir)
  fs.mkdirSync(dirname(fakeClaude), { recursive: true })
  fs.writeFileSync(statusPath, '{}\n')
  fs.writeFileSync(runScript, '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(fakeClaude, '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(join(prompts, 'mutate.md'), 'mutate this\n')
  fs.chmodSync(runScript, 0o755)
  fs.chmodSync(fakeClaude, 0o755)

  const oldClaudeBin = process.env.CLAUDE_BIN
  process.env.CLAUDE_BIN = fakeClaude
  try {
    const preflight = preflightRunConfig({
      id: 'fixture',
      project: 'fixture',
      runner: 'claude',
      runScript,
      repo,
      runLog: join(logDir, 'RUN_LOG.md'),
      statusPath,
      promptDir: prompts,
      runTypes: ['mutate'],
      allowClaudeDefaultModel: true,
    })
    assert.equal(preflight.ok, true)
    assert.equal(preflight.checks.find(c => c.id === 'binary')?.detail, fakeClaude)
  } finally {
    if (oldClaudeBin == null) delete process.env.CLAUDE_BIN
    else process.env.CLAUDE_BIN = oldClaudeBin
  }
}

function testClaudePreflightChecksLauncherBackedRelay() {
  const dir = tempDir('claude-relay')
  const repo = join(dir, 'repo')
  const prompts = join(repo, 'prompts')
  const logDir = join(dir, 'logs')
  const statusPath = join(dir, 'status.json')
  const launcher = join(dir, 'run-fresh-slot.sh')
  const relayScript = join(dir, 'missing-run-claude-incubator.sh')
  const fakeClaude = join(dir, 'bin', 'claude')
  fs.mkdirSync(prompts, { recursive: true })
  fs.mkdirSync(logDir)
  fs.mkdirSync(dirname(fakeClaude), { recursive: true })
  fs.writeFileSync(statusPath, '{}\n')
  fs.writeFileSync(launcher, '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(fakeClaude, '#!/usr/bin/env bash\nexit 0\n')
  fs.writeFileSync(join(prompts, 'mutate.md'), 'mutate this\n')
  fs.chmodSync(launcher, 0o755)
  fs.chmodSync(fakeClaude, 0o755)

  const oldClaudeBin = process.env.CLAUDE_BIN
  process.env.CLAUDE_BIN = fakeClaude
  try {
    const preflight = preflightRunConfig({
      id: 'fresh-slot',
      project: 'fresh-slot',
      runner: 'claude',
      runScript: launcher,
      relayScript,
      launcher,
      repo,
      runLog: join(logDir, 'RUN_LOG.md'),
      statusPath,
      promptDir: prompts,
      runTypes: ['mutate'],
      claudeModel: 'sonnet',
      allowClaudeDefaultModel: true,
    })
    assert.equal(preflight.ok, false)
    assert.equal(preflight.launcher, launcher)
    assert.equal(preflight.relayScript, relayScript)
    assert.equal(preflight.checks.find(c => c.id === 'script')?.ok, true)
    assert.equal(preflight.checks.find(c => c.id === 'relayScript')?.ok, false)
    assertIncludes(preflight.error, 'not found', 'launcher-backed Claude preflight should fail on the missing relay')
  } finally {
    if (oldClaudeBin == null) delete process.env.CLAUDE_BIN
    else process.env.CLAUDE_BIN = oldClaudeBin
  }
}

function testRetiredClaudePinsFallThroughButAliasesStay() {
  assert.equal(firstRunnableClaudeModel('claude-sonnet-4-20250514', 'sonnet'), 'sonnet', 'retired full ids never reach the CLI')
  assert.equal(firstRunnableClaudeModel('fable', 'sonnet'), 'fable', 'fable is a current Claude CLI alias and a user choice')
  assert.equal(firstRunnableClaudeModel('', null), null)
  assert.equal(resolveClaudeModel(undefined, {}), 'sonnet')
  assert.equal(resolveClaudeModel(undefined, { CLAUDE_MODEL: 'opus' }), 'opus')
  assert.equal(resolveClaudeModel('claude-sonnet-4-20250514', { PI_PULSE_DEFAULT_CLAUDE_MODEL: 'fable' }), 'fable')
  assert.equal(resolveClaudePermissionMode(undefined, {}), 'auto', 'headless Claude runs need an explicit non-prompting mode')
  assert.equal(resolveClaudePermissionMode('acceptEdits', {}), 'acceptEdits')
  assert.equal(resolveClaudePermissionMode(undefined, { CLAUDE_PERMISSION_MODE: 'dontAsk' }), 'dontAsk')
  assert.equal(resolveClaudePermissionMode('bypassPermissions', {}), 'auto', 'bypass is only reachable through the explicit manual bypass flag')
}

function testFreshIncubatorsHaveGenericClaudeRunner() {
  const server = serverSource()
  const shimPath = join(root, 'scripts', 'run-claude-incubator.sh')
  const shim = fs.readFileSync(shimPath, 'utf8')
  const script = runnerSource()

  assert.ok(fs.statSync(shimPath).mode & 0o111, 'generic Claude incubator entrypoint should be executable')
  assert.ok(fs.statSync(join(root, 'scripts', 'run-incubator.sh')).mode & 0o111, 'unified incubator runner should be executable')
  assertIncludes(shim, 'export PI_PULSE_AGENT=claude', 'Claude entrypoint should select the Claude agent')
  assertIncludes(shim, 'exec bash "$SCRIPT_DIR/run-incubator.sh" "$@"', 'Claude entrypoint should delegate to the unified runner')
  assertIncludes(server, 'GENERIC_CLAUDE_INCUBATOR_SCRIPT', 'server should define a generic Claude runner script')
  assertIncludes(server, 'if (cfg.claudeRunScript === GENERIC_CLAUDE_INCUBATOR_SCRIPT && fs.existsSync(cfg.claudeRunScript)) return cfg.claudeRunScript', 'fresh slots should only preserve the generic Claude runner path')
  assertIncludes(server, 'return GENERIC_CLAUDE_INCUBATOR_SCRIPT', 'fresh slots should fall back to the generic Claude runner')
  assertIncludes(server, 'claudeRunScript: GENERIC_CLAUDE_INCUBATOR_SCRIPT', 'idea-created incubators should persist their Claude runner path')
  assertIncludes(server, 'claudeModel: null', 'idea-created incubators should avoid stale hard-pinned Claude models')
  assertIncludes(server, 'status.runScript = status.launcher', 'fresh incubators should launch through their own project launcher')
  assertIncludes(server, 'cfg.runScript === cfg.launcher', 'launcher-backed runs should receive the slot status path')
  assertIncludes(server, "cfg.runner === 'claude' && cfg.runScript?.includes('run-claude-incubator.sh')", 'generic Claude runs should receive the slot status path')
  assertIncludes(script, 'STATUS_PATH=${1:-}', 'generic Claude runner should be status-file driven')
  assertIncludes(script, 'RUN_LOG.md', 'generic Claude runner comments should identify run history behavior')
  assertIncludes(script, 'could not build the session prompt', 'the runner fails visibly when it cannot build the session prompt')
  assertIncludes(script, 'Full stdout saved to $STDOUT_FILE', 'generic Claude runner should preserve stdout for run history detail')
  assertIncludes(script, 'CLAUDE_ARGS=(-p "$FULL_PROMPT")', 'generic Claude runner should build model args from repaired status')
  assertIncludes(script, '${CLAUDE_BIN:-$(command -v claude || true)}', 'generic Claude runner should honor the same configured binary as preflight')
}

function testNewIncubatorInsideParentGetsOwnHistory() {
  const dir = tempDir('new-project-history')
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
  const created = runInLab(dir, `
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    console.log(JSON.stringify(store.createIncubatorProjectFromIdea('A lasting calm game', 'Quiet Water')))
  `)
  assert.equal(created.ok, true)
  assert.equal(created.status.lifecycle, 'product')
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: created.status.repo, encoding: 'utf8' })
  assert.equal(top.stdout.trim(), created.status.repo, 'new projects never inherit the parent repository as their history')
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, encoding: 'utf8' }).status, 128, 'the parent repo is not committed or changed')
}

function testExistingIncubatorsNormalizeClaudeRelayState() {
  const server = serverSource()

  assertIncludes(server, 'function normalizeIncubatorStatus(statusPath)', 'existing incubator slots should be normalized before relay switching')
  assertIncludes(server, 'function ensureIncubatorProjectScaffold(status)', 'existing incubator slots should get missing run scaffold repaired')
  assert.ok(!server.includes('promptForIncubatorRunType'), 'sessions build their prompt in code; no prompt files are scaffolded')
  assertIncludes(server, "writeFileIfMissing(status.runLog, '# Run Log\\n\\n')", 'normalization should create a readable run log when history is missing')
  assertIncludes(server, "const { status: cfg } = normalizeIncubatorStatus(slot.statusPath)", 'history reads should repair missing scaffold before loading RUN_LOG.md')
  assertIncludes(server, "const project = safePathSegment(next.project || basename(dirname(safeStatusPath)), 'incubator')", 'normalization should recover and sanitize a project id from the trusted status path')
  assertIncludes(server, 'const launcherInfo = writeIncubatorLauncher({ slug: project, statusPath: safeStatusPath })', 'normalization should reconcile launchers using the trusted status path')
  assertIncludes(server, 'if (launcherInfo.repaired) changed = true', 'normalization should report stale launcher repairs instead of hiding them')
  assertIncludes(server, 'next.claudeRunScript = GENERIC_CLAUDE_INCUBATOR_SCRIPT', 'normalization should force the generic status-driven Claude relay')
  assertIncludes(server, 'if (next.claudeModel && !firstRunnableClaudeModel(next.claudeModel))', 'normalization should quarantine stale Claude model pins before switching')
  assertIncludes(server, 'next.runScript = next.launcher', 'generic script statuses should be repaired to use their project launcher')
  assertIncludes(server, 'const normalized = normalizeIncubatorStatus(statusPath)', 'runner switches should start from normalized existing project status')
  assertIncludes(server, 'const status = normalized.status', 'runner switches should keep using the normalized project status')
  assertIncludes(server, 'const normalized = normalizeIncubatorStatus(statusPath)', 'preflight/hydrate/run repair should normalize old slots')
  assertIncludes(server, 'if (status.runner !== \'claude\') return normalized', 'non-Claude slots should still return repaired launcher metadata')
  assertIncludes(server, 'claudeModel: firstRunnableClaudeModel(cfg.claudeModel) ?? null', 'incubator payload should not display stale fable as the selected Claude model')
  assert.ok(!server.includes("'race-whisperer-predict': '/home/admin/run-race-whisperer.sh'"), 'project slots should not use project-specific scripts as Claude relays')
}

function testStdoutOnlyApiErrorsBecomeFailedRows() {
  const content = [
    '# Child Project Run Log',
    '',
    '<!-- stdout from run 14 2026-07-04 server-captured -->',
    'Claude relay starting...',
    'API Error: model fable not found',
    'The process exited 1 before writing a summary.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, 'API Error: model fable not found', 'stdout-only API errors should be visible as failed history')
  assertIncludes(runs[0].detail, 'The process exited 1 before writing a summary.', 'stdout-only API errors should retain useful detail')
}

function testStdoutBoldFailedRowsDoNotNeedErrorText() {
  const content = [
    '# Child Project Run Log',
    '',
    '<!-- stdout from run 15 2026-07-04 server-captured -->',
    'relay returned no structured summary',
    '**Run 15 - FAILED - server capture**',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, 'relay returned no structured summary', 'bold FAILED stdout rows should stay failed even without an error keyword')
  assertIncludes(runs[0].detail, 'relay returned no structured summary', 'bold FAILED stdout rows should still expose captured detail')
}

function testFormalNoSummaryApiErrorsBecomeFailedRows() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 16 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Claude completed but did not append a run summary.',
    '**Output excerpt:** API Error: model fable not found',
    '**Output:** Full stdout saved to /tmp/stdout/claude-run-16.log',
    '**Next move:** Switch to claude-sonnet-4-20250514 and rerun.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, 'API Error: model fable not found', 'formal no-summary API errors should become failed rows')
  assertIncludes(runs[0].detail, 'Output: Full stdout saved to /tmp/stdout/claude-run-16.log', 'formal no-summary failures should keep stdout location')
}

function testPerIncubatorAiFeedbackShape() {
  const response = [
    'DIRECTION: Make each run legible.',
    'STRONGEST SIGNAL: Failure rows are visible.',
    'WEAKNESS: The behavior lacks fixtures.',
    'DRIFT: no - this follows the trust seed.',
    'THE NEXT BEST ACTION: Keep the trust harness close to the server.',
  ].join('\n')

  const payload = aiFeedbackPayload({
    response,
    model: 'qwen2.5-instruct:1.5b',
    incubatorId: 'race-whisperer-predict',
    project: 'race-whisperer-predict',
    ts: 123,
  })

  assert.equal(payload.source, 'local-ollama-qwen')
  assert.equal(payload.incubatorId, 'race-whisperer-predict')
  assert.equal(payload.fields.STRONGEST, 'Failure rows are visible.')
  assert.equal(payload.fields.WEAKEST, 'The behavior lacks fixtures.')
  assert.equal(payload.fields.NEXT, 'Keep the trust harness close to the server.')
  assert.deepEqual(payload.missing, [])
  assert.equal(payload.malformed, false)

  const hydrated = hydrateAiFeedback({ ok: true, raw: response }, { id: 'core', project: 'pi-pulse' })
  assert.equal(hydrated.incubatorId, 'core')
  assert.equal(hydrated.project, 'pi-pulse')
  assert.equal(hydrated.source, 'local-ollama-qwen')
  assert.equal(hydrated.fields.DIRECTION, 'Make each run legible.')
}

function testApiFallbackCannotServeSpaHtml() {
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  const apiErrorIndex = server.indexOf("app.use('/api', (err")
  const api404Index = server.indexOf("app.use('/api', (req")
  const spaIndex = server.indexOf("app.get('*'")
  assert.ok(apiErrorIndex > 0, 'server should define a JSON /api error handler')
  assert.ok(api404Index > 0, 'server should define an /api 404 handler')
  assert.ok(api404Index > apiErrorIndex, 'API error handler must run before the /api 404 handler')
  assert.ok(spaIndex > api404Index, 'SPA fallback must be registered after the /api 404 handler')
  assertIncludes(
    server.slice(apiErrorIndex, api404Index),
    "res.status(status).json({",
    'thrown /api route errors must return JSON, not Express HTML'
  )
  assert.match(
    server.slice(api404Index, spaIndex),
    /res\.status\(404\)\.json\(\{\s*ok:\s*false,\s*error:\s*'api route not found',\s*path:\s*req\.originalUrl\s*\}\)/s,
    'unknown /api/* routes must return JSON, not index.html'
  )
}

function testCachedAiLatestEndpointsHydrateLegacyFiles() {
  const server = serverSource()
  assertIncludes(server, 'function readCachedAiFeedback(target)', 'server should centralize saved AI feedback hydration')
  assertIncludes(server, "app.get('/api/incubators/:id/ai/latest'", 'incubator latest endpoint should exist')
  assert.ok(!server.includes("'/api/child/"), 'retired mounted-child endpoints should stay removed; incubator slots replace them')
  assert.ok(!server.includes('CHILD_FEEDBACK_JSON'), 'retired mounted-child AI feedback cache should stay removed')
  assertIncludes(server, "app.get('/api/ai/latest'", 'legacy core latest endpoint should exist')
  assertIncludes(
    server,
    "res.json(readCachedAiFeedback(target))",
    'incubator latest endpoint should hydrate cached feedback before returning it'
  )
  assertIncludes(
    server,
    'paths: { json: CORE_FEEDBACK_JSON, md: CORE_FEEDBACK_MD }',
    'legacy core latest endpoint should use the same cached feedback contract'
  )
}

function testPreflightBlockedLaunchLooksBlocked() {
  const server = serverSource()
  assertIncludes(server, 'function appendManualPreflightFailure', 'manual launch preflight blocks should append durable FAILED history')
  assertIncludes(server, "source: 'manual-preflight'", 'manual preflight history rows should identify manual launch blocks')
  assertIncludes(server, 'appendManualPreflightFailure({\n      slot,\n      runLogPath,\n      preflight: result.preflight,\n    })\n    notifyIncubatorClients()', 'manual incubator preflight blocks should broadcast the newly written FAILED history row')
  assertIncludes(server, 'function appendIncubatorPreflightFailure', 'incubator preflight failures should share one durable status/history receipt path')
  assertIncludes(server, 'markIncubatorPreflightAttempt({ statusPath: slot.statusPath, preflight, num, label })', 'incubator preflight failures should update status so later run numbers advance')
  assertIncludes(server, 'function markIncubatorProcessFailure', 'process-level incubator failures should update slot status, not only history')
  assertIncludes(server, 'capturedFailureDetail(capturePath)', 'process-level failure status should reuse the captured command error')
  assertIncludes(server, "lastRunFailureSource: cfg.lastRunFailureSource", 'hydrated incubator slots should expose the failure source')
  assertIncludes(server, 'const runs = parsedRunsForLog(status.runLog)', 'next incubator run numbers should include existing FAILED history rows through the cached parser')
  assertIncludes(server, "availableRunners: ['codex', 'claude']", 'Claude should stay visible as a relay option even when setup is incomplete')
  assertIncludes(server, 'function claudeRunnerSetupForStatus(cfg)', 'server should report Claude setup state separately from launch preflight')
  assertIncludes(server, "runnerSetups: { claude: claudeSetup }", 'incubator payload should include Claude setup diagnostics')
  assertIncludes(server, 'function repairClaudeRunnerStatusIfNeeded(statusPath)', 'half-switched Claude slots should be repaired during hydrate/preflight/run')
  assertIncludes(server, "repairedRunnerConfig: repaired ? 'claude' : null", 'incubator payload should disclose automatic Claude runner repair')
  assertIncludes(server, "const { status: cfg } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)", 'incubator preflight/run paths should use repaired Claude runner status')
  assertIncludes(server, 'if (next.claudeModel !== setup.model)', 'half-switched Claude slots should persist the repaired safe model')
  assertIncludes(server, 'Claude relay selected but blocked:', 'Claude relay selection should persist and clearly say when launch preflight is blocked')
  assertIncludes(server, "warning: setup.ok ? `Claude relay selected: ${selectedDetail}`", 'successful Claude relay switches should show the exact persisted model and script')
  assertIncludes(server, "(${selectedDetail})", 'blocked Claude relay switches should still expose the persisted model and script')
  assertIncludes(server, 'function runnableLauncherForStatus(cfg = {})', 'runner switches should detect a project launcher before falling back to generic scripts')
  assertIncludes(server, 'const relayScript = setup.script || setup.expectedScript || GENERIC_CLAUDE_INCUBATOR_SCRIPT', 'Claude relay switch should still resolve the runnable Claude relay before saving')
  assertIncludes(server, 'status.runScript = runnableLauncherForStatus(status) || relayScript', 'Claude relay switch should preserve a project launcher as the launch path')
  assertIncludes(server, 'status.claudeRunScript = relayScript', 'Claude relay switch should store the actual Claude relay separately from the launcher')
  assertIncludes(server, 'launchScript: cfg.runScript ?? null', 'incubator payload should expose the persisted launch entrypoint')
  assertIncludes(server, 'claudeRelayScript,', 'incubator payload should expose the actual Claude relay script')
  assertIncludes(server, 'const preflight = preflightIncubatorRun(slot)', 'relay switch responses should include launch preflight for the selected runner')
  assertIncludes(server, 'preflight,', 'relay switch responses should return immediate launch readiness detail')
  assertIncludes(server, 'function incubatorRunArgs(cfg, statusPath, runType = null)', 'incubator preflight and launch should share argument resolution')
  assertIncludes(server, 'function incubatorLaunchCommand(cfg, statusPath, runType = null)', 'incubator preflight should expose the exact launch command')
  assertIncludes(server, 'command: incubatorLaunchCommand(cfg, slot.statusPath, runType)', 'incubator preflight payload should include the resolved launch command')
  assertIncludes(server, 'const args = incubatorRunArgs(cfg, slot.statusPath, runType)', 'incubator launch should use the same args reported by preflight')
  assertIncludes(server, "res.status(500).json({", 'incubator run history read failures should return an explicit failed API response')
  assertIncludes(server, 'statusPath: slot.statusPath', 'incubator history errors should include the status path for diagnosis')
  assertIncludes(server, 'function writeIncubatorLauncher', 'new incubators should get their own project launcher script')
  assertIncludes(server, 'status.launcher = writeIncubatorLauncher({ slug, statusPath }).path', 'new incubator status should record the launcher path')
  assertIncludes(server, 'if (current !== content)', 'generated incubator launchers should be rewritten when stale')
  assertIncludes(server, 'return { path: launcherPath, repaired }', 'launcher repair should be visible to normalization')
  assertIncludes(server, 'incubatorLauncherScript({ runnerScript: INCUBATOR_RUNNER_SCRIPT, statusPath })', 'project launchers should delegate every agent to the unified incubator runner')
  const launcher = incubatorLauncherScript({ runnerScript: '/lab/src/pi-pulse/scripts/run-incubator.sh', statusPath: '/lab/projects/demo $x/status.json' })
  assertIncludes(launcher, 'exec bash /lab/src/pi-pulse/scripts/run-incubator.sh "${1:-/lab/projects/demo \\$x/status.json}" "${2:-}"', 'launchers should pin a shell-safe default status path and pass the run type through')
  assertIncludes(server, 'function suggestedIncubatorTitle(idea)', 'idea-created incubators should derive a short display title instead of using the full request')
  assertIncludes(server, "function createIncubatorProjectFromIdea(idea, requestedTitle = '')", 'idea-created incubators should accept an optional short title override')
  assertIncludes(server, 'const title = normalizedIncubatorTitle(requestedTitle) || suggestedIncubatorTitle(cleanIdea)', 'new incubator creation should title the project before slugging it')
  assertIncludes(server, 'const slug = uniqueIncubatorSlug(title)', 'new incubator slugs should be based on the short generated title')
  assertIncludes(server, 'displayName: title', 'new incubator status should persist the generated display title')
  assertIncludes(server, 'name: cfg.displayName ?? cfg.incubatorTitle', 'hydrated incubators should expose the display title to the UI')
}

function testNewestFailedRowStaysOpenBelowCompletedRun() {
  const displayRuns = [
    { num: 3, date: '2026-07-04', type: 'MUTATE', 'What I changed': 'recovered', signature: 'ok-3' },
    { num: 2, date: '2026-07-04', type: 'FAILED', Failure: '[run failed - exit 127]', detail: 'codex not found', signature: 'failed-2' },
    { num: 1, date: '2026-07-04', type: 'RESEARCH', 'What I found': 'baseline', signature: 'ok-1' },
  ]
  const key = newestFailedRunKey(displayRuns, 'core')
  assert.equal(key, runHistoryKey('core', displayRuns[1], 1))
}

function testRecoveredOldFailuresStopBeingPinned() {
  const unresolvedRuns = [
    { num: 1, date: '2026-07-04', type: 'FAILED', Failure: 'claude binary: claude not found in PATH', signature: 'failed-1' },
  ]
  const unresolvedPinned = runsWithPinnedLatestFailure(unresolvedRuns, 10)
  assert.equal(unresolvedPinned.length, 1, 'a current unresolved failure should stay visible')
  assert.equal(unresolvedPinned[0].type, 'FAILED')

  const recoveredRuns = [
    { num: 1, date: '2026-07-04', type: 'FAILED', Failure: 'old usage-limit failure', signature: 'failed-1' },
    ...Array.from({ length: 12 }, (_, i) => ({
      num: i + 2,
      date: '2026-08-19',
      type: 'MUTATE',
      'Quality gate': i === 11 ? 'PASS' : 'NEEDS-EVIDENCE',
      'What I changed': `completed run ${i + 2}`,
      signature: `ok-${i + 2}`,
    })),
  ]

  const recovered = runsWithPinnedLatestFailure(recoveredRuns, 10)
  assert.equal(recovered.length, 10, 'recovered old failures should not be pinned above recent history')
  assert.ok(!recovered.some(run => run.type === 'FAILED'), 'old failure should drop out once later runs recovered')
  assert.equal(recovered.at(-1).num, 13)


  const server = serverSource()
  assertIncludes(server, 'runsWithPinnedLatestFailure(runs, 10)', 'host run API should use filtered failure pinning through cached runs')
  assertIncludes(server, 'runsWithPinnedLatestFailure(runs, 10)', 'project run APIs should use filtered failure pinning through cached runs')
}

function testFormalParagraphRunsKeepReadableSummary() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 7 — 2026-07-04 — mutate',
    '',
    'Tightened the relay setup so the new incubator shows why Claude cannot launch.',
    '',
    'The runner now surfaces missing script and model state instead of leaving history blank.',
    '',
    '## Run 8 — 2026-07-04 — RESEARCH',
    '',
    '**What I found:** Fielded summaries still win when they exist.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].type, 'MUTATE')
  assert.equal(
    runs[0]['What I changed'],
    'Tightened the relay setup so the new incubator shows why Claude cannot launch.',
    'paragraph-only formal runs should not collapse to a generic stdout summary'
  )
  assert.equal(runs[1]['What I found'], 'Fielded summaries still win when they exist.')
  assert.ok(!runs[0].signature.includes('stdout captured with no summary'), 'paragraph summaries should feed run signatures')
}

function testClaudeNoSummaryRowsShowOutputExcerpt() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 12 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Claude completed but did not append a run summary.',
    '**Output excerpt:** Built the missing relay switch diagnostics and wrote the trust fixture.',
    '**Output:** Full stdout saved to /tmp/stdout/claude-run-12.log',
    '**Next move:** Keep the next run focused on selected incubator history.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(
    runHistorySummary(runs[0]),
    'Built the missing relay switch diagnostics and wrote the trust fixture.',
    'Claude no-summary rows should show useful stdout instead of the placeholder'
  )
  assertIncludes(runs[0].signature, 'Built the missing relay switch diagnostics', 'stdout excerpt should feed run signatures')
}

function testNoSummaryRowsPreferStdoutOverGenericDone() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 21 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Codex completed but did not append a run summary.',
    '**Output:** Full stdout saved to /tmp/stdout/codex-run-21.log',
    '**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(
    runHistorySummary(runs[0]),
    'Codex completed but did not append a run summary.',
    'path-only no-summary rows should not use raw stdout paths as the primary summary'
  )
  assertIncludes(
    runOutputDetail(runs[0]),
    'Full stdout saved to /tmp/stdout/codex-run-21.log',
    'expanded output detail should still expose the saved stdout location'
  )
}

function testQualityGateFieldsDriveStatusAndHistory() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 22 - 2026-07-04 - MUTATE',
    '',
    '**Acceptance check:** Main launcher screen renders and feedback is visible.',
    '**What I changed:** Added the quality state strip.',
    '**Evidence:** npm test and manual check of /api/incubators.',
    '**Quality gate:** NEEDS-EVIDENCE',
    '**Quality rating:** 2.5/5',
    '**Evidence confidence:** 3/5',
    '**Risk / regression:** No browser screenshot attached.',
    '**Next move:** Add screenshot smoke coverage.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]['Quality gate'], 'NEEDS-EVIDENCE')
  const state = qualityStateFromRun(runs[0], true)
  assert.equal(state.lastRunnerStatus, 'ok')
  assert.equal(state.lastRunStatus, 'needs-evidence')
  assert.equal(state.lastQualityGate, 'NEEDS-EVIDENCE')
  assert.equal(state.lastQualityRating, 2.5)
  assert.equal(state.lastEvidenceConfidence, 3)
  assertIncludes(runOutputDetail(runs[0]), 'Acceptance check: Main launcher screen renders', 'quality rows should expose acceptance detail')
  assertIncludes(runOutputDetail(runs[0]), 'Quality gate: NEEDS-EVIDENCE', 'quality rows should expose the gate')

  const passState = qualityStateFromRun({ type: 'MUTATE', 'Quality gate': 'PASS', 'Quality rating': '4/5', 'Evidence confidence': '4/5' }, true)
  assert.equal(passState.lastRunStatus, 'ok')
  assert.equal(passState.lastQualityGate, 'PASS')

  const missingState = qualityStateFromRun({ type: 'MUTATE', 'What I changed': 'changed without evidence' }, true)
  assert.equal(missingState.lastRunStatus, 'needs-evidence')
  assert.equal(missingState.lastQualityGate, 'NEEDS-EVIDENCE')

  const failedState = qualityStateFromRun({ type: 'FAILED', Failure: 'runner exploded' }, false)
  assert.equal(failedState.lastRunStatus, 'failed')
  assert.equal(failedState.lastQualityGate, 'FAIL')
}

function testFormalRowsHydrateSavedStdoutFile() {
  const dir = tempDir('formal-stdout-file')
  const stdoutFile = join(dir, 'stdout', 'claude-run-18.log')
  fs.mkdirSync(dirname(stdoutFile), { recursive: true })
  fs.writeFileSync(stdoutFile, [
    'Prepared the new incubator relay.',
    'Switched the project status to Claude.',
    'Wrote a focused trust check.',
    'Finished without appending a markdown summary.',
    '',
  ].join('\n'))
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 18 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Claude completed but did not append a run summary.',
    `**Output:** Full stdout saved to ${stdoutFile}`,
    '**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content, { stdoutRoots: [join(dir, 'stdout')] })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'MUTATE')
  assert.equal(
    runHistorySummary(runs[0]),
    'Prepared the new incubator relay. Switched the project status to Claude. Wrote a focused trust check. Finished without appending a markdown summary.',
    'formal no-summary rows should read the saved stdout file instead of showing only the file path'
  )
  assertIncludes(runs[0]['Stdout tail'], 'Switched the project status to Claude.', 'formal rows should retain saved stdout detail')
}

function testFormalRowsHydrateStdoutPathFromExcerpt() {
  const dir = tempDir('formal-stdout-excerpt-path')
  const stdoutFile = join(dir, 'stdout', 'claude-run-20.log')
  fs.mkdirSync(dirname(stdoutFile), { recursive: true })
  fs.writeFileSync(stdoutFile, [
    'Selected Claude relay with repaired Sonnet model.',
    'Ran the incubator launcher and captured useful stdout.',
    '',
  ].join('\n'))
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 20 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Claude completed but did not append a run summary.',
    `**Output excerpt:** Full stdout saved to ${stdoutFile}`,
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content, { stdoutRoots: [join(dir, 'stdout')] })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'MUTATE')
  assert.equal(
    runHistorySummary(runs[0]),
    'Selected Claude relay with repaired Sonnet model. Ran the incubator launcher and captured useful stdout.',
    'stdout path-only excerpts should hydrate into real run history text'
  )
  assertIncludes(runs[0]['Stdout tail'], 'captured useful stdout', 'expanded detail should expose the saved stdout content')
}

function testFormalRowsFailFromSavedStdoutFile() {
  const dir = tempDir('formal-stdout-failure')
  const stdoutFile = join(dir, 'stdout', 'claude-run-19.log')
  fs.mkdirSync(dirname(stdoutFile), { recursive: true })
  fs.writeFileSync(stdoutFile, [
    'Claude relay starting...',
    'API Error: model fable not found',
    'The process exited before writing a summary.',
    '',
  ].join('\n'))
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 19 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Claude completed but did not append a run summary.',
    `**Output:** Full stdout saved to ${stdoutFile}`,
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content, { stdoutRoots: [join(dir, 'stdout')] })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, 'API Error: model fable not found', 'saved stdout failures should mark the formal row FAILED')
  assertIncludes(runFailureDetail(runs[0]), 'The process exited before writing a summary.', 'expanded failure detail should include saved stdout tail')
}

function testRunLogCannotHydrateArbitraryStdoutPath() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 77 - 2026-07-04 - MUTATE',
    '',
    '**Done:** Codex completed but did not append a run summary.',
    '**Output:** Full stdout saved to /etc/hostname',
    '**Next move:** Keep stdout hydration inside trusted transcript roots.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content, { stdoutRoots: ['/tmp/pi-pulse-safe-stdout-only'] })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'MUTATE')
  assert.equal(runs[0]['Stdout tail'], undefined, 'untrusted stdout paths must not be read into run history')
  assert.equal(
    runHistorySummary(runs[0]),
    'Codex completed but did not append a run summary.',
    'untrusted stdout paths should not replace the run summary with local file contents'
  )
}

function testProjectSummaryBeatsSyntheticNoSummaryDuplicate() {
  const content = [
    '# Run Log',
    '',
    '## 2026-07-04 - Run 5 create',
    '',
    '- Preserved the latest steering note from `reports/USER_FEEDBACK.md`.',
    '- Added a personal scent-memory input and verified `npm test`.',
    '',
    '## Run 5 - 2026-07-04 - CREATE',
    '',
    '**Done:** Codex completed but did not append a run summary.',
    '**Output:** Full stdout saved to /tmp/stdout/codex-run-5.log',
    '**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1, 'synthetic duplicate should not create a second history row')
  assert.equal(runs[0].num, 5)
  assert.equal(runs[0].date, '2026-07-04')
  assert.equal(runs[0].type, 'CREATE')
  assertIncludes(
    runHistorySummary(runs[0]),
    'Preserved the latest steering note',
    'history should show the project-authored summary instead of the synthetic no-summary block'
  )
  assert.ok(!runHistorySummary(runs[0]).includes('Codex completed but did not append'), 'generic no-summary text should be hidden when a real summary exists')
}

function testFormalFailedRowsExposeAllDiagnostics() {
  const content = [
    '# Child Project Run Log',
    '',
    '## Run 13 - 2026-07-04 - FAILED',
    '',
    '**Failure:** [run failed - claude exited 1] API Error: model fable not found',
    '**Output excerpt:** API Error: model fable not found',
    '**Output:** Full stdout saved to /tmp/stdout/claude-run-13.log',
    '**Next move:** Switch to claude-sonnet-4-20250514 and rerun preflight.',
    '',
  ].join('\n')

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].detail, 'Output: Full stdout saved to /tmp/stdout/claude-run-13.log', 'formal failed rows should keep stdout file detail')
  assertIncludes(runFailureDetail(runs[0]), 'Next move: Switch to claude-sonnet-4-20250514', 'expanded failed rows should show next diagnostic action')
}

function testClaudeRunnerSwitchWarnsFromLaunchPreflight() {
  const server = serverSource()
  assertIncludes(server, "const launchBlocked = runner === 'claude' && preflight && !preflight.ok", 'Claude switch responses should check launch preflight, not only setup')
  assertIncludes(server, 'Claude relay selected but launch preflight blocked:', 'Claude switch warning should name launch preflight blocks')
  assertIncludes(server, 'preflightFailureDetail(preflight)', 'Claude switch warning should include concrete failed checks')
  assertIncludes(server, 'repaired: result.repaired ?? false', 'runner switch responses should disclose legacy status repair')
  assertIncludes(server, 'const hydratedSlot = hydrateIncubator(slot)\n  const warning = launchBlocked', 'Claude switch responses should hydrate the slot before reporting')
  assert.ok(!server.includes('runner-switch-preflight'), 'a runner switch is configuration, not a run: it must not write run history')
}


function testAppEvidenceHarnessWritesSummaryArtifact() {
  const dir = tempDir('app-evidence')
  fs.writeFileSync(join(dir, 'index.html'), '<!doctype html><main><h1>Hello app</h1><button>Start</button></main>')
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'app-evidence.mjs'), '--repo', dir, '--run', '7', '--type', 'mutate'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const summaryPath = join(dir, 'reports', 'evidence', 'run-7', 'summary.json')
  const summaryMdPath = join(dir, 'reports', 'evidence', 'run-7', 'summary.md')
  assert.ok(fs.existsSync(summaryPath), 'app evidence should write summary.json')
  assert.ok(fs.existsSync(summaryMdPath), 'app evidence should write summary.md')
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  assert.equal(summary.appType, 'static-web')
  assert.ok(['PASS', 'NEEDS-EVIDENCE', 'FAIL'].includes(summary.gate), 'app evidence gate should be normalized')
  assert.ok(summary.primaryAction && typeof summary.primaryAction.available === 'boolean', 'app evidence should include a primary-action receipt')
  assertIncludes(fs.readFileSync(summaryMdPath, 'utf8'), '**App evidence gate:**', 'markdown summary should expose the app evidence gate')
  assertIncludes(fs.readFileSync(summaryMdPath, 'utf8'), '**Primary action:**', 'markdown summary should expose the primary-action check')
}


function testBrowserEvidenceSeparatesObservationFromProbeFailures() {
  const checkHtml = html => {
    const dir = tempDir('browser-observation')
    fs.writeFileSync(join(dir, 'index.html'), html)
    const checks = runChecks({ repo: dir, label: 'test', appEvidenceScript: join(root, 'scripts', 'app-evidence.mjs') })
    const summary = JSON.parse(fs.readFileSync(join(dir, 'reports/evidence/run-test/summary.json'), 'utf8'))
    return { checks, summary }
  }
  const shell = '<!doctype html><style>.skip {position:absolute;top:-100px}button {padding:15px}</style><a class="skip" href="#main">Skip to content</a><nav><a href="./">Home</a><button>Current section</button></nav><main id="main"><h1>Equipment inventory</h1><button onclick="document.querySelector(\'output\').textContent=\'Equipment editor open\'">Add equipment</button><output>No equipment yet</output></main>'
  const initial = checkHtml(shell)
  if (initial.summary.evidenceMode === 'unavailable') {
    assert.equal(initial.summary.blank, null, 'missing browser tooling is unknown, never blank or confirmed nonblank')
    assert.equal(checksAllowCompletion(initial.checks), false)
    return
  }
  assert.equal(initial.summary.gate, 'PASS')
  assert.equal(initial.summary.primaryAction.label, 'Add equipment', 'offscreen accessibility links must not be selected')
  assert.equal(initial.summary.blank, false)
  assert.equal(initial.summary.pageState.desktop.bodyHash, initial.summary.pageState.mobile.bodyHash, 'phone opens the initial state, not the editor left by the desktop action')
  assert.notEqual(initial.summary.afterActionState.bodyHash, initial.summary.pageState.mobile.bodyHash)
  assert.equal(checksAllowCompletion(initial.checks), true)

  const timeout = checkHtml(shell + '<script>window.__PI_PULSE_APP__={primaryAction:".skip"}</script>')
  assert.equal(timeout.summary.blank, false, 'an explicit action timeout must preserve actual render observations')
  assert.equal(timeout.summary.gate, 'NEEDS-EVIDENCE')
  assert.equal(timeout.summary.primaryAction.checked, false)
  assert.match(timeout.summary.primaryAction.executionResult.error, /Timeout/)
  assert.ok(timeout.summary.desktopScreenshot && timeout.summary.mobileScreenshot, 'partial artifacts survive a probe failure')
  assert.deepEqual(breakage(null, timeout.checks), [], 'a failed probe alone must not roll back working code')
  assert.equal(checksAllowCompletion(timeout.checks), false, 'incomplete inspection cannot certify a milestone')
  assert.match(checksLine(timeout.checks), /inspection incomplete/)

  const thrown = checkHtml(shell + '<script>window.__PI_PULSE_APP__={primaryAction(){throw Error("action failed")}}</script>')
  assert.equal(thrown.summary.blank, false)
  assert.equal(thrown.summary.inspectionComplete, false)
  assert.equal(checksAllowCompletion(thrown.checks), false)
  const blank = checkHtml('<!doctype html><title>Empty app</title>')
  assert.equal(blank.summary.blank, true)
  assert.equal(blank.summary.gate, 'FAIL')
  assert.deepEqual(breakage(null, blank.checks), ['the app now renders a blank page'])
  const errors = checkHtml(shell + '<script>throw Error("real app failure")</script>')
  assert.equal(errors.summary.gate, 'FAIL')
  assert.ok(errors.checks.app.pageErrors > 0)
  assert.ok(breakage(null, errors.checks).some(reason => reason.includes('uncaught page error')))
  const crashAfterClick = checkHtml(shell.replace("document.querySelector('output').textContent='Equipment editor open'", "document.body.innerHTML=''"))
  assert.equal(crashAfterClick.summary.blank, true, 'an action that really blanks the app is still detected')
}

function testAppEvidenceSemanticContractCanBeTopTierEligible() {
  const dir = tempDir('semantic-app-evidence')
  fs.writeFileSync(join(dir, 'index.html'), `<!doctype html>
<main>
  <h1>Semantic evidence app</h1>
  <button data-primary-action onclick="document.querySelector('[data-app-state]').textContent = 'started'; document.querySelector('[data-app-state]').setAttribute('data-app-state', 'started'); localStorage.setItem('semantic-evidence-picks', JSON.stringify(['picked']))">Start</button>
  <output data-app-state="idle">idle</output>
</main>
<script>
window.__PI_PULSE_APP__ = {
  version: 1,
  name: 'Semantic Evidence App',
  type: 'web-app',
  primaryAction: {
    selector: '[data-primary-action]',
    label: 'Start',
    expect: { selector: '[data-app-state]', textIncludes: 'started' }
  },
  reset() { document.querySelector('[data-app-state]').textContent = 'idle' },
  snapshot() { return { state: document.querySelector('[data-app-state]').textContent } }
}
</script>`)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'app-evidence.mjs'), '--repo', dir, '--run', '8', '--type', 'mutate'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const summary = JSON.parse(fs.readFileSync(join(dir, 'reports', 'evidence', 'run-8', 'summary.json'), 'utf8'))
  if (summary.evidenceMode === 'unavailable') {
    assert.equal(summary.gate, 'NEEDS-EVIDENCE')
    assert.ok(summary.notes.some(note => /evidence infrastructure failure|Browser evidence unavailable/.test(note)), 'unavailable browser tooling should be classified as infrastructure evidence, not product failure')
    return
  }
  assert.equal(summary.gate, 'PASS')
  assert.equal(summary.evidenceMode, 'semantic')
  assert.equal(summary.topTierEligible, true)
  assert.equal(summary.semanticContract.present, true)
  assert.equal(summary.primaryAction.source, 'semantic-selector')
  assert.equal(summary.semanticSuccess.passed, true)
  assert.equal(summary.semanticSuccess.source, 'successContract')
  assert.ok(fs.existsSync(join(dir, 'reports', 'evidence', 'run-8', 'semantic-contract.json')), 'semantic contract artifact should be written')
  assert.ok(fs.existsSync(join(dir, 'reports', 'evidence', 'run-8', 'semantic-snapshots.json')), 'semantic snapshots artifact should be written')
}

// The core lab loop (run-lab.sh) still runs on prompts/*.md and the quality
// contract; incubators are judged by lab checks and an independent review.
function testCoreLabQualityContractIsWired() {
  const server = serverSource()
  const mutatePrompt = fs.readFileSync(join(root, '..', '..', 'prompts', 'mutate.md'), 'utf8')
  assertIncludes(mutatePrompt, 'INCUBATOR_QUALITY.md', 'core prompts should require the quality contract')
  assertIncludes(mutatePrompt, '**Quality gate:** PASS | NEEDS-EVIDENCE | FAIL', 'core prompts should require an explicit quality gate')
  assertIncludes(mutatePrompt, 'Negative feedback recovery', 'core prompts should force recovery mode after bad user feedback')
  assertIncludes(server, 'qualityStateFromRun(latest', 'core status sync should derive cached status from latest quality fields')
}

function testTrustHarnessRunsBeforeBuild() {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts?.['test:trust'] || '',
    /node scripts\/trust-fixtures\.mjs\s*&&\s*node scripts\/trust-ui\.mjs\s*&&\s*node scripts\/trust-smoke\.mjs/,
    'npm run test:trust must run source fixtures, rendered UI contracts, and live HTTP smoke'
  )
  assert.match(
    pkg.scripts?.build || '',
    /npm run test:trust\s*&&\s*vite build/,
    'npm run build must run trust fixtures before producing a bundle'
  )
}

function testPublicWriteSafetyAndLoopFusesAreWired() {
  const server = serverSource()
  const appEvidence = fs.readFileSync(join(root, 'scripts', 'app-evidence.mjs'), 'utf8')
  const runner = runnerSource()
  const viteConfig = fs.readFileSync(join(root, 'vite.config.js'), 'utf8')
  const readme = fs.readFileSync(join(root, '..', '..', 'README.md'), 'utf8')
  const generateBrief = fs.readFileSync(join(root, '..', '..', 'generate-brief.sh'), 'utf8')
  const saveRun = fs.readFileSync(join(root, '..', '..', 'save-run.sh'), 'utf8')

  assertIncludes(server, "const HOST = process.env.PI_PULSE_HOST || process.env.HOST || '127.0.0.1'", 'Pi Pulse should bind loopback by default')
  assertIncludes(server, "app.use('/api', rejectGeneratedAppControlWrite, requireTrustedWrite)", 'API writes should reject generated app origins and pass through a write guard')
  assertIncludes(server, "code: 'WRITE_AUTH_REQUIRED'", 'write guard should return a machine-readable auth error')
  assertIncludes(server, 'PI_PULSE_ADMIN_TOKEN', 'write guard should support a shared admin token')
  assertIncludes(server, 'function isProxiedWrite', 'write guard should fail closed for Cloudflare/proxy writes without identity')
  assertIncludes(server, '!isProxiedWrite(req)', 'local direct writes may stay convenient while proxied writes require identity')
  assertIncludes(server, 'TRUST_CLOUDFLARE_ACCESS && hasCloudflareAccessIdentity(req)', 'Cloudflare Access headers should only be trusted when explicitly enabled')
  assertIncludes(readme, 'Cloudflare Access', 'README should state the Cloudflare Access requirement for public tunnel exposure')
  assertIncludes(server, "execFileText(MEMPALACE_BIN, args", 'MemPalace queries should use execFile arguments, not shell strings')
  assertIncludes(server, '[memory unavailable:', 'MemPalace query failures should be visible instead of identical to no memory')
  assert.ok(!server.includes('mempalace search ${JSON.stringify(query)}'), 'MemPalace query should not interpolate project text into a shell command')
  assertIncludes(generateBrief, 'mktemp "$BRIEF_PATH.tmp', 'memory brief should be written atomically')
  assertIncludes(generateBrief, 'mv "$TMP" "$BRIEF_PATH"', 'memory brief should atomically replace stale briefs')
  assertIncludes(generateBrief, 'Current-state authority', 'memory brief should demote MemPalace below status files and recent evidence')
  assertIncludes(generateBrief, 'memory unavailable', 'memory brief should disclose MemPalace failures instead of reusing stale context')
  assertIncludes(saveRun, 'SAVE_RUN_SKIP_MINE', 'run saving should support backfill without mining every historical run')
  assertIncludes(saveRun, 'SAVE_RUN_MINE_TIMEOUT_SECONDS', 'run saving should cap MemPalace mining so finalization cannot hang forever')
  assertIncludes(saveRun, 'index-health.json', 'run saving should publish memory index health')
  assertIncludes(saveRun, 'formal_matches[-1]', 'run saving should use the latest duplicate formal run section')
  assertIncludes(saveRun, 'stdout from run {n}', 'stdout fallback should only use the requested run number')
  assert.ok(!saveRun.includes('mine "$LAB_DIR/memory/" 2>/dev/null || true'), 'MemPalace mining failures should not be suppressed with || true')
  assertIncludes(server, 'codexBypass: false', 'new incubators should not default to unsandboxed Codex bypass')
  assertIncludes(server, 'status.codexBypass = false', 'runner switching should not re-enable Codex bypass by default')
  assertIncludes(server, 'claudeBypass: false', 'new incubators should not default to Claude bypass')
  assertIncludes(server, 'GLOBAL_RUN_LOCK_ACTIVE', 'runner launches should enforce a persistent global run lock')
  assertIncludes(server, "script: join(LAB_ROOT, 'run-lab.sh')", 'core Claude runs should launch the repo-owned run-lab.sh')
  assertIncludes(server, 'PERSISTED_BYPASS_DISABLED', 'persisted bypass flags should be cleared and recorded')
  assertIncludes(server, 'generatedAppSecurityHeaders', 'generated app routes should receive restrictive security headers')
  assertIncludes(server, 'APP_CONTROL_API_FORBIDDEN', 'generated app referers should not call control-plane writes')
  assertIncludes(server, 'assertTrustedStatusPath', 'status files should be constrained to the trusted project root')
  assertIncludes(server, 'function clampScheduleInterval', 'schedule intervals should be clamped')
  assertIncludes(server, 'function parsedRunsForLog', 'RUN_LOG parsing should be cached by file metadata')
  assertIncludes(server, 'setTimeout(notifyRunLogChanged, 500)', 'RUN_LOG file watch should be debounced')
  assertIncludes(appEvidence, "summary.evidenceMode = 'unavailable'", 'browser infrastructure failures should be separated from product failures')
  assertIncludes(appEvidence, "summary.gate = 'NEEDS-EVIDENCE'", 'browser infrastructure failures should be needs-evidence, not fail')
  assertIncludes(runner, "process.env.PI_PULSE_SCHEDULED_RUN === '1'", 'scheduled incubator runs should ignore bypass mode')
  assert.ok(!runner.includes('find "$HOME/.codex/sessions"'), 'Incubator runner should not delete global Codex session history')
  assertIncludes(viteConfig, "target: 'http://127.0.0.1:8089'", 'Vite dev proxy should point at the actual Pi Pulse server')
}

function testStaleSourceMutationsAreWriteGated() {
  const server = serverSource()
  assertIncludes(server, 'function requireFreshSource(req, res, next)', 'server should centralize stale-source write gating')
  assertIncludes(server, "code: 'STALE_SERVICE_SOURCE'", 'stale-source write blocks should return a machine-readable code')
  assertIncludes(server, 'PI_PULSE_SOURCE_HEALTH_FILES', 'smoke tests should be able to add a temporary source health probe')
  for (const route of [
    "app.post('/api/run', requireFreshSource",
    "app.post('/api/lab/schedule', requireFreshSource",
    "app.post('/api/incubators/:id/run', requireFreshSource",
    "app.post('/api/incubators/:id/schedule', requireFreshSource",
    "app.post('/api/incubators/:id/runner', requireFreshSource",
    "app.post('/api/incubators/create', requireFreshSource",
    "app.post('/api/incubators', requireFreshSource",
    "app.delete('/api/incubators/:id', requireFreshSource",
  ]) {
    assertIncludes(server, route, `${route} should refuse stale-source writes before changing runner state`)
  }
  assertIncludes(server, "app.post('/api/reboot', (req, res) =>", 'reboot should stay available when source is stale')
  assertIncludes(server, "app.post('/api/restart', (req, res) =>", 'service restart should stay available when stale source blocks runner switching')
  assertIncludes(server, 'process.exit(0)', 'service restart should exit the Pi Pulse process for supervisor restart')
}

function testDependencyErrorPackageNamesDoNotCreateFailedRows() {
  const dir = tempDir('dependency-error-names')
  const stdoutPath = join(dir, 'codex-run-15.log')
  fs.writeFileSync(stdoutPath, [
    'node_modules/express/index.js',
    'node_modules/es-errors/type.d.ts',
    'node_modules/http-errors/index.js',
    '',
    'Implemented Run 15 mutation: generation now fails closed before publishing weak artifacts.',
    'Verification passed:',
    'npm test',
  ].join('\n'))

  const log = [
    '## Run 15 - 2026-07-05 - MUTATE',
    '',
    '**Done:** Codex completed but did not append a run summary.',
    '**Output:** Full stdout saved to ' + stdoutPath,
    '**Next move:** Ask the next run to append a concise summary to reports/RUN_LOG.md.',
  ].join('\n')

  const runs = parseRunsFromLog(log, { stdoutRoots: [dir] })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'MUTATE')
  assert.ok(!runs[0].Failure, 'dependency package names must not become failure summaries')
  assertIncludes(runs[0]['Output excerpt'], 'Implemented Run 15 mutation', 'stdout excerpt should prefer useful transcript lines over dependency inventory')
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content)
  fs.chmodSync(filePath, 0o755)
}

// A throwaway incubator with fake agents. The fake records its argv per role,
// acts on FAKE_MODE when building (good | improve | break | idle | silent | fail),
// appends the session entry the prompt asks for, and answers the reviewer prompt
// with FAKE_REVIEW (a verdict block, or 'garbage').
function runnerFixture(name, { status = {}, repoParent = null } = {}) {
  const dir = tempDir(name)
  const repo = join(repoParent || dir, 'proj')
  const bin = join(dir, 'bin')
  fs.mkdirSync(join(repo, 'reports'), { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(join(repo, 'reports', 'RUN_LOG.md'), '# Run Log\n\n## Run 3 - 2026-01-01 - MUTATE\n\n**What I changed:** older work\n')
  fs.writeFileSync(join(repo, 'reports', 'USER_FEEDBACK.md'), '# User Feedback / Steering Notes\n\n## Seed\n\nA pocket harbor raid game.\n')
  fs.writeFileSync(join(repo, 'index.html'), '<!doctype html><title>harbor</title><h1>Harbor v0</h1>\n')
  // Retired steering inputs: present on disk, and they must not reach any prompt.
  fs.writeFileSync(join(dir, 'BENCHMARK_SUITE.md'), '# Benchmarks\n- benchmark marker\n')
  fs.writeFileSync(join(dir, 'INCUBATOR_LEARNINGS.md'), '# Incubator Learnings\n\n**Lesson:** receipt marker\n')
  const statusPath = join(dir, 'status.json')
  fs.writeFileSync(statusPath, JSON.stringify({
    project: 'proj',
    displayName: 'Harbor',
    repo,
    runLog: join(repo, 'reports', 'RUN_LOG.md'),
    feedbackPath: join(repo, 'reports', 'USER_FEEDBACK.md'),
    runCount: 3,
    runner: 'codex',
    incubatorRole: 'signal-feeder',
    claudeModel: 'fable',
    ...status,
  }, null, 2))
  const fake = `#!/usr/bin/env bash
PROMPT=""
for a in "$@"; do case "$a" in *"You are "*) PROMPT="$a" ;; esac; done
if printf '%s' "$PROMPT" | grep -q '^You are an independent reviewer'; then
  printf '%s\\n' "$@" > "$FAKE_ARGS_OUT.review"
  if [ "\${FAKE_REVIEW:-no}" = garbage ]; then echo "I looked around."; exit 0; fi
  printf 'Checked it.\\n\\n**Verdict:** better — clearer\\n**Rating:** 3.5/5 — solid start\\n**Done:** %s — see milestone\\n**Top problems:**\\n' "\${FAKE_REVIEW:-no}"
  if [ "\${FAKE_PROBLEMS:-some}" = none ]; then printf 'none\\n'; else printf '1. No sound on hits\\n2. Buttons too small\\n'; fi
  printf '**Cut:** nothing\\n'
  exit "\${FAKE_REVIEW_EXIT:-0}"
fi
printf '%s\\n' "$@" > "$FAKE_ARGS_OUT"
HEADER=$(printf '%s\\n' "$PROMPT" | grep -m1 -E '^## Run [0-9]+ — ')
case "\${FAKE_MODE:-good}" in
  good) printf '# Harbor\\n## What it is\\nA harbor raid game for phones.\\n## Done means\\n- [ ] A raid finishes in five minutes\\n' > BRIEF.md
        printf '<!doctype html><title>harbor</title><h1>Harbor v1</h1>\\n' > index.html
        printf '#!/usr/bin/env bash\\ngrep -q Harbor index.html\\n' > check.sh ;;
  improve) printf '<!doctype html><title>harbor</title><h1>Harbor v%s</h1>\\n' "$RANDOM" > index.html ;;
  milestone) printf '# Next milestone\\n## Goal\\nA harbor worth returning to.\\n## Done means\\n- [ ] Progress survives a reload\\n' > MILESTONE.md
        printf '<!doctype html><title>harbor</title><h1>Harbor returns</h1>\\n' > index.html ;;
  break) printf '<!doctype html><title>oops</title>\\n' > index.html; echo junk > stray.txt ;;
  fail) echo half-done > index.html; echo "fixture api error"; exit 3 ;;
esac
if [ "\${FAKE_MODE:-good}" != silent ]; then
  printf '\\n%s\\n\\n**Goal:** a raid a new player can finish\\n**What changed:** %s pass on the harbor\\n**Verified:** opened index.html\\n**Next:** add sound\\n' "$HEADER" "\${FAKE_MODE:-good}" >> reports/RUN_LOG.md
fi
echo "fake agent \${FAKE_MODE:-good}"
`
  writeExecutable(join(bin, 'codex'), fake)
  writeExecutable(join(bin, 'claude'), fake)
  return {
    dir,
    repo,
    bin,
    statusPath,
    runLog: join(repo, 'reports', 'RUN_LOG.md'),
    argsPath: join(dir, 'args'),
    status: () => JSON.parse(fs.readFileSync(statusPath, 'utf8')),
    prompt: () => fs.readFileSync(join(dir, 'args'), 'utf8'),
    git: (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  }
}

function runRunner(script, args, env) {
  const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PI_PULSE_AGENT: '', CODEX_BYPASS: '', CLAUDE_BYPASS: '', PI_PULSE_SCHEDULED_RUN: '', CLAUDE_MODEL: '', PI_PULSE_DEFAULT_CLAUDE_MODEL: '', APP_EVIDENCE_SCRIPT: '/nonexistent/app-evidence.mjs', ...env } })
  assert.equal(result.status, 0, `${script} should exit cleanly: ${result.stderr}`)
  return result
}

function session(fx, env = {}) {
  return runRunner(join(root, 'scripts', 'run-incubator.sh'), [fx.statusPath], {
    LAB_DIR: fx.dir, PI_PULSE_AGENT: 'codex', CODEX_BIN: join(fx.bin, 'codex'), CLAUDE_BIN: join(fx.bin, 'claude'), FAKE_ARGS_OUT: fx.argsPath, ...env,
  })
}

// One agent owns a session end to end; the lab commits what it built and a
// fresh read-only agent reviews it. Codex and Claude get the same contract.
function testSessionsBuildKeepAndReviewWithEitherAgent() {
  const fx = runnerFixture('sessions')
  const codexShim = join(root, '..', '..', 'scripts', 'run-codex-incubator.sh')
  const claudeShim = join(root, 'scripts', 'run-claude-incubator.sh')
  const base = { LAB_DIR: fx.dir, CODEX_BIN: join(fx.bin, 'codex'), CLAUDE_BIN: join(fx.bin, 'claude'), FAKE_ARGS_OUT: fx.argsPath }

  // Scheduled runs must never inherit the service's bypass flag.
  runRunner(codexShim, [fx.statusPath], { ...base, CODEX_BYPASS: '1', PI_PULSE_SCHEDULED_RUN: '1' })
  const codexArgs = fx.prompt()
  assertIncludes(codexArgs, 'exec\n-C\n' + fx.repo + '\n--color\nnever', 'Codex should run in the project workspace')
  assert.ok(!codexArgs.includes('--add-dir'), 'an incubator sandbox must not get write access to the lab control plane')
  assertIncludes(codexArgs, '--sandbox\nworkspace-write', 'scheduled Codex runs should stay sandboxed')
  assertIncludes(codexArgs, '-c\nmodel_reasoning_effort="high"', 'the builder pins effort instead of inheriting a personal CLI default')
  assert.ok(!codexArgs.includes('--dangerously-bypass-approvals-and-sandbox'), 'scheduled Codex runs should ignore CODEX_BYPASS')
  assertIncludes(codexArgs, 'You are the builder of "Harbor"', 'the session prompt names what the agent owns')
  assertIncludes(codexArgs, 'A pocket harbor raid game.', 'the idea reaches the builder verbatim')
  assertIncludes(codexArgs, 'Stage: Shaping. Turn the idea into a product.', 'a project without a brief starts by shaping')
  assertIncludes(codexArgs, 'There is no BRIEF.md yet', 'the builder is told to write the brief first')
  assertIncludes(codexArgs, 'Nobody is watching this session and nobody can be asked anything', 'sessions are unattended')
  assertIncludes(codexArgs, '## Run 4 — ', 'run numbers continue from the highest RUN_LOG/status count')
  for (const retired of ['INCUBATOR ROLE', 'benchmark marker', 'receipt marker', 'Needs human', 'Quality gate', 'Run type:']) {
    assert.ok(!codexArgs.includes(retired), `the session prompt must not carry ${retired}`)
  }

  let status = fx.status()
  assert.equal(status.runCount, 4)
  assert.equal(status.lastOutcome, 'kept')
  assert.equal(status.lastRunStatus, 'ok')
  assert.equal(status.lastGoodCommit, fx.git('rev-parse', 'HEAD'), 'the kept session is the new last good commit')
  assert.equal(status.lastChecks.check.state, 'pass', "the builder's check.sh ran and passed")
  assert.equal(status.stage, 'building', 'a kept shaping session with a brief moves the project to building')
  assert.equal(status.lastReview.verdict, 'better')
  assert.equal(status.lastReview.rating, 3.5)
  assert.deepEqual(status.lastReview.problems, ['No sound on hits', 'Buttons too small'])
  assert.equal(status.session, undefined, 'the session is closed out')
  assert.ok(!('lastQualityGate' in status) && !('lastNorthStar' in status), 'retired self-grades are dropped')
  const reviewArgs = fs.readFileSync(`${fx.argsPath}.review`, 'utf8')
  assertIncludes(reviewArgs, 'exec\n-C\n' + fx.repo + '\n--color\nnever\n--sandbox\nread-only', 'the reviewer cannot change the product')
  assertIncludes(reviewArgs, '-c\nmodel_reasoning_effort="high"', 'the reviewer gets the same explicit reasoning default')
  assertIncludes(fx.git('log', '--format=%an|%s'), 'Pi Pulse lab|Run 4 (SHAPE): good pass on the harbor', 'the lab commits the session under its own name')
  assertIncludes(fx.git('log', '--format=%an|%s'), 'Pi Pulse lab|Baseline: the project before autonomous sessions', 'a folder that was not a repo yet is adopted as the baseline')
  assertIncludes(fx.git('show', 'HEAD~1:index.html'), 'Harbor v0', 'existing work is committed as the baseline, never discarded')
  const log = fs.readFileSync(fx.runLog, 'utf8')
  assertIncludes(log, '**Checks:** ./check.sh pass', 'the lab records its checks in the session entry')
  assertIncludes(log, '**Outcome:** kept · ', 'the outcome is recorded in the session entry')
  assertIncludes(log, '**Review:** better · 3.5/5 · not done yet — No sound on hits', 'the review is recorded in the session entry')
  assertIncludes(fs.readFileSync(join(fx.repo, 'reports', 'REVIEW.md'), 'utf8'), '**Verdict:** better', 'the full review is kept for the next session')
  assertIncludes(fs.readFileSync(join(fx.repo, 'reports', 'RECENT_RUNS.md'), 'utf8'), '## Run 4', 'RECENT_RUNS.md is regenerated after the session')

  // Claude: same session contract; manual runs honor CLAUDE_BYPASS.
  runRunner(claudeShim, [fx.statusPath], { ...base, CLAUDE_BYPASS: '1', FAKE_MODE: 'improve' })
  const claudeArgs = fx.prompt().split('\n')
  assert.equal(claudeArgs[0], '-p')
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'fable', 'the fable alias is a user choice, not a stale pin')
  assert.equal(claudeArgs[claudeArgs.indexOf('--fallback-model') + 1], 'sonnet', 'an unavailable pinned model degrades to sonnet instead of failing the run')
  assert.ok(claudeArgs.includes('--dangerously-skip-permissions'), 'manual Claude runs honor CLAUDE_BYPASS')
  assert.ok(!claudeArgs.includes('--permission-mode'), 'bypass and an explicit permission mode are mutually exclusive')
  const claudePrompt = claudeArgs.join('\n')
  assertIncludes(claudePrompt, 'Stage: Building. Continue the current milestone', 'the next session builds toward the current milestone')
  assertIncludes(claudePrompt, 'Your brief is BRIEF.md: read it first.', 'the builder is pointed at its own brief')
  assertIncludes(claudePrompt, '1. No sound on hits', "the last review's top problem steers the next session")
  assert.ok(!claudePrompt.includes('BRIEF.md TEMPLATE'), 'the template is only for a project without a brief')
  const claudeReview = fs.readFileSync(`${fx.argsPath}.review`, 'utf8').split('\n')
  assert.equal(claudeReview[claudeReview.indexOf('--permission-mode') + 1], 'default', 'the Claude reviewer runs in the prompting mode, where headless edits are denied')
  assert.equal(claudeReview[claudeReview.indexOf('--allowedTools') + 1], 'Read,Glob,Grep', 'the Claude reviewer may only read')
  status = fx.status()
  assert.equal(status.runCount, 5)
  assert.equal(status.lastOutcome, 'kept')
  assert.equal(status.claudeModel, 'fable', 'Claude runs keep the selected alias')
  assert.equal(status.runner, 'codex', 'running through a relay does not rewrite the selected runner')

  // Autonomous Claude runs cannot answer permission prompts: without an explicit
  // mode every edit is denied and the run can never finish its own work.
  runRunner(claudeShim, [fx.statusPath], { ...base, CLAUDE_BYPASS: '1', PI_PULSE_SCHEDULED_RUN: '1', FAKE_MODE: 'idle' })
  const scheduledClaudeArgs = fx.prompt().split('\n')
  assert.ok(!scheduledClaudeArgs.includes('--dangerously-skip-permissions'), 'scheduled Claude runs ignore CLAUDE_BYPASS')
  assert.equal(scheduledClaudeArgs[scheduledClaudeArgs.indexOf('--permission-mode') + 1], 'auto', 'scheduled Claude runs use a non-prompting reviewed mode')
  fs.writeFileSync(fx.statusPath, JSON.stringify({ ...fx.status(), claudeModel: 'sonnet', claudePermissionMode: 'acceptEdits' }, null, 2))
  runRunner(claudeShim, [fx.statusPath], { ...base, FAKE_MODE: 'idle' })
  const pinnedModeArgs = fx.prompt().split('\n')
  assert.equal(pinnedModeArgs[pinnedModeArgs.indexOf('--permission-mode') + 1], 'acceptEdits', 'a per-slot claudePermissionMode reaches the CLI')
  assert.ok(!pinnedModeArgs.includes('--fallback-model'), 'sonnet needs no fallback to itself')
  status = fx.status()
  assert.equal(status.runCount, 7)
  assert.equal(status.lastOutcome, 'no-changes', 'a session that changed nothing is recorded as such, not as progress')

  // A failing agent: FAILED receipt, and its half-done edits are discarded.
  const head = fx.git('rev-parse', 'HEAD')
  runRunner(codexShim, [fx.statusPath], { ...base, FAKE_MODE: 'fail' })
  assertIncludes(fs.readFileSync(fx.runLog, 'utf8'), '**Failure:** [run failed - codex exited 3] fixture api error', 'agent failures write a FAILED receipt with the marker once and the real error')
  status = fx.status()
  assert.equal(status.lastRunStatus, 'failed')
  assert.equal(status.lastRunnerStatus, 'failed')
  assertIncludes(status.lastOutcomeReason, 'its changes were discarded', 'a failed session leaves no half-done edits behind')
  assert.equal(status.lastRunFailure.split('[run failed').length - 1, 1, 'the failure names its marker once')
  assertIncludes(status.lastRunFailure, 'fixture api error', 'and carries the real error')
  assert.ok(!fs.readFileSync(join(fx.repo, 'index.html'), 'utf8').includes('half-done'))
  assert.equal(fx.git('rev-parse', 'HEAD'), head, 'a failed session adds no commit')
}

// The lab, not the agent, decides what is kept: a session that breaks the
// product is reverted, and its history survives the revert.
function testBrokenSessionsAreRevertedAndTheirHistorySurvives() {
  const fx = runnerFixture('revert')
  session(fx)
  const good = fx.git('rev-parse', 'HEAD')
  const goodIndex = fs.readFileSync(join(fx.repo, 'index.html'), 'utf8')
  session(fx, { FAKE_MODE: 'break' })
  const status = fx.status()
  assert.equal(status.lastOutcome, 'reverted')
  assert.equal(status.lastRunStatus, 'reverted')
  assertIncludes(status.lastOutcomeReason, './check.sh failed', 'the revert names the check that broke')
  assert.equal(fs.readFileSync(join(fx.repo, 'index.html'), 'utf8'), goodIndex, 'the product is back to the last good version')
  assert.ok(!fs.existsSync(join(fx.repo, 'stray.txt')), 'files the session added are gone')
  assert.equal(fx.git('rev-parse', 'HEAD'), good, 'nothing was committed')
  assert.equal(status.lastGoodCommit, good)
  const log = fs.readFileSync(fx.runLog, 'utf8')
  assertIncludes(log, '**What changed:** break pass on the harbor', "the reverted session's own entry survives the revert")
  assertIncludes(log, '**Outcome:** reverted — ./check.sh failed', 'the revert is recorded in that entry')
  session(fx, { FAKE_MODE: 'idle' })
  assertIncludes(fx.prompt(), 'was reverted (./check.sh failed', 'the next session is told why')
}

// A session killed mid-way (Stop, reboot) leaves unverified edits; the next
// session sets them aside in a git stash instead of building on them.
function testInterruptedSessionLeftoversAreSetAside() {
  const fx = runnerFixture('leftovers')
  session(fx)
  const goodIndex = fs.readFileSync(join(fx.repo, 'index.html'), 'utf8')
  fs.writeFileSync(join(fx.repo, 'index.html'), 'half-written by a killed session')
  session(fx, { FAKE_MODE: 'idle' })
  assertIncludes(fx.prompt(), "An interrupted session's unverified changes were set aside with git stash", 'the builder is told')
  assert.equal(fs.readFileSync(join(fx.repo, 'index.html'), 'utf8'), goodIndex)
  assertIncludes(fx.git('stash', 'list'), 'leftovers of an interrupted session', 'the edits are recoverable, not lost')
}

// The lab only commits and reverts in a repository it owns outright.
function testProjectsInsideAnotherRepoRunWithoutTheRatchet() {
  const outer = tempDir('outer-repo')
  spawnSync('git', ['init', '-q'], { cwd: outer })
  const fx = runnerFixture('nested', { repoParent: outer })
  session(fx)
  const status = fx.status()
  assert.equal(status.ratchet, 'off')
  assertIncludes(status.ratchetReason, 'inside another git repository', 'the reason is recorded')
  assertIncludes(fx.prompt(), 'Version control is off for this project', 'the builder is told it cannot be reverted')
  assert.equal(spawnSync('git', ['log', '--oneline'], { cwd: outer, encoding: 'utf8' }).stdout.trim(), '', 'nothing is committed into the outer repository')
  assert.equal(status.lastOutcome, 'kept')
}

// Notes outrank everything, and each note is new exactly until a session that
// saw it is kept.
function testNotesComeFirstAndAreNewUntilASessionKeepsThem() {
  const fx = runnerFixture('notes')
  const feedback = join(fx.repo, 'reports', 'USER_FEEDBACK.md')
  fs.appendFileSync(feedback, '\n## 2026-09-01T10:00:00.000Z\n\nan older note\n\n## 2026-09-02T10:00:00.000Z\n\nmake the raid shorter\n')
  session(fx)
  assertIncludes(fx.prompt(), 'New notes from the person who owns the lab (these come first):', 'new notes lead the prompt')
  assertIncludes(fx.prompt(), '[2026-09-02T10:00:00.000Z] make the raid shorter', 'the newest note is quoted')
  assert.ok(!fx.prompt().includes('an older note'), 'without a record of seen notes only the newest counts as new')
  assert.ok(fx.status().notesSeenAt, 'a kept session marks the notes it saw')
  session(fx, { FAKE_MODE: 'improve' })
  assertIncludes(fx.prompt(), 'No new notes from the person', 'a note acted on is not repeated')
  fs.appendFileSync(feedback, `\n## ${new Date(Date.now() + 1000).toISOString()}\n\nthe music is too loud\n`)
  session(fx, { FAKE_MODE: 'improve' })
  assertIncludes(fx.prompt(), 'the music is too loud', 'a note written later is new again')
}

// A product keeps developing after each independently reviewed milestone.
function testProjectsMoveFromShapingToDone() {
  const fx = runnerFixture('stages')
  session(fx, { FAKE_REVIEW: 'yes' })
  assert.equal(fx.status().stage, 'polishing', 'a reviewer who finds the brief met moves the project to polishing')
  session(fx, { FAKE_MODE: 'idle', FAKE_REVIEW: 'yes' })
  assertIncludes(fx.prompt(), 'Polishing the current milestone.', 'polishing is milestone-scoped')
  assert.equal(fx.status().stage, 'polishing')
  assert.equal(fx.status().polishSessions, 0)
  session(fx, { FAKE_MODE: 'improve', FAKE_REVIEW: 'yes' })
  assert.equal(fx.status().stage, 'polishing', 'run count alone never finishes a milestone')
  session(fx, { FAKE_MODE: 'idle', FAKE_REVIEW: 'yes', FAKE_PROBLEMS: 'none', FAKE_REVIEW_EXIT: '3' })
  assert.equal(fx.status().stage, 'polishing', 'a failed reviewer cannot finish work even with a valid-looking verdict')
  assert.equal(fx.status().milestoneCount, undefined)
  session(fx, { FAKE_MODE: 'idle', FAKE_REVIEW: 'yes', FAKE_PROBLEMS: 'none' })
  assert.equal(fx.status().stage, 'done', 'a fresh independent review can finish unchanged but verified work')
  assert.equal(fx.status().milestoneCount, 1)
  const first = fx.status().lastMilestone
  session(fx, { FAKE_MODE: 'idle', FAKE_REVIEW: 'yes', FAKE_PROBLEMS: 'none' })
  assert.equal(fx.status().stage, 'advancing', 'the next session chooses a new milestone without asking the owner')
  assert.equal(fx.status().milestoneCount, 1, 'the same goal is never repeatedly counted')
  assertIncludes(fx.prompt(), first.goal, 'completed work survives fresh processes and is supplied as history')
  session(fx, { FAKE_MODE: 'milestone', FAKE_REVIEW: 'no' })
  assert.equal(fx.status().stage, 'building', 'the second milestone may need many sessions')
  assert.equal(fx.status().milestoneCount, 1)
  session(fx, { FAKE_MODE: 'improve', FAKE_REVIEW: 'yes', FAKE_PROBLEMS: 'none' })
  assert.equal(fx.status().stage, 'done')
  assert.equal(fx.status().milestoneCount, 2)
  assert.deepEqual(fx.status().milestoneHistory.map(m => m.goal), [first.goal, 'A harbor worth returning to.'])
  session(fx, { FAKE_MODE: 'improve', FAKE_REVIEW: 'garbage' })
  assert.equal(fx.status().stage, 'advancing', 'a reply without a verdict cannot complete another milestone')
  assertIncludes(fx.status().lastReviewError, 'no verdict', 'and says why')
  assert.equal(fx.status().lastReview.verdict, 'better', 'the last real review stays')
}

function testCodexReasoningEffortOverrides() {
  assert.equal(resolveCodexReasoningEffort(null, {}), 'high')
  assert.equal(resolveCodexReasoningEffort(null, { PI_PULSE_CODEX_REASONING_EFFORT: 'medium' }), 'medium')
  assert.equal(resolveCodexReasoningEffort('xhigh', { PI_PULSE_CODEX_REASONING_EFFORT: 'medium' }), 'xhigh')
  assert.equal(resolveCodexReasoningEffort('invalid', {}), 'high')
  const fx = runnerFixture('codex-effort', { status: { codexModel: 'gpt-6-astra', codexReasoningEffort: 'xhigh' } })
  session(fx)
  for (const file of [fx.argsPath, `${fx.argsPath}.review`]) {
    const args = fs.readFileSync(file, 'utf8')
    assertIncludes(args, '--model\ngpt-6-astra', 'the explicit model choice is preserved')
    assertIncludes(args, '-c\nmodel_reasoning_effort="xhigh"', 'a deliberate per-incubator override reaches both CLI invocations')
  }
}

function testLegacyBrowserBaselinesAreRechecked() {
  const fx = runnerFixture('legacy-browser-baseline')
  session(fx)
  const status = fx.status()
  status.lastChecks = { version: 1, check: { state: 'pass' }, app: { ran: true, blank: true } }
  fs.writeFileSync(fx.statusPath, JSON.stringify(status))
  const result = spawnSync(process.execPath, [join(root, 'scripts/lib/incubator-run.mjs'), 'session-begin', fx.statusPath, '5'], {
    encoding: 'utf8', env: { ...process.env, APP_EVIDENCE_SCRIPT: '/nonexistent/app-evidence.mjs' },
  })
  assert.equal(result.status, 0, result.stderr)
  const baseline = fx.status().session.baselineChecks
  assert.equal(baseline.version, 2)
  assert.equal(baseline.check.state, 'pass')
  assert.notEqual(baseline.app.blank, true, 'an old false-blank receipt must not mask a future real regression')
}

function testSessionPureRules() {
  const repo = tempDir('milestone-identity')
  const milestone = '# Goal\n## Goal\nLasting value.\n## Done means\n- [ ] ' + 'x'.repeat(220) + ' A\n'
  fs.writeFileSync(join(repo, 'MILESTONE.md'), milestone)
  const key = milestoneSnapshot(repo).key
  fs.writeFileSync(join(repo, 'MILESTONE.md'), milestone.replace('[ ]', '[x]'))
  assert.equal(milestoneSnapshot(repo).key, key, 'checking an outcome is not a new milestone')
  fs.writeFileSync(join(repo, 'MILESTONE.md'), milestone.replace(' A\n', ' B\n'))
  assert.notEqual(milestoneSnapshot(repo).key, key, 'identity uses full outcomes, not UI-truncated text')
  const complete = '**Verdict:** same — sound\n**Rating:** 4/5\n**Done:** yes\n**Top problems:**\nnone\n**Cut:** nothing'
  assert.equal(parseReview(complete).ok, true)
  assert.equal(parseReview(complete.replaceAll('\n', '\n\n')).ok, true, 'blank lines in a complete review are harmless')
  assert.equal(parseReview(complete.replace('**Top problems:**\nnone', '**Top problems:** none')).ok, true, 'inline none is explicit too')
  assert.equal(parseReview(complete + '\n**Verdict:** same — interrupted').ok, false, 'a truncated final review cannot borrow older fields')
  assert.equal(parseReview(complete.replace('none\n', 'Storage loses data\n')).problems.length, 1, 'unnumbered problems are not silently treated as approval')
  assert.deepEqual(nextStage({ stage: 'shaping', outcome: 'kept', briefExists: false }), { stage: 'shaping', polishSessions: 0 }, 'no brief, no building')
  assert.deepEqual(nextStage({ stage: 'building', outcome: 'reverted', briefExists: true, review: null }), { stage: 'building', polishSessions: 0 })
  assert.equal(isUnproductive({ lastRunStatus: 'no-changes', stage: 'building' }), true, 'a building session that changed nothing backs off')
  assert.equal(isUnproductive({ lastRunStatus: 'no-changes', stage: 'polishing' }), true, 'unresolved polishing with no change backs off')
  assert.equal(isUnproductive({ lastRunStatus: 'ok' }), false)
  assert.equal(parseReview('**Verdict:** better | same | worse — <one sentence>\n**Rating:** <0-5>/5\n**Done:** yes | no').ok, false, 'an echoed template is not a verdict')
  assert.deepEqual(breakage({ app: { ran: true, consoleErrors: 0 } }, { check: { state: 'none' }, app: { ran: true, state: 'FAIL', consoleErrors: 0, pageErrors: 0, blank: false } }), [], "the harness's soft FAIL heuristics never revert a session")
  assert.equal(breakage({ app: { ran: true, consoleErrors: 1 } }, { app: { ran: true, consoleErrors: 1 } }).length, 0, 'errors that were already there are not new')
  assert.equal(breakage(null, { app: { ran: true, blank: true } }).length, 1, 'a blank page is breakage')
  assert.equal(breakage({ app: { ran: true, pageErrors: 0 } }, { app: { ran: false, state: 'unavailable', pageErrors: 0 } }).length, 0, 'missing browser tooling is never mistaken for a broken product')
  const log = '# Run Log\n\n## Run 4 - d - BUILD\n\n**Goal:** g\n\n## User Feedback - x\n\n**Steering:** s\n'
  assert.match(insertIntoRunSection(log, 4, ['**Outcome:** kept']), /\*\*Goal:\*\* g\n\*\*Outcome:\*\* kept\n\n## User Feedback/, "harness fields land in the session's own section")
  assert.deepEqual(parseBrief('# X\n## What it is\nA game.\n## Done means\n- [x] one\n- [ ] two\n').done, [{ text: 'one', checked: true }, { text: 'two', checked: false }])
  // From a real session's "What changed", which used to become a title cut mid-sentence.
  assert.equal(commitHeadline('Created the project from scratch (folder only had reports/ before this): wrote BRIEF.md, a self-contained index.html'), 'Created the project from scratch')
  assert.equal(commitHeadline('The Anchor Guard now shows its wind-up a turn early, with what to do about it and why that matters for new players.'), 'The Anchor Guard now shows its wind-up a turn early, with what…')
  assert.equal(commitHeadline('good pass on the harbor'), 'good pass on the harbor')
  assert.equal(commitHeadline('Polish: tightened the copy on the first screen'), 'Polish: tightened the copy on the first screen', 'a short lead-in is not the whole title')
  assert.equal(commitHeadline('Added hints on the first screen, e.g. what to press. Also fixed the timer.'), 'Added hints on the first screen, e.g. what to press')
}

function testUnifiedRunnerFailsVisiblyOnBadInput() {
  const fx = runnerFixture('runner-errors')
  const runner = join(root, 'scripts', 'run-incubator.sh')
  const env = { ...process.env, LAB_DIR: fx.dir, CODEX_BIN: join(fx.bin, 'codex'), PI_PULSE_AGENT: '' }
  const missing = spawnSync('bash', [runner, join(fx.dir, 'nope.json')], { encoding: 'utf8', env })
  assert.equal(missing.status, 2)
  assertIncludes(missing.stderr, 'missing status.json path', 'missing status files should fail with exit 2')
  fs.writeFileSync(join(fx.dir, 'partial.json'), '{"project":"x"}')
  const partial = spawnSync('bash', [runner, join(fx.dir, 'partial.json')], { encoding: 'utf8', env })
  assert.equal(partial.status, 2)
  assertIncludes(partial.stderr, 'missing required field(s): repo, runLog', 'incomplete status files should name the missing fields')
  const full = spawnSync('bash', [runner, fx.statusPath], { encoding: 'utf8', env: { ...env, MIN_FREE_MB: '999999999' } })
  assert.equal(full.status, 75)
  assertIncludes(full.stderr, 'aborting: only', 'the disk guard should check the project filesystem, not a hardcoded /home/admin')
}

function testCorruptIncubatorsFileIsNeverOverwritten() {
  const dir = tempDir('incubators-corrupt')
  const projectsDir = join(dir, 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })
  const incubatorsPath = join(projectsDir, 'incubators.json')
  fs.writeFileSync(incubatorsPath, '{"slots": [ truncated')
  const script = `
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    const data = store.readIncubators()
    let error = null
    try { store.writeIncubators({ ...data, slots: [{ id: 'new' }] }) } catch (err) { error = { status: err.status, message: err.message } }
    console.log(JSON.stringify({ slots: data.slots.length, error }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PI_PULSE_LAB_ROOT: dir, PI_PULSE_INCUBATOR_REPO_ROOT: dir, PI_PULSE_PROJECTS_DIR: projectsDir },
  })
  assert.equal(result.status, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(out.slots, 0)
  assert.equal(out.error?.status, 409, 'writes over an unreadable incubators.json should be refused')
  assert.equal(fs.readFileSync(incubatorsPath, 'utf8'), '{"slots": [ truncated', 'the corrupt file should be left for manual repair')
}

// Runs an ESM snippet against the real server modules inside a disposable lab
// and returns the JSON the snippet prints last.
function runInLab(dir, script, extraEnv = {}) {
  const projectsDir = join(dir, 'projects')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PI_PULSE_LAB_ROOT: dir,
      PI_PULSE_INCUBATOR_REPO_ROOT: dir,
      PI_PULSE_PROJECTS_DIR: projectsDir,
      PI_PULSE_RUN_LOCK_DIR: join(projectsDir, '.run-locks'),
      PI_PULSE_RUN_CAPTURE_DIR: join(projectsDir, '.run-capture'),
      ...extraEnv,
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim().split('\n').pop())
}

function schedulerLab(name, { slotStatus = {}, slot = {} } = {}) {
  const dir = tempDir(name)
  const projectsDir = join(dir, 'projects')
  const repo = join(dir, 'proj')
  const bin = join(dir, 'bin')
  fs.mkdirSync(join(projectsDir, 'proj'), { recursive: true })
  fs.mkdirSync(join(repo, 'prompts'), { recursive: true })
  fs.mkdirSync(join(repo, 'reports'), { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(join(repo, 'prompts', 'mutate.md'), 'Mutate prompt.\n')
  fs.writeFileSync(join(repo, 'reports', 'RUN_LOG.md'), '# Run Log\n')
  writeExecutable(join(bin, 'codex'), `#!/usr/bin/env bash\necho ran >> ${JSON.stringify(join(dir, 'agent-ran'))}\n`)
  const statusPath = join(projectsDir, 'proj', 'status.json')
  fs.writeFileSync(statusPath, JSON.stringify({ project: 'proj', repo, runLog: join(repo, 'reports', 'RUN_LOG.md'), runner: 'codex', runTypes: ['mutate'], runCount: 0, ...slotStatus }, null, 2))
  fs.writeFileSync(join(projectsDir, 'incubators.json'), JSON.stringify({ slots: [{ id: 'proj', type: 'project', statusPath, enabled: true, intervalHours: 0.5, nextRunAt: Date.now() - 5000, ...slot }] }, null, 2))
  return { dir, projectsDir, statusPath, agentRan: join(dir, 'agent-ran'), env: { CODEX_BIN: join(bin, 'codex'), PATH: `${bin}:${process.env.PATH}` } }
}

function testDueScheduledSlotsActuallyFire() {
  // Regression: reconciling "stale" schedules on every registry read pushed each
  // due slot forward inside the scheduler's own read, so autonomous runs never fired.
  const lab = schedulerLab('scheduler-fires')
  const out = runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    runs.incubatorSchedulerTick()
    const fs = await import('node:fs')
    for (let i = 0; i < 150 && !fs.existsSync(${JSON.stringify(lab.agentRan)}); i += 1) await new Promise(r => setTimeout(r, 100))
    const slot = JSON.parse(fs.readFileSync(${JSON.stringify(join(lab.projectsDir, 'incubators.json'))}, 'utf8')).slots[0]
    console.log(JSON.stringify({ slot, ran: fs.existsSync(${JSON.stringify(lab.agentRan)}) }))
  `, lab.env)
  assert.equal(out.ran, true, 'a due, enabled, healthy slot must launch its agent')
  assert.equal(typeof out.slot.lastScheduledRun, 'string', 'the tick should record the scheduled launch')
  assert.notEqual(out.slot.lastScheduleBlockedCode, 'STALE_SCHEDULE_RECONCILED', 'ordinary reads must not reschedule due slots')
}

function testSchedulerChoosesOldestDueSlot() {
  const lab = schedulerLab('scheduler-fair')
  const registryPath = join(lab.projectsDir, 'incubators.json')
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const first = data.slots[0]
  // Shared fixture repo is intentional: only one launch is permitted. The lock
  // owner and schedule receipt identify which slot actually won the tick.
  data.slots.push({ ...first, id: 'older-due', nextRunAt: first.nextRunAt - 60000 })
  fs.writeFileSync(registryPath, JSON.stringify(data))
  const out = runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    const lock = await import(${JSON.stringify(join(root, 'server', 'run-lock.js'))})
    runs.incubatorSchedulerTick()
    const owner = lock.currentRunLock()
    for (let i = 0; i < 150 && lock.globalRunBusy(); i += 1) await new Promise(r => setTimeout(r, 100))
    console.log(JSON.stringify(owner))
  `, lab.env)
  assert.equal(out.id, 'older-due', 'registry position does not outrank time spent waiting')
}

function testOverdueSlotsAreSpacedOutOnlyAtBoot() {
  const lab = schedulerLab('scheduler-boot')
  const out = runInLab(lab.dir, `
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    const read = store.readIncubators().slots[0].nextRunAt
    store.reconcileStaleSchedulesAtBoot()
    const boot = store.readIncubators().slots[0]
    console.log(JSON.stringify({ read, boot }))
  `, lab.env)
  assert.ok(out.read < Date.now(), 'a plain read must leave a due slot due')
  assert.ok(out.boot.nextRunAt > Date.now(), 'service boot should move an overdue slot one interval out')
  assert.equal(out.boot.lastScheduleBlockedCode, 'STALE_SCHEDULE_RECONCILED')
}

function testSchedulerDefersBusySlotsWithoutRecountingFailures() {
  const lab = schedulerLab('scheduler-busy', { slotStatus: { runCount: 3, lastRunStatus: 'failed', lastQualityGate: 'FAIL' } })
  const due = JSON.parse(fs.readFileSync(join(lab.projectsDir, 'incubators.json'), 'utf8')).slots[0].nextRunAt
  const lockDir = join(lab.projectsDir, '.run-locks', 'global')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, kind: 'incubator', id: 'another-slot' }))
  const out = runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    for (let i = 0; i < 8; i += 1) runs.incubatorSchedulerTick()
    console.log(JSON.stringify(store.readIncubators().slots[0]))
  `, lab.env)
  assert.equal(out.enabled, true, 'waiting on another run never switches autopilot off')
  assert.ok(!out.failStreak, 'a slot waiting on the lock is not judged, so its last failure is not recounted')
  assert.equal(out.nextRunAt, due, 'a deferred slot stays due and starts on the first free tick')
  assert.ok(!fs.existsSync(lab.agentRan), 'nothing may launch while the global lock is held')
}

// Autopilot is never switched off by the lab: a failing slot waits longer after
// each new failure, retries by itself, and a good run resets the wait.
function testFailingSlotsBackOffAndRetryInsteadOfPausing() {
  const lab = schedulerLab('scheduler-backoff', { slotStatus: { runCount: 3, lastRunStatus: 'failed', lastQualityGate: 'FAIL' } })
  const incubatorsPath = join(lab.projectsDir, 'incubators.json')
  const tick = () => runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    const lock = await import(${JSON.stringify(join(root, 'server', 'run-lock.js'))})
    runs.incubatorSchedulerTick()
    const fs = await import('node:fs')
    for (let i = 0; i < 40 && !fs.existsSync(${JSON.stringify(lab.agentRan)}); i += 1) await new Promise(r => setTimeout(r, 100))
    // A launched run holds the lab lock until its runner finishes; let it finish.
    for (let i = 0; i < 150 && lock.globalRunBusy(); i += 1) await new Promise(r => setTimeout(r, 100))
    console.log(JSON.stringify(store.readIncubators().slots[0]))
  `, lab.env)
  const makeDue = () => {
    const data = JSON.parse(fs.readFileSync(incubatorsPath, 'utf8'))
    data.slots[0].nextRunAt = Date.now() - 1000
    fs.writeFileSync(incubatorsPath, JSON.stringify(data, null, 2))
  }
  const setStatus = patch => fs.writeFileSync(lab.statusPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(lab.statusPath, 'utf8')), ...patch }, null, 2))

  let slot = tick()
  assert.equal(slot.enabled, true, 'a failure never switches autopilot off')
  assert.equal(slot.failStreak, 1)
  assert.ok(slot.nextRunAt - Date.now() > 20 * 60 * 1000, 'the first failure waits an extra interval before retrying')
  assert.ok(!fs.existsSync(lab.agentRan), 'the backoff tick does not launch')

  makeDue()
  slot = tick()
  assert.ok(fs.existsSync(lab.agentRan), 'once the wait is over the slot retries by itself')
  assert.equal(slot.failStreak, 1, 'retrying the same failure does not grow the streak')
  fs.rmSync(lab.agentRan)

  // The retry failed too (runCount moved on): the next wait is longer.
  setStatus({ runCount: 4, lastRunStatus: 'failed' })
  makeDue()
  slot = tick()
  assert.equal(slot.failStreak, 2)
  assert.ok(slot.nextRunAt - Date.now() > 80 * 60 * 1000, 'the second failure in a row waits three intervals')
  assert.ok(!fs.existsSync(lab.agentRan))

  setStatus({ runCount: 5, lastRunStatus: 'ok', lastQualityGate: 'PASS' })
  makeDue()
  slot = tick()
  assert.ok(fs.existsSync(lab.agentRan), 'a healthy slot launches straight away')
  assert.equal(slot.failStreak, 0, 'a good run resets the backoff')
  assert.equal(slot.backoffReason, null)
}

// A finished project rests: autopilot stays on, but no sessions run until a
// note (or a manual Run) gives it something new to do.
function testFinishedProjectsRestUntilWoken() {
  const lab = schedulerLab('scheduler-rest', { slotStatus: { runCount: 9, stage: 'done', lifecycle: 'finite', lastRunStatus: 'ok' } })
  const tick = () => runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    const lock = await import(${JSON.stringify(join(root, 'server', 'run-lock.js'))})
    runs.incubatorSchedulerTick()
    const fs = await import('node:fs')
    for (let i = 0; i < 30 && !fs.existsSync(${JSON.stringify(lab.agentRan)}); i += 1) await new Promise(r => setTimeout(r, 100))
    for (let i = 0; i < 150 && lock.globalRunBusy(); i += 1) await new Promise(r => setTimeout(r, 100))
    console.log(JSON.stringify(store.readIncubators().slots[0]))
  `, lab.env)
  let slot = tick()
  assert.ok(!fs.existsSync(lab.agentRan), 'a finished project does not launch sessions')
  assert.equal(slot.enabled, true, 'resting is not switching autopilot off')
  assert.equal(typeof slot.restingSince, 'string', 'the rest is recorded')
  fs.writeFileSync(lab.statusPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(lab.statusPath, 'utf8')), lifecycle: 'product' }, null, 2))
  slot = tick()
  assert.ok(fs.existsSync(lab.agentRan), 'ongoing products launch after a completed milestone without owner input')
  assert.equal(slot.restingSince, null)
}

function testFusePausedSlotsResumeAtBoot() {
  const lab = schedulerLab('scheduler-fuse-resume', {
    slot: { enabled: false, nextRunAt: null, schedulePausedAt: new Date().toISOString(), schedulePauseReason: 'schedule paused: 5 consecutive failed quality gates; needs deliberate steering or manual run', lastScheduleBlockedCode: 'AUTO_FAIL_FUSE', consecutiveFailGates: 5 },
  })
  const manual = schedulerLab('scheduler-manual-off', { slot: { enabled: false, nextRunAt: null } })
  const resumed = runInLab(lab.dir, `
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    store.reconcileStaleSchedulesAtBoot()
    console.log(JSON.stringify(store.readIncubators().slots[0]))
  `, lab.env)
  assert.equal(resumed.enabled, true, 'a slot the retired fuse switched off comes back on at boot')
  assert.ok(resumed.nextRunAt > Date.now(), 'it resumes one interval out, not in a burst')
  assert.equal(resumed.schedulePauseReason, null)
  assert.equal(resumed.lastScheduleBlockedCode, 'AUTOPILOT_RESUMED')
  assert.equal(resumed.failStreak, 5, 'its failures carry over into the backoff')
  assert.equal(resumed.backoffForRun, 0, 'it retries once at the next interval before backing off again')
  const untouched = runInLab(manual.dir, `
    const store = await import(${JSON.stringify(join(root, 'server', 'incubator-store.js'))})
    store.reconcileStaleSchedulesAtBoot()
    console.log(JSON.stringify(store.readIncubators().slots[0]))
  `, manual.env)
  assert.equal(untouched.enabled, false, 'autopilot a person switched off stays off')
}

// New server code on disk loads itself: only when the lab is idle, only after
// the files stopped changing, and only when every file parses and imports.
function testNewSourceRestartsAnIdleServiceOnlyWhenClean() {
  const health = fingerprint => ({ source: { changedSinceStart: true, fingerprint } })
  const plans = [
    staleSourceRestartPlan({ health: { source: { changedSinceStart: false, fingerprint: 'a' } } }),
    staleSourceRestartPlan({ health: health('a') }),
    staleSourceRestartPlan({ health: health('a'), pendingFingerprint: 'a', busy: true }),
    staleSourceRestartPlan({ health: health('a'), pendingFingerprint: 'a' }),
    staleSourceRestartPlan({ health: health('b'), pendingFingerprint: 'a' }),
    staleSourceRestartPlan({ health: health('a'), pendingFingerprint: 'a', rejectedFingerprint: 'a' }),
  ].map(plan => plan.action)
  assert.deepEqual(plans, ['none', 'settle', 'none', 'restart', 'settle', 'none'], 'fresh source, first sighting, busy lab, settled + idle, still changing, known-bad source')

  const dir = tempDir('restart-validate')
  fs.mkdirSync(join(dir, 'server'))
  fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(join(dir, 'server', 'ok.js'), 'export const ok = 1\n')
  fs.writeFileSync(join(dir, 'server', 'syntax.js'), 'export const broken = (\n')
  fs.writeFileSync(join(dir, 'server', 'import.js'), "import { nope } from './missing.js'\nexport const x = nope\n")
  fs.writeFileSync(join(dir, 'run.sh'), 'if then fi\n')
  assert.equal(validateSourceForRestart([join(dir, 'server', 'ok.js')]).ok, true)
  assert.match(validateSourceForRestart([join(dir, 'server', 'syntax.js')]).error, /SyntaxError/, 'a half-written file is never loaded')
  assert.match(validateSourceForRestart([join(dir, 'server', 'import.js')]).error, /ERR_MODULE_NOT_FOUND|Cannot find module/, 'a broken import is never loaded')
  assert.match(validateSourceForRestart([join(dir, 'run.sh')]).error, /syntax error/, 'a broken runner script is never loaded')
}

function testStopReachesRunsRecoveredFromTheLock() {
  const lab = schedulerLab('stop-recovered')
  const sleeper = spawnSync('bash', ['-c', 'setsid sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
  const pid = Number(sleeper.stdout.trim())
  assert.ok(pid > 1, 'fixture should start a detached process')
  const lockDir = join(lab.projectsDir, '.run-locks', 'global')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid, kind: 'incubator', id: 'proj' }))
  const out = runInLab(lab.dir, `
    const runs = await import(${JSON.stringify(join(root, 'server', 'incubator-runs.js'))})
    const fs = await import('node:fs')
    const stopped = runs.stopIncubatorRun('proj')
    await new Promise(r => setTimeout(r, 300))
    // An unreaped zombie still answers kill(pid, 0); only a live process counts.
    let state = 'gone'
    try { state = fs.readFileSync('/proc/${pid}/stat', 'utf8').split(') ')[1][0] } catch {}
    console.log(JSON.stringify({ stopped, alive: state !== 'gone' && state !== 'Z' }))
  `, lab.env)
  try { process.kill(pid, 'SIGKILL') } catch {}
  assert.equal(out.stopped, pid, 'after a Pi Pulse restart, stop should find the run through the lock')
  assert.equal(out.alive, false, 'the recovered run should actually be stopped')
}

function testSpawnFailuresReleaseTheLockAndLeaveAReceipt() {
  const dir = tempDir('spawn-error')
  const runLog = join(dir, 'RUN_LOG.md')
  fs.writeFileSync(runLog, '# Run Log\n')
  const out = runInLab(dir, `
    const lock = await import(${JSON.stringify(join(root, 'server', 'run-lock.js'))})
    const held = lock.acquireRunLock({ kind: 'incubator', id: 'gone' })
    const exit = await new Promise(resolve => {
      lock.spawnTrackedRun({
        script: '/bin/true', cwd: ${JSON.stringify(join(dir, 'repo-that-vanished'))}, captureName: 'gone',
        runLogPath: ${JSON.stringify(runLog)}, nextRunNum: () => 9, lock: held,
        onExit: (code, signal, meta) => resolve({ code, error: meta.error?.code || null }),
      })
    })
    console.log(JSON.stringify({ exit, lockAfter: lock.currentRunLock() }))
  `)
  assert.equal(out.exit.error, 'ENOENT', 'a vanished cwd should surface as a spawn error, not crash Pi Pulse')
  assert.equal(out.lockAfter, null, 'the global lock must be released after a spawn failure')
  const runs = parseRunsFromLog(fs.readFileSync(runLog, 'utf8'))
  assert.equal(runs[0]?.type, 'FAILED')
  assertIncludes(runs[0].Failure, 'spawn failed: ENOENT', 'the FAILED row should name the spawn error')
}

function testCpuSamplesAreStableAcrossConsumers() {
  const out = runInLab(tempDir('cpu-sampler'), `
    const { spawn } = await import('node:child_process')
    const stats = await import(${JSON.stringify(join(root, 'server', 'system-stats.js'))})
    const burner = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' })
    stats.startStatsSampler()
    await new Promise(r => setTimeout(r, 2400))
    const a = stats.buildStatsPayload().cpu
    const b = stats.buildStatsPayload().cpu
    burner.kill('SIGKILL')
    console.log(JSON.stringify({ a, b }))
    process.exit(0)
  `)
  assert.equal(out.a, out.b, 'back-to-back consumers must read the same sample, not a zero-length delta')
  assert.ok(out.a > 0, 'a busy sampling window should report non-zero CPU')
}

function testSuccessfulTranscriptsThatMentionErrorsStaySuccessful() {
  // Shapes from the real core RUN_LOG that the keyword classifier marked FAILED.
  const content = [
    '<!-- stdout from run 29 2026-04-08 12:00 -->',
    '**Run 29 done.** Build: ✓ built in 5.39s',
    '',
    '`RUN_LOG_PATH` was a const read before init; every request failed with a ReferenceError until this fix.',
    '',
    '<!-- stdout from run 91 2026-07-03 18:00 -->',
    'Reading additional input from stdin...',
    'OpenAI Codex v0.46',
    '- Make failed stdout-only runs visible in history as `FAILED` with the actual command error',
    '',
    '<!-- stdout from run 89 2026-07-03 19:00 -->',
    '[run completed successfully; verbose Codex transcript omitted to avoid duplicating RUN_LOG content.]',
    'Quoted from the old log:',
    '[run failed - codex exited 127]',
    '',
    '<!-- stdout from run 92 2026-07-03 20:00 -->',
    'npm test exited 0 after 41 checks',
    '',
  ].join('\n')
  const failed = parseRunsFromLog(content).filter(run => run.type === 'FAILED')
  assert.deepEqual(failed.map(run => run.num), [], 'prose about errors, a quoted marker, and exit 0 are not failures')

  const real = parseRunsFromLog([
    '<!-- stdout from run 67 2026-04-10 19:52 -->',
    '[run failed — claude exited 1]',
    '',
    "You've hit your limit · resets 11pm",
    '',
    '<!-- stdout from run 95 2026-07-03 18:42 -->',
    "There's an issue with the selected model (fable). It may not exist or you may not have access to it.",
    '',
  ].join('\n'))
  assert.deepEqual(real.map(run => run.type), ['FAILED', 'FAILED'], 'explicit markers and a leading CLI error still fail')
}

const tests = [
  testStdoutFailedRunsShowCommandError,
  testCapturedFailureDetailIsReusableForStatusReceipts,
  testScheduledPreflightPersistsUsefulFailureDetail,
  testManualPreflightPersistsUsefulFailureDetail,
  testPreflightBlocksBadCodexRunBeforeLaunch,
  testClaudePreflightUsesConfiguredBinaryFallback,
  testClaudePreflightChecksLauncherBackedRelay,
  testRetiredClaudePinsFallThroughButAliasesStay,
  testFreshIncubatorsHaveGenericClaudeRunner,
  testNewIncubatorInsideParentGetsOwnHistory,
  testExistingIncubatorsNormalizeClaudeRelayState,
  testStdoutOnlyApiErrorsBecomeFailedRows,
  testStdoutBoldFailedRowsDoNotNeedErrorText,
  testFormalNoSummaryApiErrorsBecomeFailedRows,
  testPerIncubatorAiFeedbackShape,
  testApiFallbackCannotServeSpaHtml,
  testCachedAiLatestEndpointsHydrateLegacyFiles,
  testPreflightBlockedLaunchLooksBlocked,
  testNewestFailedRowStaysOpenBelowCompletedRun,
  testRecoveredOldFailuresStopBeingPinned,
  testFormalParagraphRunsKeepReadableSummary,
  testClaudeNoSummaryRowsShowOutputExcerpt,
  testNoSummaryRowsPreferStdoutOverGenericDone,
  testQualityGateFieldsDriveStatusAndHistory,
  testFormalRowsHydrateSavedStdoutFile,
  testFormalRowsHydrateStdoutPathFromExcerpt,
  testFormalRowsFailFromSavedStdoutFile,
  testRunLogCannotHydrateArbitraryStdoutPath,
  testDependencyErrorPackageNamesDoNotCreateFailedRows,
  testProjectSummaryBeatsSyntheticNoSummaryDuplicate,
  testFormalFailedRowsExposeAllDiagnostics,
  testClaudeRunnerSwitchWarnsFromLaunchPreflight,
  testAppEvidenceHarnessWritesSummaryArtifact,
  testAppEvidenceSemanticContractCanBeTopTierEligible,
  testBrowserEvidenceSeparatesObservationFromProbeFailures,
  testCoreLabQualityContractIsWired,
  testTrustHarnessRunsBeforeBuild,
  testPublicWriteSafetyAndLoopFusesAreWired,
  testStaleSourceMutationsAreWriteGated,
  testSessionsBuildKeepAndReviewWithEitherAgent,
  testBrokenSessionsAreRevertedAndTheirHistorySurvives,
  testInterruptedSessionLeftoversAreSetAside,
  testProjectsInsideAnotherRepoRunWithoutTheRatchet,
  testNotesComeFirstAndAreNewUntilASessionKeepsThem,
  testProjectsMoveFromShapingToDone,
  testSessionPureRules,
  testCodexReasoningEffortOverrides,
  testLegacyBrowserBaselinesAreRechecked,
  testUnifiedRunnerFailsVisiblyOnBadInput,
  testCorruptIncubatorsFileIsNeverOverwritten,
  testDueScheduledSlotsActuallyFire,
  testSchedulerChoosesOldestDueSlot,
  testOverdueSlotsAreSpacedOutOnlyAtBoot,
  testSchedulerDefersBusySlotsWithoutRecountingFailures,
  testFailingSlotsBackOffAndRetryInsteadOfPausing,
  testFinishedProjectsRestUntilWoken,
  testFusePausedSlotsResumeAtBoot,
  testNewSourceRestartsAnIdleServiceOnlyWhenClean,
  testStopReachesRunsRecoveredFromTheLock,
  testSpawnFailuresReleaseTheLockAndLeaveAReceipt,
  testCpuSamplesAreStableAcrossConsumers,
  testSuccessfulTranscriptsThatMentionErrorsStaySuccessful,
]

let failures = 0
for (const test of tests) {
  try {
    await test()
    console.log(`ok - ${test.name}`)
  } catch (err) {
    failures += 1
    console.log(`not ok - ${test.name}\n${String(err.stack || err.message).split('\n').map(line => `  ${line}`).join('\n')}`)
  }
}
if (failures) {
  console.log(`${failures} of ${tests.length} trust fixtures failed`)
  process.exit(1)
}
