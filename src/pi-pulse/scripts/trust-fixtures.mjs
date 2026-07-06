import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  aiFeedbackPayload,
  appendFailedPreflightEntry,
  appendFailedRunEntry,
  firstRunnableClaudeModel,
  capturedFailureDetail,
  hydrateAiFeedback,
  parseRunsFromLog,
  preflightRunConfig,
  runsWithPinnedLatestFailure,
} from '../server-core.js'
import {
  AiStripView,
  cachedAiFeedbackForSlot,
  fetchSavedAiFeedback,
  normalizeAnalysis,
  rememberAiFeedbackForSlot,
  shouldRefreshAiForTrigger,
} from '../src/components/AiStrip.js'
import {
  failureSignal,
  outputSignal,
  runFailureDetail,
  RunHistoryList,
  runHistorySummary,
  runOutputDetail,
} from '../src/components/RunHistoryList.js'
import {
  latestCompletedRunSignature,
  newestFailedRunKey,
  runHistoryKey,
} from '../src/lib/runSignals.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function tempDir(name) {
  return fs.mkdtempSync(join(os.tmpdir(), `pi-pulse-${name}-`))
}

function assertIncludes(haystack, needle, message) {
  assert.ok(String(haystack).includes(needle), `${message}: expected "${haystack}" to include "${needle}"`)
}

