import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address?.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function seedLabFixture() {
  const labRoot = fs.mkdtempSync(join(os.tmpdir(), 'pi-pulse-smoke-lab-'))
  const projectsDir = join(labRoot, 'projects')
  const coreProjectDir = join(projectsDir, 'pi-pulse')
  const promptsDir = join(labRoot, 'prompts')
  const binDir = join(labRoot, 'bin')
  fs.mkdirSync(coreProjectDir, { recursive: true })
  fs.mkdirSync(promptsDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })

  const runLogPath = join(labRoot, 'RUN_LOG.md')
  const statusPath = join(coreProjectDir, 'status.json')
  const feedbackJson = join(labRoot, 'DRIFT_FEEDBACK.json')
  const freshRepo = join(labRoot, 'fresh-slot-repo')
  const freshPrompts = join(freshRepo, 'prompts')
  const freshReports = join(freshRepo, 'reports')
  const freshProjectDir = join(projectsDir, 'fresh-slot')
  const freshStatusPath = join(freshProjectDir, 'status.json')
  const freshLauncher = join(freshProjectDir, 'run-fresh-slot.sh')
  const freshRunLog = join(freshReports, 'RUN_LOG.md')
  const sourceProbe = join(labRoot, 'source-probe.txt')
  const staleExistingClaudeRunner = join(labRoot, 'old-fresh-claude-runner.sh')
  const staleRepo = join(labRoot, 'stale-claude-repo')
  const stalePrompts = join(staleRepo, 'prompts')
  const staleReports = join(staleRepo, 'reports')
  const staleProjectDir = join(projectsDir, 'stale-claude-slot')
  const staleStatusPath = join(staleProjectDir, 'status.json')
  const staleLauncher = join(staleProjectDir, 'run-stale-claude-slot.sh')
  const staleRunLog = join(staleReports, 'RUN_LOG.md')
  const blockedRepo = join(labRoot, 'blocked-claude-repo')
  const blockedPrompts = join(blockedRepo, 'prompts')
  const blockedReports = join(blockedRepo, 'reports')
  const blockedProjectDir = join(projectsDir, 'blocked-claude-slot')
  const blockedStatusPath = join(blockedProjectDir, 'status.json')
  const blockedRunLog = join(blockedReports, 'RUN_LOG.md')

  fs.writeFileSync(join(promptsDir, 'mutate.md'), 'fixture mutate prompt\n')
  fs.writeFileSync(join(binDir, 'claude'), '#!/usr/bin/env bash\necho fake claude\n')
  fs.chmodSync(join(binDir, 'claude'), 0o755)
  fs.mkdirSync(freshPrompts, { recursive: true })
  fs.mkdirSync(freshReports, { recursive: true })
  fs.mkdirSync(freshProjectDir, { recursive: true })
  fs.mkdirSync(stalePrompts, { recursive: true })
  fs.mkdirSync(staleReports, { recursive: true })
  fs.mkdirSync(staleProjectDir, { recursive: true })
  fs.mkdirSync(blockedRepo, { recursive: true })
  fs.mkdirSync(blockedReports, { recursive: true })
  fs.mkdirSync(blockedProjectDir, { recursive: true })
  fs.writeFileSync(blockedPrompts, 'not a prompt directory\n')
  fs.writeFileSync(join(freshPrompts, 'create.md'), 'fixture create prompt\n')
  fs.writeFileSync(join(stalePrompts, 'mutate.md'), 'fixture mutate prompt\n')
  fs.writeFileSync(staleExistingClaudeRunner, '#!/usr/bin/env bash\necho stale fresh claude runner\n')
  fs.chmodSync(staleExistingClaudeRunner, 0o755)
  fs.writeFileSync(freshLauncher, `#!/usr/bin/env bash
set -euo pipefail
STATUS_PATH="\${1:-${freshStatusPath}}"
RUN_TYPE="\${2:-}"
RUNNER=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.runner || 'codex')" "$STATUS_PATH")
if [ "$RUNNER" = "claude" ]; then
  exec ${join(root, 'scripts', 'run-claude-incubator.sh')} "$STATUS_PATH" "$RUN_TYPE"
fi
echo fake codex launcher
`)
  fs.chmodSync(freshLauncher, 0o755)
  fs.writeFileSync(freshRunLog, '# Run Log\n\n')
  fs.writeFileSync(staleRunLog, '# Run Log\n\n')
  fs.writeFileSync(blockedRunLog, '# Run Log\n\n')
  fs.writeFileSync(sourceProbe, 'boot source probe\n')
  fs.writeFileSync(join(labRoot, 'DAILY_SEED.md'), '# Daily Seed\n\nTrust fixture.\n')
  fs.writeFileSync(runLogPath, [
    '# Run Log',
    '',
    '<!-- stdout from run 114 2026-07-04 server-captured -->',
    '[run failed - exit 127] bash: line 7: codex: command not found | exit status 127',
    '**Run 114 - FAILED - server capture**',
    '',
  ].join('\n'))
  fs.writeFileSync(statusPath, JSON.stringify({
    project: 'pi-pulse',
    runCount: 113,
    runScript: '/missing/run-codex-incubator.sh',
    repo: labRoot,
    runLog: runLogPath,
    promptDir: promptsDir,
    runTypes: ['mutate'],
    runner: 'codex',
  }, null, 2) + '\n')
  fs.writeFileSync(freshStatusPath, JSON.stringify({
    project: 'fresh-slot',
    runner: 'codex',
    repo: freshRepo,
    runLog: freshRunLog,
    runScript: freshLauncher,
    launcher: freshLauncher,
    promptDir: freshPrompts,
    runTypes: ['create'],
    runCount: 0,
    claudeModel: 'fable',
    claudeRunScript: staleExistingClaudeRunner,
  }, null, 2) + '\n')
  fs.writeFileSync(staleStatusPath, JSON.stringify({
    project: 'stale-claude-slot',
    runner: 'claude',
    repo: staleRepo,
    runLog: staleRunLog,
    runScript: join(labRoot, 'missing-stale-claude-runner.sh'),
    promptDir: stalePrompts,
    runTypes: ['mutate'],
    runCount: 0,
    claudeModel: 'fable',
    claudeRunScript: join(labRoot, 'missing-stale-claude-runner.sh'),
  }, null, 2) + '\n')
  fs.writeFileSync(blockedStatusPath, JSON.stringify({
    project: 'blocked-claude-slot',
    runner: 'codex',
    repo: blockedRepo,
    runLog: blockedRunLog,
    runScript: join(blockedProjectDir, 'run-blocked-claude-slot.sh'),
    promptDir: blockedPrompts,
    runTypes: ['mutate'],
    runCount: 0,
  }, null, 2) + '\n')
  fs.writeFileSync(feedbackJson, JSON.stringify({
    ok: true,
    incubatorId: 'core',
    project: 'pi-pulse',
    raw: [
      'DIRECTION: keep failure state visible.',
      'STRONGEST: the smoke runs against fixtures.',
      'WEAKEST: browser automation is not installed.',
      'DRIFT: no - this targets trust per run.',
      'NEXT: add rendered expansion coverage when a browser is available.',
    ].join('\n'),
    model: 'qwen2.5-instruct:1.5b',
    ts: 123,
  }, null, 2) + '\n')
  fs.writeFileSync(join(projectsDir, 'incubators.json'), JSON.stringify({
    slots: [
      {
        id: 'fresh-slot',
        type: 'project',
        statusPath: freshStatusPath,
        enabled: false,
        intervalHours: 0.5,
        nextRunAt: null,
        lastScheduledRun: null,
        autoRunsSinceHuman: 0,
      },
      {
        id: 'stale-claude-slot',
        type: 'project',
        statusPath: staleStatusPath,
        enabled: false,
        intervalHours: 0.5,
        nextRunAt: null,
        lastScheduledRun: null,
        autoRunsSinceHuman: 0,
      },
      {
        id: 'blocked-claude-slot',
        type: 'project',
        statusPath: blockedStatusPath,
        enabled: false,
        intervalHours: 0.5,
        nextRunAt: null,
        lastScheduledRun: null,
        autoRunsSinceHuman: 0,
      },
    ],
  }, null, 2) + '\n')

  return {
    labRoot,
    projectsDir,
    runLogPath,
    statusPath,
    freshStatusPath,
    freshLauncher,
    freshRepo,
    staleStatusPath,
    staleLauncher,
    blockedStatusPath,
    env: {
      PI_PULSE_LAB_ROOT: labRoot,
      PI_PULSE_PROJECTS_DIR: projectsDir,
      PI_PULSE_RUN_LOG_PATH: runLogPath,
      PI_PULSE_PROJECT_STATUS_PATH: statusPath,
      PI_PULSE_LAB_SCHEDULE_PATH: join(coreProjectDir, 'schedule.json'),
      PI_PULSE_RUN_CAPTURE_DIR: join(projectsDir, '.run-capture'),
      PI_PULSE_DAILY_SEED_PATH: join(labRoot, 'DAILY_SEED.md'),
      PI_PULSE_CORE_SEED_PATH: join(coreProjectDir, 'seed.md'),
      PI_PULSE_CORE_FEEDBACK_JSON: feedbackJson,
      PI_PULSE_CORE_FEEDBACK_MD: join(labRoot, 'DRIFT_FEEDBACK.md'),
      PI_PULSE_USER_FEEDBACK_PATH: join(labRoot, 'USER_FEEDBACK.md'),
      PI_PULSE_MOUNTED_CONFIG_PATH: join(projectsDir, 'mounted.json'),
      PI_PULSE_INCUBATORS_PATH: join(projectsDir, 'incubators.json'),
      PI_PULSE_CHILD_SCHEDULE_PATH: join(projectsDir, 'schedule.json'),
      PI_PULSE_SOURCE_HEALTH_FILES: sourceProbe,
      PI_PULSE_ADMIN_TOKEN: 'smoke-token',
      CLAUDE_BIN: join(binDir, 'claude'),
      PATH: `${binDir}:${process.env.PATH || ''}`,
    },
    sourceProbe,
  }
}

