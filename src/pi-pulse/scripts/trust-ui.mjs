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
    assert.equal(judged.detail, 'retrying after 2 sessions without progress', 'a slot backing off says why its next session is later')
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
    includes(running, 'data-next-run="SHAPE"', 'without a brief the next session shapes the idea')
    includes(running, '#6 · after the current session', 'the next-session number accounts for the one in flight')
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
    assert.equal(scheduled.title, 'Next session in 12m')
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

  'the detail view shows the stage, what the product looks like now, and its brief'() {
    const html = render(ui.IncubatorDetail, {
      slot: slot({
        stage: 'building',
        nextRunType: 'BUILD',
        brief: { exists: true, what: 'A harbor raid game for phones.', done: [{ text: 'A raid ends in five minutes', checked: true }, { text: 'Sound on hits', checked: false }], constraints: ['no network'] },
        keptEvidence: [
          { run: 7, evidence: 'run-7', shots: ['desktop.png', 'mobile.png'], at: '2026-09-25T10:00:00Z' },
          { run: 9, evidence: 'run-9', shots: ['desktop.png', 'mobile.png'], at: '2026-09-26T10:00:00Z' },
        ],
      }),
      runs: [],
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(html, 'data-stage="building"', 'the lifecycle stage is visible')
    includes(tagWith(html, 'aria-current="step"'), 'aria-current="step"', 'the current stage is marked for assistive tech')
    includes(html, 'src="/api/incubators/proj/evidence/run-9/desktop.png"', 'the newest kept screenshot is shown')
    includes(html, 'Before · #7', 'the previous session is one click away')
    includes(html, 'data-brief-done="2"', "the builder's done-list is shown")
    includes(html, '1/2 done', 'progress against the brief is counted')
    includes(html, 'A harbor raid game for phones.', 'the brief says what the product is')

    const bare = render(ui.IncubatorDetail, { slot: slot(), runs: [], preflight: { ok: true, checks: [] }, now: NOW, actions: noopActions })
    includes(bare, 'data-product-view="none"', 'no screenshot yet is said plainly')
    includes(bare, 'data-brief="none"', 'a missing brief explains that the first session writes it')
  },

  'the independent review and the last outcome are what you see first'() {
    const runs = [
      { num: 8, date: '2026-09-25', type: 'BUILD', 'What changed': 'Raids end in five minutes', Outcome: 'kept · a1b2c3d', Ended: '2026-09-25T11:00:00Z' },
      { num: 9, date: '2026-09-26', type: 'BUILD', 'What changed': 'New combo system', Outcome: 'reverted — ./check.sh failed: combo test', Ended: '2026-09-26T11:00:00Z', Next: 'Make the combo test pass first' },
    ]
    const html = render(ui.IncubatorDetail, {
      slot: slot({ stage: 'building', lastReview: { ok: true, verdict: 'better', rating: 3.5, done: false, problems: ['No sound on hits', 'Buttons too small'], reviewer: 'claude', run: 8 } }),
      runs,
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(html, 'data-review="better"', 'the review verdict is shown')
    includes(html, 'Better than before', 'in words')
    includes(html, 'data-review-problems="2"', "the reviewer's problems are listed")
    includes(html, 'not done yet', 'whether the brief is met is explicit')
    includes(html, 'data-outcome="reverted"', 'a reverted session is marked as such')
    includes(html, 'Reverted by the lab: ./check.sh failed: combo test', 'with the reason the lab reverted it')
    includes(html, 'Make the combo test pass first', 'the next goal is the agent\'s own')
    includes(html, 'data-run-outcome="reverted"', 'the timeline marks the reverted session too')
    includes(html, 'data-run-outcome="kept"', 'and the kept one')

    const noted = render(ui.IncubatorDetail, {
      slot: slot({ stage: 'building', latestUserFeedback: 'make it purple', feedbackUpdatedAt: '2026-09-26T12:00:00Z', lastOutcomeAt: '2026-09-26T11:00:00Z' }),
      runs,
      preflight: { ok: true, checks: [] },
      now: NOW,
      actions: noopActions,
    })
    includes(noted, 'data-next-move="note"', 'a note written after the last session comes first')
    includes(noted, 'make it purple', 'and it is quoted')
  },

  'a finished project rests, and the hero says the lab is caught up'() {
    const done = slot({ id: 'moss', displayName: 'Moss', stage: 'done', enabled: true, nextRunAt: NOW - 60000, lastOutcomeAt: '2026-09-26T11:00:00Z' })
    assert.equal(ui.incubator.slotState(done, { now: NOW }).kind, 'resting')
    assert.equal(ui.incubator.upcomingSchedule([done], NOW).length, 0, 'a resting project has no upcoming sessions')
    const headline = ui.incubator.loopHeadline([done], { now: NOW })
    assert.equal(headline.title, 'All caught up')
    assert.equal(headline.resting, 1)
    const html = render(ui.IncubatorDetail, { slot: done, runs: [], preflight: { ok: true, checks: [] }, now: NOW, actions: noopActions })
    includes(html, 'data-banner="resting"', 'the detail view says it is done and resting')
    includes(html, 'wakes this finished project up', 'and how to wake it')
  },

  'while you were away: what the lab did since your last visit'() {
    const slots = [slot({ id: 'harbor', displayName: 'Harbor' }), slot({ id: 'moss', displayName: 'Moss', stage: 'done', lastOutcomeAt: '2026-09-26T09:00:00Z' })]
    const runsBySlot = {
      harbor: [
        { num: 8, type: 'BUILD', 'What changed': 'old news', Outcome: 'kept · 1', Ended: '2026-09-24T09:00:00Z' },
        { num: 9, type: 'BUILD', 'What changed': 'Raids end in five minutes', Outcome: 'kept · 2', Ended: '2026-09-26T08:00:00Z' },
        { num: 10, type: 'BUILD', 'What changed': 'combo system', Outcome: 'reverted — check failed', Ended: '2026-09-26T09:30:00Z' },
      ],
      moss: [{ num: 3, type: 'POLISH', 'What changed': 'tighter last stanza', Outcome: 'kept · 3', Ended: '2026-09-26T08:30:00Z' }],
    }
    const away = ui.incubator.awayDigest(slots, runsBySlot, Date.parse('2026-09-25T00:00:00Z'))
    assert.equal(away.total, 3, 'only sessions after your last visit count')
    assert.equal(away.kept, 2)
    assert.equal(away.reverted, 1)
    assert.deepEqual(away.finished, ['Moss'], 'projects that finished while you were away are named')
    assert.equal(away.items[0].num, 10, 'newest first')
    const html = render(ui.LoopHero, { slots, headline: ui.incubator.loopHeadline(slots, { now: NOW }), today: { total: 3, failed: 0, kept: 2 }, away, now: NOW })
    includes(html, 'data-away-digest="3"', 'the hero summarises the time away')
    includes(html, '2 kept', 'with counts')
    includes(html, 'Finished: Moss', 'and what finished')
    includes(html, 'Raids end in five minutes', 'and what changed, in plain words')
    const quiet = render(ui.LoopHero, { slots, headline: ui.incubator.loopHeadline(slots, { now: NOW }), today: { total: 0, failed: 0, kept: 0 }, away: ui.incubator.awayDigest(slots, runsBySlot, NOW), now: NOW })
    assert.ok(!quiet.includes('data-away-digest'), 'nothing new, nothing shown')
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