function findReactElement(node, predicate) {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReactElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  return findReactElement(node.props?.children, predicate)
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

function testStaleClaudeFableFallsThrough() {
  assert.equal(firstRunnableClaudeModel('fable', 'claude-sonnet-4-20250514', 'sonnet'), 'sonnet')
  assert.equal(firstRunnableClaudeModel('', null), null)
}

function testFreshIncubatorsHaveGenericClaudeRunner() {
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  const scriptPath = join(root, 'scripts', 'run-claude-incubator.sh')
  const script = fs.readFileSync(scriptPath, 'utf8')
  const mode = fs.statSync(scriptPath).mode

  assert.ok(mode & 0o111, 'generic Claude incubator runner should be executable')
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
  assertIncludes(script, '[claude-incubator] missing prompt', 'generic Claude runner should fail with visible prompt errors')
  assertIncludes(script, 'Full stdout saved to $STDOUT_FILE', 'generic Claude runner should preserve stdout for run history detail')
  assertIncludes(script, "invalid=new Set(['fable','claude-sonnet-4-20250514'])", 'generic Claude runner should quarantine stale model pins')
  assertIncludes(script, "const safe='sonnet'", 'generic Claude runner should fall forward to the stable Sonnet alias')
  assertIncludes(script, 'CLAUDE_ARGS=(-p "$FULL_PROMPT")', 'generic Claude runner should build model args from repaired status')
  assertIncludes(script, 'CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude || true)}', 'generic Claude runner should honor the same configured binary as preflight')
}

function testExistingIncubatorsNormalizeClaudeRelayState() {
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')

  assertIncludes(server, 'function normalizeIncubatorStatus(statusPath)', 'existing incubator slots should be normalized before relay switching')
  assertIncludes(server, 'function ensureIncubatorProjectScaffold(status)', 'existing incubator slots should get missing run scaffold repaired')
  assertIncludes(server, "writeFileIfMissing(status.runLog, '# Run Log\\n\\n')", 'normalization should create a readable run log when history is missing')
  assertIncludes(server, 'function safeRunTypeName(runType)', 'scaffolded prompt filenames should be sanitized run type names')
  assertIncludes(server, "writeFileIfMissing(join(status.promptDir, `${runType}.md`), promptForIncubatorRunType(project, runType))", 'normalization should create missing prompts for configured run types')
  assertIncludes(server, "const { status: cfg } = normalizeIncubatorStatus(slot.statusPath)", 'history reads should repair missing scaffold before loading RUN_LOG.md')
  assertIncludes(server, "const project = next.project || basename(dirname(statusPath))", 'normalization should recover a project id from the status path')
  assertIncludes(server, 'const launcherInfo = writeIncubatorLauncher({ slug: project, statusPath })', 'normalization should reconcile the same launcher as idea-created incubators')
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

async function testFeedbackSwitchingReadsLatestWithoutRegenerating() {
  const calls = []
  const payloads = {
    core: {
      ok: true,
      response: 'DIRECTION: Core cached direction',
      fields: {
        DIRECTION: 'Core cached direction',
        STRONGEST: 'Failure rows stay visible.',
        WEAKEST: 'Switch behavior needed proof.',
        DRIFT: 'No drift.',
        NEXT: 'Keep fixtures close.',
      },
      missing: [],
      malformed: false,
      incubatorId: 'core',
      project: 'pi-pulse',
      source: 'local-ollama-qwen',
      model: 'qwen2.5-instruct:1.5b',
      ts: 123,
    },
    'race-whisperer-predict': {
      ok: true,
      response: 'DIRECTION: Race cached direction',
      fields: {
        DIRECTION: 'Race cached direction',
        STRONGEST: 'Project-local memory is distinct.',
        WEAKEST: 'Shared cache would feel random.',
        DRIFT: 'No drift.',
        NEXT: 'Keep feedback per incubator.',
      },
      missing: [],
      malformed: false,
      incubatorId: 'race-whisperer-predict',
      project: 'race-whisperer-predict',
      source: 'local-ollama-qwen',
      model: 'qwen2.5-instruct:1.5b',
      ts: 456,
    },
  }
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' })
    const slotId = String(url).match(/\/api\/incubators\/([^/]+)\/ai\/latest$/)?.[1]
    assert.ok(slotId, `slot switch should read latest cached feedback, got ${url}`)
    return { text: async () => JSON.stringify(payloads[slotId]) }
  }

  const core = await fetchSavedAiFeedback({ fetchImpl, slotId: 'core' })
  const race = await fetchSavedAiFeedback({ fetchImpl, slotId: 'race-whisperer-predict' })
  const coreHtml = renderToStaticMarkup(h(AiStripView, { open: true, analysis: core.analysis, lastRun: core.lastRun }))
  const raceHtml = renderToStaticMarkup(h(AiStripView, { open: true, analysis: race.analysis, lastRun: race.lastRun }))

  assert.deepEqual(calls.map(call => call.url), [
    '/api/incubators/core/ai/latest',
    '/api/incubators/race-whisperer-predict/ai/latest',
  ])
  assert.ok(calls.every(call => call.method === 'GET'), 'slot switching should use GET latest calls only')
  assert.ok(calls.every(call => !call.url.includes('/ai/analyze')), 'slot switching latest-feedback path must not regenerate analysis')
  assertIncludes(coreHtml, 'data-ai-strip-source="local-ollama-qwen"', 'rendered strip should label local Ollama/Qwen source')
  assertIncludes(coreHtml, 'data-ai-incubator="core"', 'rendered core feedback should retain incubator identity')
  assertIncludes(coreHtml, 'Core cached direction', 'rendered core strip should show cached field text')
  assertIncludes(raceHtml, 'data-ai-incubator="race-whisperer-predict"', 'rendered child feedback should retain incubator identity')
  assertIncludes(raceHtml, 'Race cached direction', 'rendered child strip should show its own cached field text')

  const fallback = normalizeAnalysis({ response: 'DIRECTION: Raw-only feedback', incubatorId: 'core' })
  assert.equal(fallback.fields.DIRECTION, undefined)
  assert.equal(fallback.malformed, true, 'raw-only cached feedback should stay visibly malformed until parsed by the server')
}

function testAiStripKeepsPerSlotClientCache() {
  let cache = {}
  const coreFeedback = {
    analysis: normalizeAnalysis({
      response: 'DIRECTION: Core stays cached',
      fields: {
        DIRECTION: 'Core stays cached',
        STRONGEST: 'Host trust is visible.',
        WEAKEST: 'Blank switching states reduce confidence.',
        DRIFT: 'No drift.',
        NEXT: 'Keep cached feedback on card switch.',
      },
      incubatorId: 'core',
      project: 'pi-pulse',
      source: 'local-ollama-qwen',
    }),
    lastRun: '10:00:00',
  }
  const raceFeedback = {
    analysis: normalizeAnalysis({
      response: 'DIRECTION: Race stays distinct',
      fields: {
        DIRECTION: 'Race stays distinct',
        STRONGEST: 'Project feedback is separated.',
        WEAKEST: 'Shared state would feel random.',
        DRIFT: 'No drift.',
        NEXT: 'Preserve per-slot memory.',
      },
      incubatorId: 'race-whisperer-predict',
      project: 'race-whisperer-predict',
      source: 'local-ollama-qwen',
    }),
    lastRun: '10:05:00',
  }

  cache = rememberAiFeedbackForSlot(cache, 'core', coreFeedback)
  cache = rememberAiFeedbackForSlot(cache, 'race-whisperer-predict', raceFeedback)

  assert.equal(cachedAiFeedbackForSlot(cache, 'core').analysis.fields.DIRECTION, 'Core stays cached')
  assert.equal(cachedAiFeedbackForSlot(cache, 'race-whisperer-predict').analysis.fields.DIRECTION, 'Race stays distinct')
  assert.equal(cachedAiFeedbackForSlot(cache, 'missing'), null)

  assert.equal(shouldRefreshAiForTrigger(undefined, 0), false, 'first render should not analyze without a completed-run trigger')
  assert.equal(shouldRefreshAiForTrigger(undefined, 1), true, 'inactive slot should refresh when selected after a completed run trigger')
  assert.equal(shouldRefreshAiForTrigger(1, 1), false, 'same trigger count should not regenerate analysis')
  assert.equal(shouldRefreshAiForTrigger(1, 2), true, 'completed runs should still trigger fresh local critic feedback')
}

function testSlotSwitchingHasBrowserStableDomHooks() {
  const panel = fs.readFileSync(join(root, 'src', 'components', 'ProjectPanel.jsx'), 'utf8')
  assertIncludes(panel, 'data-incubator-card={slot.id}', 'incubator cards should expose stable slot ids for browser smoke clicks')
  assertIncludes(panel, "data-incubator-selected={selected === slot.id ? 'true' : 'false'}", 'selected incubator card should expose selection state')
  assertIncludes(panel, 'data-active-ai-slot={activeSlot.id}', 'AI strip wrapper should expose the selected slot id')
  assertIncludes(panel, 'aria-label={`Select incubator ${slot.name || slot.id}`}', 'incubator cards should have accessible click targets')
  assertIncludes(panel, "if (event.key === 'Enter' || event.key === ' ')", 'incubator card selection should be keyboard reachable')

  const loadingHtml = renderToStaticMarkup(h(AiStripView, { slotId: 'race-whisperer-predict', open: false }))
  assertIncludes(loadingHtml, 'data-ai-incubator="race-whisperer-predict"', 'AI strip should keep active incubator identity before feedback loads')
  assertIncludes(loadingHtml, 'Local Ollama/Qwen feedback for race-whisperer-predict', 'AI strip accessible label should identify the selected incubator')
}

function testProjectPanelApiJsonErrorsStayVisible() {
  const panel = fs.readFileSync(join(root, 'src', 'components', 'ProjectPanel.jsx'), 'utf8')
  const selectedRunnerIndex = panel.indexOf('const selectedRunner = activeSlot.runner || activeSlot.schedule?.runner || \'script\'')
  const receiptIndex = panel.indexOf('const runnerReceiptLabel = selectedRunner === \'claude\'')

  assertIncludes(panel, 'async function readApiJson(response, label = \'API request\')', 'project panel should centralize API JSON parsing')
  assertIncludes(panel, 'returned HTML instead of JSON', 'project panel should explain HTML/API fallthrough instead of surfacing Unexpected token')
  assertIncludes(panel, 'async function fetchApiJson(url, options)', 'project panel should use one API JSON helper for route reads')
  assertIncludes(panel, 'const { response: res, data: d } = await fetchApiJson(`/api/incubators/${id}/runs`)', 'history loading should use the guarded JSON parser')
  assertIncludes(panel, 'setHistoryErrorsBySlot(prev => ({ ...prev, [id]: err.message || \'failed to load run history\' }))', 'history parser failures should stay visible in UI state')
  assertIncludes(panel, 'const { response: res, data: d } = await fetchApiJson(`/api/incubators/${slot.id}/runner`,', 'runner switching should use the guarded JSON parser')
  assert.ok(!panel.includes('.then(r => r.json())'), 'project panel should not contain raw response.json chains')
  assert.ok(!panel.includes('await res.json()'), 'project panel should not contain raw response.json awaits')
  assert.ok(selectedRunnerIndex > 0, 'selected runner should be initialized')
  assert.ok(receiptIndex > selectedRunnerIndex, 'runner receipt should not read selectedRunner before initialization')
}

function testCachedAiLatestEndpointsHydrateLegacyFiles() {
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  assertIncludes(server, 'function readCachedAiFeedback(target)', 'server should centralize saved AI feedback hydration')
  assertIncludes(server, "app.get('/api/incubators/:id/ai/latest'", 'incubator latest endpoint should exist')
  assertIncludes(server, "app.get('/api/child/ai/latest'", 'legacy child latest endpoint should exist')
  assertIncludes(server, "app.get('/api/ai/latest'", 'legacy core latest endpoint should exist')
  assertIncludes(
    server,
    "res.json(readCachedAiFeedback(target))",
    'incubator latest endpoint should hydrate cached feedback before returning it'
  )
  assertIncludes(
    server,
    'paths: { json: CHILD_FEEDBACK_JSON, md: CHILD_FEEDBACK_MD }',
    'legacy child latest endpoint should use the same cached feedback contract'
  )
  assertIncludes(
    server,
    'paths: { json: CORE_FEEDBACK_JSON, md: CORE_FEEDBACK_MD }',
    'legacy core latest endpoint should use the same cached feedback contract'
  )
}

function testPreflightBlockedLaunchLooksBlocked() {
  const panel = fs.readFileSync(join(root, 'src', 'components', 'ProjectPanel.jsx'), 'utf8')
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  assertIncludes(server, 'function appendManualPreflightFailure', 'manual launch preflight blocks should append durable FAILED history')
  assertIncludes(server, "source: 'manual-preflight'", 'manual preflight history rows should identify manual launch blocks')
  assertIncludes(server, 'function appendRunnerSwitchPreflightFailure', 'blocked relay switches should append durable FAILED history')
  assertIncludes(server, "source: 'runner-switch-preflight'", 'relay switch preflight rows should identify blocked runner switching')
  assertIncludes(server, 'appendManualPreflightFailure({\n      slot,\n      runLogPath,\n      preflight: result.preflight,\n    })\n    notifyIncubatorClients()', 'manual incubator preflight blocks should broadcast the newly written FAILED history row')
  assertIncludes(server, 'function appendIncubatorPreflightFailure', 'incubator preflight failures should share one durable status/history receipt path')
  assertIncludes(server, 'markIncubatorPreflightAttempt({ statusPath: slot.statusPath, preflight, num, label })', 'incubator preflight failures should update status so later run numbers advance')
  assertIncludes(server, 'function markIncubatorProcessFailure', 'process-level incubator failures should update slot status, not only history')
  assertIncludes(server, 'capturedFailureDetail(capturePath)', 'process-level failure status should reuse the captured command error')
  assertIncludes(server, "lastRunFailureSource: cfg.lastRunFailureSource", 'hydrated incubator slots should expose the failure source')
  assertIncludes(server, 'parseRunsFromLog(fs.readFileSync(status.runLog, \'utf8\'))', 'next incubator run numbers should include existing FAILED history rows')
  assertIncludes(panel, 'const runnerBlocked = !!readinessIssue', 'launch button should derive blocked state from preflight/readiness failure')
  assertIncludes(panel, 'const runDisabled = activeSlot.launching || activeSlot.running', 'preflight-blocked slots should still let the server record a blocked manual run')
  assertIncludes(panel, "data-run-blocked={runnerBlocked ? 'true' : 'false'}", 'blocked launch state should be visible to browser tests')
  assertIncludes(panel, 'RUNNER BLOCKED', 'blocked launch button should be visibly labeled')
  assertIncludes(panel, 'click to record failure: ${readinessIssue.slice(0, 72)}', 'blocked launch button should explain that clicking records a durable failure row')
  assertIncludes(panel, "onClick={() => { if (!runDisabled) activeSlot.onRun?.() }}", 'blocked launch button should call the server endpoint so preflight can write history')
  assertIncludes(panel, 'function preflightFailureRows(preflight)', 'panel should format every failed preflight check for the selected incubator')
  assertIncludes(panel, "data-preflight-detail={readinessDetails.length ? 'true' : 'false'}", 'runner blocked panel should expose detailed preflight state to browser tests')
  assertIncludes(panel, '`${label}: ${detail}${check.path ? ` (${check.path})` : \'\'}', 'preflight detail should keep the failed check path visible')
  assertIncludes(panel, 'setPreflightBySlot(prev => ({ ...prev, [slot.id]: setup }))', 'failed relay switch responses should keep full setup detail in the UI')
  assertIncludes(panel, '{preflightRunnerLabel} preflight', 'runner blocked panel should label which runner preflight failed')
  assertIncludes(panel, "function mutationBlockMessage(data = {}, fallback = 'request failed')", 'mutating requests should preserve machine-readable stale-source blocks')
  assertIncludes(panel, "data-restart-pulse-service=\"true\"", 'stale-source runner blocks should expose a service restart action')
  assertIncludes(panel, "fetch('/api/restart', { method: 'POST' })", 'stale-source restart action should restart Pi Pulse without using full host reboot')
  assertIncludes(panel, 'async function waitForPulseHealthy', 'stale-source restart action should wait for Pi Pulse to come back')
  assertIncludes(panel, "if (d.code === 'STALE_SERVICE_SOURCE' && allowStaleRestart)", 'stale-source relay switches should trigger one automatic service restart path')
  assertIncludes(panel, 'Pi Pulse source stale; restarting service, then retrying ${runner} relay switch.', 'relay switch recovery should tell the user exactly what is happening')
  assertIncludes(panel, 'return performSwitch(false)', 'relay switch recovery should retry only once after restart')
  assertIncludes(panel, "data-card-run-blocked={runnerBlocked ? 'true' : 'false'}", 'incubator cards should expose blocked runner state before selection')
  assertIncludes(panel, "data-card-preflight-detail={readinessDetails.length ? 'true' : 'false'}", 'incubator cards should expose whether failed check details are present')
  assertIncludes(panel, "runnerBlocked ? 'runner blocked'", 'incubator cards should visibly label blocked runners')
  assertIncludes(panel, 'fetchSlotPreflight(slot.id)', 'incubator polling should hydrate preflight state for every project slot')
  assertIncludes(panel, "onRun={(e) => { e?.stopPropagation?.(); slot.onRun() }}", 'card run button should route blocked attempts through server preflight history')
  assertIncludes(panel, "title={runnerBlocked ? `Record blocked run: ${readinessIssue}` : `Run ${slot.name}`}", 'card run control should expose the blocking error in its title')
  assertIncludes(panel, 'const lastRunFailed = slot.lastRunStatus === \'failed\'', 'incubator cards should detect failed last-run status')
  assertIncludes(panel, 'lastRunFailed ? \'last failed\'', 'incubator cards should label failed last-run state')
  assertIncludes(panel, 'data-card-last-run-failure={lastRunFailed ? slot.id : undefined}', 'incubator cards should expose last-run failure receipts to browser tests')
  assertIncludes(server, "availableRunners: ['codex', 'claude']", 'Claude should stay visible as a relay option even when setup is incomplete')
  assertIncludes(server, 'function claudeRunnerSetupForStatus(cfg)', 'server should report Claude setup state separately from launch preflight')
  assertIncludes(server, "runnerSetups: { claude: claudeSetup }", 'incubator payload should include Claude setup diagnostics')
  assertIncludes(server, 'function repairClaudeRunnerStatusIfNeeded(statusPath)', 'half-switched Claude slots should be repaired during hydrate/preflight/run')
  assertIncludes(server, "repairedRunnerConfig: repaired ? 'claude' : null", 'incubator payload should disclose automatic Claude runner repair')
  assertIncludes(server, "const { status: cfg } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)", 'incubator preflight/run paths should use repaired Claude runner status')
  assertIncludes(server, 'if (next.claudeModel !== setup.model)', 'half-switched Claude slots should persist the repaired safe model')
  assertIncludes(server, 'Claude relay selected but blocked:', 'Claude relay selection should persist and clearly say when launch preflight is blocked')
  assertIncludes(server, 'appendRunnerSwitchPreflightFailure({', 'Claude switch launch blocks should write a visible failed history row')
  assertIncludes(server, 'historyRecorded = true', 'runner switch responses should disclose when history was written')
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
  assertIncludes(server, "const DEFAULT_CLAUDE_MODEL = process.env.PI_PULSE_DEFAULT_CLAUDE_MODEL || SAFE_CLAUDE_MODEL", 'Claude setup should fall forward to a stable alias instead of the bad CLI default')
  assertIncludes(server, 'SAFE_CLAUDE_MODEL', 'Claude setup should share the same safe fallback model as preflight')
  assertIncludes(panel, 'if (d.slot) setIncubators(prev => prev.map(item => item.id === slot.id ? d.slot : item))', 'successful relay switches should update the selected slot immediately')
  assertIncludes(panel, 'await fetchSlotRuns(slot.id)', 'relay switches should immediately refresh the selected slot history after preflight state changes')
  assertIncludes(panel, 'd.preflight || d.setup', 'relay switch UI should prefer returned launch preflight over setup-only diagnostics')
  assertIncludes(panel, 'data-runner-relay-detail={activeSlot.id}', 'selected incubator should expose auditable runner relay details')
  assertIncludes(panel, 'data-runner-switch-receipt={activeSlot.id}', 'selected incubator should expose a durable runner switch receipt')
  assertIncludes(panel, "data-runner-launch-ok={selectedRunnerLaunchOk ? 'true' : 'false'}", 'runner switch receipt should disclose whether the selected runner can launch')
  assertIncludes(panel, 'data-last-run-failure={activeSlot.id}', 'selected incubator should expose the last failed run detail outside the timeline')
  assertIncludes(panel, 'Last run failed', 'selected incubator should visibly label a failed last run')
  assertIncludes(panel, 'Claude selected, launch blocked', 'selected Claude should remain visibly selected even when launch preflight blocks it')
  assertIncludes(panel, 'Claude selected and launchable', 'successful Claude switches should have a clear launchable receipt')
  assertIncludes(panel, 'function shortCommand(value = \'\')', 'selected incubator should trim long command previews without dropping them')
  assertIncludes(panel, 'activePreflight?.command ? `command: ${shortCommand(activePreflight.command)}` : null', 'selected incubator should show the exact command preflight will launch')
  assertIncludes(panel, 'relay: ${shortPath(activeSlot.claudeRelayScript || activeSlot.relayScript || claudeSetup?.expectedScript)}', 'Claude relay details should show the actual relay path, not just the launcher')
  assertIncludes(panel, "model: ${activeSlot.claudeModel || claudeSetup?.model || 'Claude CLI default'}", 'Claude relay details should show the persisted model/default')
  assertIncludes(panel, 'data-runner-setup="claude"', 'project panel should render a persistent Claude setup diagnostic')
  assertIncludes(panel, 'Claude setup incomplete', 'Claude setup failure should be visible near the relay switch')
  assertIncludes(panel, 'relay switch preflight', 'Claude setup panel should identify that the relay switch is blocked')
  assertIncludes(panel, 'const [historyErrorsBySlot, setHistoryErrorsBySlot] = useState({})', 'run history load failures should have explicit UI state')
  assertIncludes(panel, 'if (!res.ok || d.ok === false)', 'incubator run API errors should not collapse into empty history')
  assertIncludes(panel, 'setRunsBySlot(prev => ({ ...prev, [id]: [] }))', 'history load failures should clear stale rows for the selected slot')
  assertIncludes(panel, 'data-run-history-error={activeSlot.id}', 'selected incubator history errors should be visible to browser tests')
  assertIncludes(panel, 'history unavailable', 'run history panel should tell the user when the log cannot be loaded')
  assertIncludes(server, "res.status(500).json({", 'incubator run history read failures should return an explicit failed API response')
  assertIncludes(server, 'statusPath: slot.statusPath', 'incubator history errors should include the status path for diagnosis')
  assertIncludes(server, 'function writeIncubatorLauncher', 'new incubators should get their own project launcher script')
  assertIncludes(server, 'status.launcher = writeIncubatorLauncher({ slug, statusPath }).path', 'new incubator status should record the launcher path')
  assertIncludes(server, 'if (current !== content)', 'generated incubator launchers should be rewritten when stale')
  assertIncludes(server, 'return { path: launcherPath, repaired }', 'launcher repair should be visible to normalization')
  assertIncludes(server, 'exec ${GENERIC_CLAUDE_INCUBATOR_SCRIPT} "$STATUS_PATH" "$RUN_TYPE"', 'the project launcher should delegate Claude runs to the generic Claude relay')
}

function testFailedRunsDoNotAutoRegenerateFeedback() {
  const first = latestCompletedRunSignature([
    { num: 1, date: '2026-07-04', type: 'MUTATE', 'What I changed': 'tightened run history', signature: 'ok-1' },
  ])
  const afterFailure = latestCompletedRunSignature([
    { num: 1, date: '2026-07-04', type: 'MUTATE', 'What I changed': 'tightened run history', signature: 'ok-1' },
    { num: 2, date: '2026-07-04', type: 'FAILED', Failure: '[run failed - exit 127]', detail: 'codex not found', signature: 'failed-2' },
  ])
  const afterCompleted = latestCompletedRunSignature([
    { num: 1, date: '2026-07-04', type: 'MUTATE', 'What I changed': 'tightened run history', signature: 'ok-1' },
    { num: 2, date: '2026-07-04', type: 'FAILED', Failure: '[run failed - exit 127]', detail: 'codex not found', signature: 'failed-2' },
    { num: 3, date: '2026-07-04', type: 'RESEARCH', 'What I found': 'next trust fixture', signature: 'ok-3' },
  ])

  assert.equal(first, 'ok-1')
  assert.equal(afterFailure, first, 'FAILED rows should stay visible without auto-refreshing local critic feedback')
  assert.equal(afterCompleted, 'ok-3', 'completed runs should still trigger a fresh local critic signal')
}

function testNoSummaryCompletedRowsTriggerFeedbackSignal() {
  const noSummary = latestCompletedRunSignature([
    {
      num: 4,
      date: '2026-07-04',
      type: 'MUTATE',
      Done: 'Claude completed but did not append a run summary.',
      'Output excerpt': 'Selected Claude relay and captured useful stdout.',
    },
  ])
  const stdoutOnly = latestCompletedRunSignature([
    {
      num: 5,
      date: '2026-07-04',
      type: 'MUTATE',
      Done: 'Claude completed but did not append a run summary.',
      Output: 'Full stdout saved to /tmp/stdout/claude-run-5.log',
    },
  ])

  assertIncludes(noSummary, 'Selected Claude relay', 'no-summary rows should use output excerpt as the completion signal')
  assertIncludes(stdoutOnly, 'Full stdout saved to /tmp/stdout/claude-run-5.log', 'stdout-only no-summary rows should still trigger per-incubator feedback after completion')
}

function testFailedHistoryRowsExposeExpandableDetail() {
  const displayRuns = [
    { num: 3, date: '2026-07-04', type: 'MUTATE', 'What I changed': 'recovered', signature: 'ok-3' },
    { num: 2, date: '2026-07-04', type: 'FAILED', Failure: '[run failed - exit 127]', detail: 'bash: line 7: codex: command not found\nexit status 127', signature: 'failed-2' },
    { num: 1, date: '2026-07-04', type: 'RESEARCH', 'What I found': 'baseline', signature: 'ok-1' },
  ]
  const defaultOpenFailureKey = newestFailedRunKey(displayRuns, 'core')
  const openHtml = renderToStaticMarkup(h(RunHistoryList, {
    displayRuns,
    slotId: 'core',
    expandedFailureKeys: {},
    defaultOpenFailureKey,
  }))

  assertIncludes(openHtml, 'data-run-type="FAILED"', 'rendered history should mark FAILED rows')
  assertIncludes(openHtml, 'data-latest-failure="true"', 'run history should render a top-level latest failure callout')
  assertIncludes(openHtml, 'latest failure', 'latest failure callout should be visibly labeled')
  assertIncludes(openHtml, 'Open latest failure detail for run 2', 'latest failure callout should target the failed run detail')
  assertIncludes(openHtml, 'data-failure-open="true"', 'FAILED row should expose open state for browser tests')
  assertIncludes(openHtml, 'Toggle failure detail for run 2', 'FAILED detail toggle should have a specific accessible label')
  assertIncludes(openHtml, 'aria-expanded="true"', 'newest FAILED history detail should default open by run key')
  assertIncludes(openHtml, 'codex: command not found', 'FAILED history row should render the command error')
  assertIncludes(openHtml, 'exit status 127', 'expanded FAILED history detail should render full command output')

  const collapsedHtml = renderToStaticMarkup(h(RunHistoryList, {
    displayRuns,
    slotId: 'core',
    expandedFailureKeys: { [defaultOpenFailureKey]: false },
    defaultOpenFailureKey,
  }))
  assertIncludes(collapsedHtml, 'aria-expanded="false"', 'FAILED detail button should reflect collapsed state')
  assert.ok(!collapsedHtml.includes('<pre'), 'collapsed FAILED detail should not render the full preformatted output')
  assert.equal(failureSignal(displayRuns[1].detail), 'bash: line 7: codex: command not found')

  let toggledState = null
  const tree = RunHistoryList({
    displayRuns,
    slotId: 'core',
    expandedFailureKeys: { [defaultOpenFailureKey]: true },
    defaultOpenFailureKey,
    setExpandedFailureKeys: updater => { toggledState = updater({ [defaultOpenFailureKey]: true }) },
  })
  const toggle = findReactElement(tree, node => node.props?.['data-failure-toggle'] === defaultOpenFailureKey)
  assert.equal(toggle?.type, 'button', 'FAILED detail should render a real button control')
  toggle.props.onClick()
  assert.equal(toggledState[defaultOpenFailureKey], false, 'FAILED detail button click should collapse the expanded row')

  const calloutTree = RunHistoryList({
    displayRuns,
    slotId: 'core',
    expandedFailureKeys: { [defaultOpenFailureKey]: false },
    defaultOpenFailureKey,
    setExpandedFailureKeys: updater => { toggledState = updater({ [defaultOpenFailureKey]: false }) },
  })
  const callout = findReactElement(calloutTree, node => node.props?.['data-latest-failure'] === 'true')
  assert.equal(callout?.type, 'button', 'latest failure callout should be a real button control')
  callout.props.onClick()
  assert.equal(toggledState[defaultOpenFailureKey], true, 'latest failure callout should reopen the failed row detail')
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

function testLatestFailureStaysPinnedAfterManyLaterRuns() {
  const runs = [
    { num: 1, date: '2026-07-04', type: 'FAILED', Failure: 'claude binary: claude not found in PATH', signature: 'failed-1' },
    ...Array.from({ length: 12 }, (_, i) => ({
      num: i + 2,
      date: '2026-07-04',
      type: 'MUTATE',
      'What I changed': `completed run ${i + 2}`,
      signature: `ok-${i + 2}`,
    })),
  ]

  const pinned = runsWithPinnedLatestFailure(runs, 10)
  assert.equal(pinned.length, 11, 'history payload should include the latest failure plus recent successful runs')
  assert.equal(pinned[0].type, 'FAILED', 'latest failure should be pinned even when it is older than the recent limit')
  assert.equal(pinned[0].Failure, 'claude binary: claude not found in PATH')
  assert.equal(pinned.at(-1).num, 13)

  const panel = fs.readFileSync(join(root, 'src', 'components', 'ProjectPanel.jsx'), 'utf8')
  assertIncludes(panel, 'function selectedHistoryRuns(runs = [], limit = 5)', 'project panel should keep a local pinned-failure display helper')
  assertIncludes(panel, "const latestFailure = [...runs].reverse().find(run => run?.type === 'FAILED')", 'selected history should search beyond the latest five rows')
  assertIncludes(panel, 'return [...recent, latestFailure]', 'selected history should include the pinned failure in the visible rows')
  assertIncludes(panel, 'selectedHistoryRuns(activeSlot.runs || []).reverse()', 'active run history should render the pinned failure with recent rows')
  assertIncludes(panel, 'data-history-failure-receipt={activeSlot.id}', 'run history should disclose that a failure is visible before the expanded rows')
  assertIncludes(panel, "run #{latestDisplayedFailure.num ?? '?'} is {latestDisplayedFailurePinned ? 'pinned with recent history' : 'inside recent history'}", 'history receipt should say whether the visible failure was pinned from outside recent rows')
  assertIncludes(panel, 'expands below', 'history failure receipt should point to the expanded failure detail')

  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  assertIncludes(server, 'runsWithPinnedLatestFailure(parseRunsFromLog(content), 10)', 'host run API should preserve the latest failure outside the recent window')
  assertIncludes(server, 'runsWithPinnedLatestFailure(parseChildRuns(content), 10)', 'project run APIs should preserve the latest failure outside the recent window')
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
    'Full stdout saved to /tmp/stdout/codex-run-21.log',
    'no-summary rows should prefer stdout metadata over the generic completed-without-summary text'
  )
  assertIncludes(
    runs[0].signature,
    'Full stdout saved to /tmp/stdout/codex-run-21.log',
    'stdout fallback should feed run signatures instead of generic no-summary text'
  )
}

function testNoSummaryRowsExposeExpandableStdoutDetail() {
  const run = {
    num: 12,
    date: '2026-07-04',
    type: 'MUTATE',
    Done: 'Claude completed but did not append a run summary.',
    'Output excerpt': 'Built the missing relay switch diagnostics.',
    'Stdout tail': 'Built the missing relay switch diagnostics.\nWrote the trust fixture.',
    Output: 'Full stdout saved to /tmp/stdout/claude-run-12.log',
    signature: 'stdout-detail-12',
  }
  const html = renderToStaticMarkup(h(RunHistoryList, {
    displayRuns: [run],
    slotId: 'fresh-slot',
    expandedFailureKeys: { [runHistoryKey('fresh-slot', run, 0)]: true },
  }))

  assertIncludes(runOutputDetail(run), 'Wrote the trust fixture.', 'stdout-backed rows should expose hydrated output detail')
  assertIncludes(html, 'data-stdout-open="true"', 'stdout-backed non-failed rows should expose open state for browser tests')
  assertIncludes(html, 'Toggle stdout detail for run 12', 'stdout detail toggle should have a specific accessible label')
  assertIncludes(html, 'stdout: /tmp/stdout/claude-run-12.log', 'collapsed stdout detail should show the saved stdout file path')
  assertIncludes(html, 'Full stdout saved to /tmp/stdout/claude-run-12.log', 'expanded stdout detail should show the saved stdout path')
  assert.equal(outputSignal(runOutputDetail(run)), 'stdout: /tmp/stdout/claude-run-12.log')
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

  const runs = parseRunsFromLog(content)
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

  const runs = parseRunsFromLog(content)
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

  const runs = parseRunsFromLog(content)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'FAILED')
  assertIncludes(runs[0].Failure, 'API Error: model fable not found', 'saved stdout failures should mark the formal row FAILED')
  assertIncludes(runFailureDetail(runs[0]), 'The process exited before writing a summary.', 'expanded failure detail should include saved stdout tail')
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
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
  assertIncludes(server, "const launchBlocked = runner === 'claude' && preflight && !preflight.ok", 'Claude switch responses should check launch preflight, not only setup')
  assertIncludes(server, 'Claude relay selected but launch preflight blocked:', 'Claude switch warning should name launch preflight blocks')
  assertIncludes(server, 'preflightFailureDetail(preflight)', 'Claude switch warning should include concrete failed checks')
  assertIncludes(server, 'appendRunnerSwitchPreflightFailure({', 'blocked Claude switch preflights should be durable in history')
  assertIncludes(server, 'historyRecorded,', 'Claude switch responses should tell the UI when a failure row was written')
  assertIncludes(server, 'repaired: result.repaired ?? false', 'runner switch responses should disclose legacy status repair')
  assertIncludes(server, 'const hydratedSlot = hydrateIncubator(slot)\n  const warning = launchBlocked', 'Claude switch responses should hydrate the slot after any failed-history receipt is written')
  const panel = fs.readFileSync(join(root, 'src', 'components', 'ProjectPanel.jsx'), 'utf8')
  assertIncludes(panel, 'const keepNotice = d.historyRecorded || String(d.warning || \'\').includes(\'blocked\')', 'blocked Claude switch notices should stay visible after writing history')
  assertIncludes(panel, 'if (!keepNotice)', 'successful runner notices may still clear without hiding blocked relay failures')
  assertIncludes(panel, 'runnerReceiptsBySlot', 'runner switches should keep a concrete UI receipt after the async refresh')
  assertIncludes(panel, 'data-runner-switch-receipt-detail', 'runner switch receipts should be renderable for browser checks')
  assertIncludes(panel, 'data-runner-switch-history-recorded', 'blocked Claude switch receipts should disclose when a FAILED history row was written')
  assertIncludes(panel, 'command: {shortCommand(runnerReceipt.command)}', 'runner switch receipts should show the exact launch command that preflight evaluated')
}

