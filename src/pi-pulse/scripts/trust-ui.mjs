// Behavioral UI contracts: the real JSX components are bundled with esbuild (a
// Vite dependency) and rendered to static markup, so these tests fail when the
// dashboard stops showing something, not when its source text changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadUi() {
  const entry = `
    export { createElement } from 'react'
    export { renderToStaticMarkup } from 'react-dom/server'
    export { RunTimeline, RunRow } from './src/components/RunTimeline.jsx'
    export { Roster } from './src/components/Roster.jsx'
    export { IncubatorDetail } from './src/components/IncubatorDetail.jsx'
    export { LoopHero } from './src/components/LoopHero.jsx'
    export { LoopDial } from './src/components/LoopDial.jsx'
    export { CriticView } from './src/components/Critic.jsx'
    export * as incubator from './src/lib/incubator.js'
    export * as history from './src/lib/runHistory.js'
    export * as api from './src/lib/api.js'
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    // react-dom/server is CommonJS and requires Node builtins at load time.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'pi-pulse-ui-')), 'ui.mjs')
  fs.writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const ui = await loadUi()
const render = (component, props) => ui.renderToStaticMarkup(ui.createElement(component, props))
const NOW = Date.parse('2026-09-26T12:00:00Z')
const noopActions = { run() {}, setSchedule() {}, setRunner() {}, sendFeedback() {}, create() {}, remove() {}, restartService() {} }

function includes(haystack, needle, message) {
  assert.ok(String(haystack).includes(needle), `${message}: expected markup to include ${JSON.stringify(needle)}`)
}

// The full opening tag of the first element carrying `attr`.
function tagWith(html, attr) {
  const at = html.indexOf(attr)
  assert.ok(at >= 0, `markup should contain ${attr}`)
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
}

function slot(overrides = {}) {
  return {
    id: 'proj',
    displayName: 'Proj',
    runner: 'codex',
    runCount: 4,
    runTypes: ['mutate', 'research', 'mutate'],
    enabled: false,
    intervalHours: 0.5,
    running: { running: false },
    runnerSetups: { claude: { ok: true, model: 'sonnet', permissionMode: 'auto', checks: [] } },
    ...overrides,
  }
}

const blockedPreflight = {
  ok: false,
  command: 'bash /lab/projects/proj/run-proj.sh /lab/projects/proj/status.json',
  checks: [
    { id: 'binary', label: 'codex binary', ok: true, detail: 'ok' },
    { id: 'promptDir', label: 'prompt directory', ok: false, detail: 'not a dir', path: '/repo/prompts' },
    { id: 'prompt', label: 'mutate prompt', ok: false, detail: 'not found', path: '/repo/prompts/mutate.md' },
  ],
}

const failedRuns = [
  { num: 1, date: '2026-09-25', type: 'RESEARCH', 'What I found': 'baseline', 'Quality gate': 'PASS', signature: 'ok-1' },
  { num: 2, date: '2026-09-26', type: 'FAILED', Failure: '[run failed - exit 127] bash: codex: command not found', detail: 'bash: line 7: codex: command not found\nexit status 127', signature: 'failed-2' },
  { num: 3, date: '2026-09-26', type: 'MUTATE', 'What I changed': 'recovered the relay', 'Quality gate': 'NEEDS-EVIDENCE', signature: 'ok-3' },
]

const tests = {
  'the newest failure is open by default and shows the command error'() {
    const html = render(ui.RunTimeline, { runs: failedRuns, slotId: 'proj' })
    includes(html, 'data-run-type="FAILED" data-detail-open="true"', 'the newest FAILED row must not need a click')
    includes(html, 'codex: command not found', 'the failed row shows the command error')
    includes(html, 'exit status 127', 'the expanded failure shows the captured output')
    assert.ok(!html.includes('[run failed'), 'the headline drops the runner marker; the raw text lives in the expanded detail only')
    includes(html, 'data-run-type="MUTATE" data-detail-open="false"', 'completed rows stay collapsed')
    assert.ok(html.indexOf('data-run-type="MUTATE"') < html.indexOf('data-run-type="FAILED"'), 'history is newest first')
  },

  'an unrecovered failure outside the window stays pinned'() {
    const runs = [
      { num: 1, date: '2026-09-20', type: 'FAILED', Failure: 'claude binary: claude not found in PATH', signature: 'f1' },
      ...Array.from({ length: 9 }, (_, i) => ({ num: i + 2, date: '2026-09-21', type: 'RUN', Done: `retry ${i}`, signature: `r${i}` })),
    ]
    const html = render(ui.RunTimeline, { runs, slotId: 'proj', limit: 8 })
    includes(html, 'data-pinned-failure="1"', 'an unresolved failure must not scroll out of sight')
    includes(html, 'claude not found in PATH', 'the pinned failure names its cause')

    const recovered = [runs[0], ...Array.from({ length: 9 }, (_, i) => ({ num: i + 2, date: '2026-09-21', type: 'MUTATE', 'Quality gate': 'PASS', signature: `m${i}` }))]
    assert.equal(ui.history.timelineRuns(recovered, 8).pinned, null, 'a later successful run recovers the old failure')
  },

  'history load errors are shown, never an empty timeline'() {
    const html = render(ui.RunTimeline, { runs: [], slotId: 'proj', error: '/api/incubators/proj/runs returned HTML instead of JSON (200 text/html)' })
    includes(html, 'role="alert"', 'history errors are announced')
    includes(html, 'returned HTML instead of JSON', 'the actual cause is visible')
  },

  'roster rows say what each incubator needs'() {
    const slots = [
      slot({ id: 'running', displayName: 'Running', running: { running: true, startTime: NOW - 65000, runner: 'claude' } }),
      slot({ id: 'blocked', displayName: 'Blocked' }),
      slot({ id: 'failed', displayName: 'Failed', lastRunStatus: 'failed', lastRunFailure: '[run failed - codex exited 1] API Error: 529 overloaded_error' }),
      slot({ id: 'paused', displayName: 'Paused', schedulePauseReason: 'schedule paused: 5 consecutive failed quality gates' }),
      slot({ id: 'scheduled', displayName: 'Scheduled', enabled: true, nextRunAt: NOW + 23 * 60000 }),
    ]
    const html = render(ui.Roster, {
      slots,
      selectedId: 'failed',
      onSelect() {},
      runsBySlot: { failed: failedRuns },
      preflightBySlot: { blocked: blockedPreflight },
      now: NOW,
      onCreate() {},
    })
    includes(html, 'data-incubator-row="running" data-incubator-state="running"', 'running rows are marked')
    includes(html, 'Incubating · 01:05', 'running rows show live elapsed time')
    includes(html, 'data-incubator-state="blocked"', 'a failing preflight blocks the row')
    includes(html, 'prompt directory: not a dir', 'blocked rows name the first failed check')
    includes(html, 'data-incubator-state="failed"', 'failed last runs are marked')
    includes(html, 'API Error: 529 overloaded_error', 'failed rows show the error itself')
    includes(html, 'data-incubator-state="paused"', 'paused autopilot is marked')
    includes(html, '5 consecutive failed quality gates', 'paused rows say why')
    includes(html, 'Next in 23m', 'scheduled rows show when the loop fires next')
    includes(html, 'aria-pressed="true" data-incubator-row="failed"', 'the selected row is exposed to assistive tech')
  },

  'a failing slot says it retries on its own; nothing waits for you'() {
    const failing = slot({ enabled: true, lastRunStatus: 'failed', lastRunFailure: '[run failed - codex exited 1] API Error: 529 overloaded_error', failStreak: 2, nextRunAt: NOW + 90 * 60000 })
    const html = render(ui.IncubatorDetail, { slot: failing, runs: failedRuns, preflight: { ok: true, checks: [] }, now: NOW, actions: noopActions })
    includes(html, 'data-retry="2"', 'the failure banner carries the retry state')
    includes(html, 'retries on its own in 1h 30m', 'the person is told there is nothing to do')
    includes(html, '2 in a row', 'the growing wait is explained')
    assert.ok(!html.includes('data-banner="needs-human"'), 'there is no to-do for a person')
    const judged = ui.incubator.slotState(slot({ enabled: true, lastRunStatus: 'quality-failed', failStreak: 2, backoffUntil: NOW + 3600000, nextRunAt: NOW + 3600000 }), { now: NOW })
    assert.equal(judged.detail, 'retrying after 2 failed runs', 'a slot backing off says why its next run is later')
    const off = render(ui.IncubatorDetail, { slot: { ...failing, enabled: false }, runs: failedRuns, preflight: { ok: true, checks: [] }, now: NOW, actions: noopActions })
    assert.ok(!off.includes('data-retry='), 'a slot you switched off does not promise a retry')
  },

  'the next step comes from the newest run, never a stale goal field'() {
    const runs = [
      { num: 7, date: '2026-09-25', type: 'MUTATE', 'What I changed': 'bigger deck', 'Next move': 'Give the Anchor Guard a readable wind-up telegraph.' },
      { num: 8, date: '2026-09-26', type: 'FAILED', Failure: 'API Error: 529', 'Next move': 'retry' },
    ]
    const html = render(ui.IncubatorDetail, { slot: slot({ next_run_goal: 'Run CREATE to turn this idea into the first usable local prototype.' }), runs, preflight: { ok: true, checks: [] }, now: NOW, actions: noopActions })
    includes(html, 'data-next-move="agent"', 'the next step is the agent\'s own')
    includes(html, 'readable wind-up telegraph', 'it comes from the newest completed run')
    assert.ok(!html.includes('Run CREATE to turn this idea'), 'a goal written once at creation is never shown as the next step')
  },

  'a blocked launch lists every failed check and still lets you try'() {
    const html = render(ui.IncubatorDetail, { slot: slot(), runs: [], preflight: blockedPreflight, now: NOW, actions: noopActions })
    includes(html, 'data-banner="blocked"', 'the blocked banner is shown')
    includes(html, 'data-preflight-problems="2"', 'every failed check is listed, not only the first')
    includes(html, 'prompt directory: not a dir (/repo/prompts)', 'failed checks keep their paths')
    includes(html, 'mutate prompt: not found (/repo/prompts/mutate.md)', 'the second failed check is visible too')
    includes(html, 'data-run-blocked="true"', 'the run button reflects the block')
    includes(html, 'Try run', 'the run button says a launch will be attempted')
    assert.ok(!/\sdisabled[=\s>]/.test(tagWith(html, 'data-run-button="proj"')), 'a blocked launch stays clickable so the attempt is recorded server-side')
  },

  'a failed last run is a banner, and running disables the run button'() {
    const failed = render(ui.IncubatorDetail, {
      slot: slot({ lastRunStatus: 'failed', lastRunFailure: '[run failed - codex exited 1] API Error: 529 overloaded_error', lastRunFailureSource: 'agent exit' }),
      runs: failedRuns,
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(failed, 'data-banner="failed"', 'a failed last run is a banner above everything else')
    includes(failed, 'API Error: 529 overloaded_error', 'the banner shows the error')

    const running = render(ui.IncubatorDetail, {
      slot: slot({ running: { running: true, startTime: NOW - 5000, runner: 'codex' } }),
      runs: [],
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(running, 'data-banner="running"', 'an active run is announced')
    assert.match(tagWith(running, 'data-run-button="proj"'), /\sdisabled[=\s>]/, 'a second launch cannot be started while one runs')
    includes(running, 'data-next-run="MUTATE"', 'while run #5 (research) runs, the next run is #6 (mutate)')
    includes(running, '#6 · after the current run', 'the next-run number accounts for the run in flight')
  },

  'the runner caption tells you how Claude will run'() {
    const html = render(ui.IncubatorDetail, {
      slot: slot({ runner: 'claude', claudeModel: 'fable', runnerSetups: { claude: { ok: true, model: 'fable', permissionMode: 'acceptEdits', checks: [] } } }),
      runs: [],
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(html, 'data-runner-caption="claude"', 'the runner caption is rendered')
    includes(html, 'fable · acceptEdits permissions', 'model and permission mode are visible before a run')
  },

  'the hero sentence follows the loop'() {
    const running = ui.incubator.loopHeadline([slot({ displayName: 'Taste Trainer', running: { running: true, startTime: NOW - 1000, runner: 'claude' } })], { now: NOW })
    assert.equal(running.title, 'Taste Trainer is incubating')
    assert.equal(running.tone, 'run')

    const scheduled = ui.incubator.loopHeadline([
      slot({ id: 'later', enabled: true, nextRunAt: NOW + 50 * 60000 }),
      slot({ id: 'soon', displayName: 'Soon', enabled: true, nextRunAt: NOW + 12 * 60000 }),
    ], { now: NOW })
    assert.equal(scheduled.title, 'Next run in 12m')
    assert.equal(scheduled.focusId, 'soon', 'the hero points at whichever slot fires first')

    const resting = ui.incubator.loopHeadline([slot()], { now: NOW })
    assert.equal(resting.title, 'The lab is resting', 'no autopilot means nothing will happen on its own; say so')

    const attention = ui.incubator.loopHeadline([slot({ id: 'b' }), slot({ id: 'f', lastRunStatus: 'failed' })], { now: NOW, preflightBySlot: { b: blockedPreflight } })
    assert.deepEqual(attention.attention.map(item => item.id), ['b'], 'only a blocked launch needs you; a failed slot retries on its own')

    const html = render(ui.LoopHero, { slots: [slot()], headline: attention, today: { total: 3, failed: 1 }, now: NOW })
    includes(html, 'data-attention-list="true"', 'slots that need you are one click away')
  },

  'the dial draws every scheduled launch in the next six hours'() {
    const slots = [slot({ id: 'a', enabled: true, intervalHours: 1, nextRunAt: NOW + 30 * 60000 }), slot({ id: 'b', enabled: false })]
    const upcoming = ui.incubator.upcomingSchedule(slots, NOW)
    assert.equal(upcoming.length, 6, 'an hourly slot fires six times in six hours; manual slots never do')
    const html = render(ui.LoopDial, { slots, now: NOW, headline: { tone: 'ok', until: NOW + 30 * 60000 } })
    assert.equal(html.split('data-dial-beat="a"').length - 1, 6, 'each launch is drawn')
    includes(html, 'data-loop-dial="scheduled"', 'the dial exposes its state')
    includes(html, '30:00', 'the dial counts down to the next launch')
  },

  'the local critic is labeled, per slot, and honest when off'() {
    const analysis = { fields: { DIRECTION: 'Tighten the raid loop.', NEXT: 'Add a telegraph.' }, missing: ['STRONGEST', 'WEAKEST', 'DRIFT'], raw: 'DIRECTION: Tighten the raid loop.', malformed: true, model: 'qwen2.5-instruct:1.5b' }
    const html = render(ui.CriticView, { analysis, savedAt: NOW, slotId: 'tidebound', onRefresh() {} })
    includes(html, 'data-critic-source="local-ollama-qwen"', 'the source is machine-readable')
    includes(html, 'Local Ollama/Qwen', 'the source is labeled for people')
    includes(html, 'data-critic-slot="tidebound"', 'the critique belongs to one incubator')
    includes(html, 'Tighten the raid loop.', 'saved fields render')
    includes(html, 'Raw response (3 fields missing)', 'a malformed response is disclosed, not hidden')

    const off = render(ui.CriticView, { analysis: null, disabled: true, slotId: 'x', onRefresh() {} })
    includes(off, 'PI_PULSE_ENABLE_LOCAL_LLM=1', 'a disabled critic says how to enable it instead of showing an error')
    assert.ok(!off.includes('Refresh'), 'there is nothing to refresh while the critic is off')
  },

  async 'API responses that are HTML become explicit errors'() {
    const html = { status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<!doctype html><title>Pi Pulse</title>' }
    await assert.rejects(ui.api.readApiJson(html, '/api/incubators'), /\/api\/incubators returned HTML instead of JSON \(200 text\/html\)/)
    assert.equal(ui.api.mutationBlockMessage({ code: 'GLOBAL_RUN_LOCK_ACTIVE', owner: { id: 'taste-trainer' } }), 'Another run is in progress (taste-trainer); the lab runs one at a time.')
    assert.equal(ui.api.mutationBlockMessage({ preflight: blockedPreflight }), 'prompt directory: not a dir')
    assert.match(ui.api.mutationBlockMessage({ code: 'STALE_SERVICE_SOURCE' }), /restart/)
  },

  'the dashboard never fabricates data or reads raw JSON'() {
    const sources = []
    const walk = dir => {
      for (const name of fs.readdirSync(dir)) {
        const file = join(dir, name)
        if (fs.statSync(file).isDirectory()) walk(file)
        else if (/\.(jsx?|mjs)$/.test(name)) sources.push([file, fs.readFileSync(file, 'utf8')])
      }
    }
    walk(join(root, 'src'))
    for (const [file, text] of sources) {
      assert.ok(!/Math\.random/.test(text), `${file} must not simulate telemetry or state`)
      assert.ok(!/\.then\(\s*\w+\s*=>\s*\w+\.json\(\)\)|await \w+\.json\(\)/.test(text), `${file} must read API JSON through the HTML guard`)
    }
  },
}

let failures = 0
for (const [name, test] of Object.entries(tests)) {
  try {
    await test()
    console.log(`ok - ui: ${name}`)
  } catch (err) {
    failures += 1
    console.log(`not ok - ui: ${name}\n${String(err.stack || err.message).split('\n').slice(0, 6).map(line => `  ${line}`).join('\n')}`)
  }
}
if (failures) {
  console.log(`${failures} UI contract(s) failed`)
  process.exit(1)
}