async function fetchJson(baseUrl, path, options = undefined) {
  const response = await fetch(baseUrl + path, options)
  const text = await response.text()
  const contentType = response.headers.get('content-type') || ''
  assert.match(contentType, /application\/json/, `${path} should return JSON, got ${contentType || 'no content-type'}`)
  try {
    return { response, data: JSON.parse(text) }
  } catch {
    assert.fail(`${path} returned non-JSON: ${text.slice(0, 80)}`)
  }
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited before health check\n${output()}`)
    }
    try {
      const { response, data } = await fetchJson(baseUrl, '/api/health')
      if (response.ok && data.ok) return
    } catch {
      // Keep polling until the server accepts connections.
    }
    await delay(150)
  }
  throw new Error(`server did not become healthy\n${output()}`)
}

async function waitForJsonCondition(baseUrl, child, output, path, predicate, label) {
  const deadline = Date.now() + 8000
  let lastData = null
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited while waiting for ${label}\n${output()}`)
    }
    try {
      const { data } = await fetchJson(baseUrl, path)
      lastData = data
      if (predicate(data)) return data
    } catch {
      // Keep polling while the detached runner updates project files.
    }
    await delay(150)
  }
  throw new Error(`timed out waiting for ${label}; last payload: ${JSON.stringify(lastData)}\n${output()}`)
}