function testTrustHarnessRunsBeforeBuild() {
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts?.['test:trust'] || '',
    /node scripts\/trust-fixtures\.mjs\s*&&\s*node scripts\/trust-smoke\.mjs/,
    'npm run test:trust must run source fixtures and live HTTP smoke'
  )
  assert.match(
    pkg.scripts?.build || '',
    /npm run test:trust\s*&&\s*vite build/,
    'npm run build must run trust fixtures before producing a bundle'
  )
}

function testStaleSourceMutationsAreWriteGated() {
  const server = fs.readFileSync(join(root, 'server.js'), 'utf8')
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

  const runs = parseRunsFromLog(log)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].type, 'MUTATE')
  assert.ok(!runs[0].Failure, 'dependency package names must not become failure summaries')
  assertIncludes(runs[0]['Output excerpt'], 'Implemented Run 15 mutation', 'stdout excerpt should prefer useful transcript lines over dependency inventory')
}

const tests = [
  testStdoutFailedRunsShowCommandError,
  testCapturedFailureDetailIsReusableForStatusReceipts,
  testScheduledPreflightPersistsUsefulFailureDetail,
  testManualPreflightPersistsUsefulFailureDetail,
  testPreflightBlocksBadCodexRunBeforeLaunch,
  testClaudePreflightUsesConfiguredBinaryFallback,
  testClaudePreflightChecksLauncherBackedRelay,
  testStaleClaudeFableFallsThrough,
  testFreshIncubatorsHaveGenericClaudeRunner,
  testExistingIncubatorsNormalizeClaudeRelayState,
  testStdoutOnlyApiErrorsBecomeFailedRows,
  testStdoutBoldFailedRowsDoNotNeedErrorText,
  testFormalNoSummaryApiErrorsBecomeFailedRows,
  testPerIncubatorAiFeedbackShape,
  testApiFallbackCannotServeSpaHtml,
  testFeedbackSwitchingReadsLatestWithoutRegenerating,
  testAiStripKeepsPerSlotClientCache,
  testSlotSwitchingHasBrowserStableDomHooks,
  testProjectPanelApiJsonErrorsStayVisible,
  testCachedAiLatestEndpointsHydrateLegacyFiles,
  testPreflightBlockedLaunchLooksBlocked,
  testFailedRunsDoNotAutoRegenerateFeedback,
  testNoSummaryCompletedRowsTriggerFeedbackSignal,
  testFailedHistoryRowsExposeExpandableDetail,
  testNewestFailedRowStaysOpenBelowCompletedRun,
  testLatestFailureStaysPinnedAfterManyLaterRuns,
  testFormalParagraphRunsKeepReadableSummary,
  testClaudeNoSummaryRowsShowOutputExcerpt,
  testNoSummaryRowsPreferStdoutOverGenericDone,
  testNoSummaryRowsExposeExpandableStdoutDetail,
  testFormalRowsHydrateSavedStdoutFile,
  testFormalRowsHydrateStdoutPathFromExcerpt,
  testFormalRowsFailFromSavedStdoutFile,
  testDependencyErrorPackageNamesDoNotCreateFailedRows,
  testProjectSummaryBeatsSyntheticNoSummaryDuplicate,
  testFormalFailedRowsExposeAllDiagnostics,
  testClaudeRunnerSwitchWarnsFromLaunchPreflight,
  testTrustHarnessRunsBeforeBuild,
  testStaleSourceMutationsAreWriteGated,
]

for (const test of tests) {
  await test()
  console.log(`ok - ${test.name}`)
}