async function main() {
  const port = await freePort()
  const fixture = seedLabFixture()
  const baseUrl = `http://127.0.0.1:${port}`
  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PI_PULSE_DISABLE_SCHEDULES: '1',
      ...fixture.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const output = () => [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')

  try {
    await waitForHealth(baseUrl, child, output)
    const writeHeaders = { 'Content-Type': 'application/json', 'X-Pi-Pulse-Admin-Token': 'smoke-token' }

    const health = await fetchJson(baseUrl, '/api/health')
    assert.equal(health.data.ok, true)
    assert.equal(typeof health.data.startedAt, 'string', 'health should expose service start time')
    assert.equal(typeof health.data.uptimeSeconds, 'number', 'health should expose runtime age')
    assert.match(health.data.source?.fingerprint || '', /^[0-9a-f]{12}$/, 'health should expose a source fingerprint')
    assert.equal(health.data.source?.bootFingerprint, health.data.source?.fingerprint, 'fresh smoke server source should match boot fingerprint')
    assert.equal(health.data.source?.changedSinceStart, false, 'fresh smoke server should not report stale source')

    const missing = await fetchJson(baseUrl, '/api/this-route-should-not-exist')
    assert.equal(missing.response.status, 404)
    assert.equal(missing.data.ok, false)
    assert.equal(missing.data.error, 'api route not found')
    assert.equal(missing.data.path, '/api/this-route-should-not-exist')

    const preflight = await fetchJson(baseUrl, '/api/run/preflight?runner=codex')
    assert.equal(typeof preflight.data.ok, 'boolean')
    assert.ok(Array.isArray(preflight.data.checks), 'preflight should expose readiness checks')

    const runs = await fetchJson(baseUrl, '/api/runs')
    const failedRun = runs.data.find(run => run.num === 114)
    assert.equal(failedRun?.type, 'FAILED', 'stdout-only failed run should be marked FAILED')
    assert.match(failedRun?.Failure || '', /codex: command not found/, 'failure summary should expose command error')
    assert.match(failedRun?.detail || '', /exit status 127/, 'failure detail should keep command output')

    const coreAi = await fetchJson(baseUrl, '/api/incubators/core/ai/latest')
    assert.equal(coreAi.data.ok, true)
    assert.equal(coreAi.data.incubatorId, 'core')
    assert.equal(coreAi.data.source, 'local-ollama-qwen')
    assert.equal(coreAi.data.response, coreAi.data.raw)
    assert.equal(coreAi.data.malformed, false)
    assert.deepEqual(coreAi.data.missing, [])
    assert.equal(coreAi.data.fields.NEXT, 'add rendered expansion coverage when a browser is available.')

    const legacyCoreAi = await fetchJson(baseUrl, '/api/ai/latest')
    assert.equal(legacyCoreAi.data.source, 'local-ollama-qwen')
    assert.equal(legacyCoreAi.data.fields.WEAKEST, 'browser automation is not installed.')

    const incubators = await fetchJson(baseUrl, '/api/incubators')
    assert.equal(incubators.data.ok, true)
    assert.ok(Array.isArray(incubators.data.slots), 'incubators endpoint should expose slots')
    const freshSlot = incubators.data.slots.find(slot => slot.id === 'fresh-slot')
    assert.equal(freshSlot?.runnerSetups?.claude?.ok, true, 'fresh slot should have a ready generic Claude setup with fake claude')
    assert.equal(freshSlot?.launchScript, fixture.freshLauncher, 'fresh slot payload should expose its project launcher')
    assert.match(freshSlot?.claudeRelayScript || '', /run-claude-incubator\.sh/, 'fresh slot payload should expose the Claude relay script')
    const staleSlot = incubators.data.slots.find(slot => slot.id === 'stale-claude-slot')
    assert.equal(staleSlot?.runner, 'claude', 'half-switched Claude slots should stay on the selected relay')
    assert.equal(staleSlot?.runnerSetups?.claude?.ok, true, 'half-switched Claude slots should be repaired during hydration')
    assert.equal(staleSlot?.repairedRunnerConfig, 'claude', 'hydration should disclose that stale Claude runner config was repaired')
    const repairedStaleStatus = JSON.parse(fs.readFileSync(fixture.staleStatusPath, 'utf8'))
    assert.equal(repairedStaleStatus.runScript, fixture.staleLauncher, 'stale Claude runScript should be repaired to the project launcher')
    assert.match(repairedStaleStatus.claudeRunScript, /run-claude-incubator\.sh/, 'stale Claude relay script should be repaired to the generic runner')
    assert.equal(repairedStaleStatus.claudeModel, 'sonnet', 'stale Claude fable pin should be repaired to the safe Sonnet alias')

    const stalePreflight = await fetchJson(baseUrl, '/api/incubators/stale-claude-slot/preflight')
    assert.equal(stalePreflight.data.ok, true, 'repaired half-switched Claude slot should pass generic preflight with fake claude')

    const fakeCfWrite = await fetchJson(baseUrl, '/api/incubators/fresh-slot/runner', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.10',
        'Cf-Access-Authenticated-User-Email': 'fake@example.com',
      },
      body: JSON.stringify({ runner: 'claude' }),
    })
    assert.equal(fakeCfWrite.response.status, 401, 'fake Cloudflare Access headers should not grant write access by default')
    assert.equal(fakeCfWrite.data.code, 'WRITE_AUTH_REQUIRED')

    const switched = await fetchJson(baseUrl, '/api/incubators/fresh-slot/runner', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ runner: 'claude' }),
    })
    assert.equal(switched.response.status, 200)
    assert.equal(switched.data.ok, true)
    assert.equal(switched.data.slot.runner, 'claude')
    assert.equal(switched.data.slot.launchScript, fixture.freshLauncher, 'runner switch response should keep launcher visible separately from relay')
    assert.match(switched.data.slot.claudeRelayScript || '', /run-claude-incubator\.sh/, 'runner switch response should expose the selected Claude relay')
    assert.match(switched.data.slot.relayScript || '', /run-claude-incubator\.sh/, 'Claude-selected slots should expose active relayScript')
    assert.equal(switched.data.setup.runner, 'claude', 'runner switch response should include immediate Claude setup diagnostics')
    assert.equal(switched.data.preflight?.runner, 'claude', 'runner switch response should include immediate Claude launch preflight')
    assert.equal(switched.data.preflight?.ok, true, 'fresh Claude relay switch should return ready launch preflight')
    assert.equal(switched.data.preflight?.launcher, fixture.freshLauncher, 'fresh Claude preflight should keep the project launcher visible')
    assert.match(switched.data.preflight?.relayScript || '', /run-claude-incubator\.sh/, 'fresh Claude preflight should expose the selected relay script')
    assert.match(switched.data.preflight?.command || '', /bash .*run-fresh-slot\.sh .*fresh-slot\/status\.json/, 'fresh Claude preflight should expose the exact launcher command')
    assert.equal(switched.data.preflight?.checks?.find(check => check.id === 'relayScript')?.ok, true, 'fresh Claude preflight should verify the relay script')
    assert.match(switched.data.slot.runnerSetups.claude.script, /run-claude-incubator\.sh/)
    const freshStatus = JSON.parse(fs.readFileSync(fixture.freshStatusPath, 'utf8'))
    assert.equal(freshStatus.runner, 'claude')
    assert.equal(freshStatus.runScript, fixture.freshLauncher, 'fresh Claude relay switches should preserve the project launcher')
    assert.match(freshStatus.claudeRunScript, /run-claude-incubator\.sh/)
    assert.notEqual(freshStatus.claudeRunScript, join(fixture.labRoot, 'old-fresh-claude-runner.sh'))
    assert.notEqual(freshStatus.claudeModel, 'fable')
    assert.notEqual(freshStatus.claudeModel, 'claude-sonnet-4-20250514')
    assert.equal(freshStatus.claudeModel, 'sonnet', 'fresh Claude relay switches should persist the safe Sonnet alias')

    const freshPreflight = await fetchJson(baseUrl, '/api/incubators/fresh-slot/preflight')
    assert.equal(freshPreflight.data.ok, true, 'fresh slot generic Claude preflight should pass with fake claude and prompt')
    assert.equal(freshPreflight.data.launcher, fixture.freshLauncher, 'fresh slot preflight should distinguish launcher from relay')
    assert.match(freshPreflight.data.relayScript || '', /run-claude-incubator\.sh/, 'fresh slot preflight should expose selected Claude relay')
    assert.match(freshPreflight.data.command || '', /bash .*run-fresh-slot\.sh .*fresh-slot\/status\.json/, 'fresh slot preflight should report the command the run button will execute')

    const blockedSwitch = await fetchJson(baseUrl, '/api/incubators/blocked-claude-slot/runner', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ runner: 'claude' }),
    })
    assert.equal(blockedSwitch.response.status, 200)
    assert.equal(blockedSwitch.data.ok, true)
    assert.equal(blockedSwitch.data.slot.runner, 'claude', 'blocked Claude switches should still persist the selected relay')
    assert.equal(blockedSwitch.data.preflight?.ok, false, 'blocked Claude switches should return the failed launch preflight')
    assert.equal(blockedSwitch.data.historyRecorded, true, 'blocked Claude switches should write a visible history failure')
    assert.match(blockedSwitch.data.warning || '', /prompt/i, 'blocked Claude switch warning should include the failed check')
    const blockedHistory = await fetchJson(baseUrl, '/api/incubators/blocked-claude-slot/runs')
    const blockedRun = blockedHistory.data.runs.find(run => run.type === 'FAILED')
    assert.ok(blockedRun, 'blocked Claude switch should create a FAILED history row')
    assert.match(blockedRun.Failure || '', /runner switch preflight/, 'blocked switch history should identify the relay switch preflight')
    assert.match(blockedRun.detail || '', /prompt directory: not a dir/, 'blocked switch history should expose the invalid prompt detail')

    const launched = await fetchJson(baseUrl, '/api/incubators/fresh-slot/run', { method: 'POST', headers: writeHeaders })
    assert.equal(launched.response.status, 200)
    assert.equal(launched.data.ok, true)
    assert.equal(launched.data.runner, 'claude')

    const freshHistory = await waitForJsonCondition(
      baseUrl,
      child,
      output,
      '/api/incubators/fresh-slot/runs',
      data => Array.isArray(data.runs) && data.runs.some(run => run.num === 1 && run.type === 'CREATE' && /fake claude/.test(run['Output excerpt'] || run['What I changed'] || '')),
      'fresh Claude incubator history row'
    )
    const freshRun = freshHistory.runs.find(run => run.num === 1)
    assert.equal(freshRun.type, 'CREATE', 'fresh Claude run should use the first configured run type')
    assert.match(freshRun['Output excerpt'] || freshRun['What I changed'] || '', /fake claude/, 'fresh Claude run history should expose useful captured stdout')
    assert.match(freshRun.Output || '', /Full stdout saved to .*claude-run-1\.log/, 'fresh Claude run history should point to the saved stdout file')

    fs.writeFileSync(join(fixture.freshRepo, 'index.html'), '<!doctype html><title>Fresh Slot Play</title><h1>fresh static app</h1>\n')
    const incubatorsAfterStaticApp = await fetchJson(baseUrl, '/api/incubators')
    const slotWithPlay = incubatorsAfterStaticApp.data.slots.find(slot => slot.id === 'fresh-slot')
    assert.equal(slotWithPlay?.playUrl, '/fresh-slot/', 'fresh slot should expose playUrl after index.html appears')
    const play = await fetch(baseUrl + slotWithPlay.playUrl)
    const text = await play.text()
    assert.equal(play.status, 200, 'fresh slot playUrl should serve the static incubator app')
    assert.match(play.headers.get('content-type') || '', /text\/html/)
    assert.match(text, /Fresh Slot Play/, 'fresh slot playUrl should serve the project index.html')
    assert.ok(!text.includes('<title>Pi Pulse</title>'), 'fresh slot playUrl served the Pi Pulse SPA')

    fs.writeFileSync(fixture.sourceProbe, 'changed source probe\n')
    const staleHealth = await waitForJsonCondition(
      baseUrl,
      child,
      output,
      '/api/health',
      data => data.source?.changedSinceStart === true,
      'stale source health signal'
    )
    assert.equal(staleHealth.source.changedSinceStart, true, 'health should expose stale source before write gating')

    const blockedSchedule = await fetchJson(baseUrl, '/api/incubators/fresh-slot/schedule', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ enabled: true, intervalHours: 0.5 }),
    })
    assert.equal(blockedSchedule.response.status, 409, 'stale source should block incubator schedule writes')
    assert.equal(blockedSchedule.data.ok, false)
    assert.equal(blockedSchedule.data.code, 'STALE_SERVICE_SOURCE')
    assert.equal(blockedSchedule.data.source?.changedSinceStart, true)
    const unchangedIncubators = JSON.parse(fs.readFileSync(join(fixture.projectsDir, 'incubators.json'), 'utf8'))
    assert.equal(
      unchangedIncubators.slots.find(slot => slot.id === 'fresh-slot')?.enabled,
      false,
      'stale source write gate should leave incubator schedule state unchanged'
    )

    console.log('ok - live API trust smoke')
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(1000).then(() => child.kill('SIGKILL')),
    ])
    fs.rmSync(fixture.labRoot, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exit(1)
})
