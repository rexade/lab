#!/usr/bin/env node
// Serves the real Pi Pulse against a disposable lab seeded with every slot state
// (building, polishing mid-session, failing and retrying, blocked, done and
// resting), so UI work can be seen without touching the real lab. Schedules
// stay off; nothing runs.
//   npm run build && npm run preview:lab   -> http://127.0.0.1:8090
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT || 8090)
const lab = fs.mkdtempSync(join(os.tmpdir(), 'pi-pulse-preview-'))
const projects = join(lab, 'projects')
const bin = join(lab, 'bin')
fs.mkdirSync(bin, { recursive: true })
for (const tool of ['codex', 'claude']) {
  fs.writeFileSync(join(bin, tool), '#!/usr/bin/env bash\necho preview\n')
  fs.chmodSync(join(bin, tool), 0o755)
}

const today = new Date()
const day = offset => new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10)
const min = m => Date.now() + m * 60000

function entry(num, date, type, fields) {
  return [`## Run ${num} — ${date} — ${type}`, '', ...Object.entries(fields).map(([k, v]) => `**${k}:** ${v}`), ''].join('\n')
}

const iso = m => new Date(Date.now() + m * 60000).toISOString()

function seed({ id, title, runner, phase = null, runs, status = {}, slot = {}, brief = null, app = null, blocked = false }) {
  const repo = join(lab, id)
  fs.mkdirSync(join(repo, 'reports'), { recursive: true })
  if (app) fs.writeFileSync(join(repo, 'index.html'), app)
  if (brief) fs.writeFileSync(join(repo, 'BRIEF.md'), brief)
  fs.writeFileSync(join(repo, 'reports', 'RUN_LOG.md'), ['# Run Log', '', ...runs].join('\n'))
  fs.mkdirSync(join(projects, id), { recursive: true })
  const statusPath = join(projects, id, 'status.json')
  // A repo path that is a file: no session can run there, so launch is blocked.
  const repoPath = blocked ? join(lab, `${id}-not-a-folder`) : repo
  if (blocked) fs.writeFileSync(repoPath, 'not a project folder\n')
  fs.writeFileSync(statusPath, JSON.stringify({
    project: id, displayName: title, phase, runner, repo: repoPath,
    runLog: join(repoPath, 'reports', 'RUN_LOG.md'),
    ...status,
  }, null, 2))
  return { id, type: 'project', statusPath, enabled: false, intervalHours: 0.5, nextRunAt: null, ...slot }
}

const harborPage = ({ telegraph }) => `<!doctype html><title>Tidebound Harbor</title>
<body style="margin:0;background:radial-gradient(circle at 30% 20%,#12324a,#060b14 70%);color:#e2e8f0;font:16px system-ui;min-height:100vh;display:grid;place-items:center">
<main style="width:min(92vw,760px)"><h1 style="letter-spacing:-.02em;margin:0 0 6px">Tidebound Harbor</h1><p style="color:#94a3b8;margin:0 0 24px">Wave 3 · Black Tide raid</p>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">${['Powder Keg', 'Ghost Cannon', 'Black Mark', 'Anchor Swap'].map((card, i) => `<div style="border-radius:14px;padding:18px 12px;background:linear-gradient(160deg,${['#1e3a5f', '#3b2f5f', '#5f2f3b', '#2f5f4a'][i]},#0b1220);box-shadow:0 10px 30px #0008"><div style="font-size:30px">${['💥', '👻', '🏴', '⚓'][i]}</div><b>${card}</b></div>`).join('')}</div>
${telegraph ? '<div style="margin-top:22px;padding:14px 16px;border-radius:12px;background:#f59e0b22;border:1px solid #f59e0b88;color:#fcd34d"><b>Anchor Guard winds up</b> — heavy swing in 2 turns. Raise a shield or strike first.</div>' : '<div style="margin-top:22px;color:#64748b">Anchor Guard is here.</div>'}
<button style="margin-top:24px;padding:12px 22px;border:0;border-radius:12px;background:#22d3ee;color:#04202a;font-weight:700">Play turn</button></main></body>`

const slots = [
  seed({
    id: 'tidebound-harbor', title: 'Tidebound Harbor', runner: 'codex',
    app: harborPage({ telegraph: true }),
    brief: `# Tidebound Harbor
## What it is
A harbor raid card game a new player can finish on a phone in five minutes, and wants to replay.
## For whom
Someone with five minutes and a phone.
## Done means
- [x] A full raid finishes in under five minutes
- [x] Wave 3 never stalls on the Pi browser
- [ ] Every enemy attack is telegraphed a turn ahead
- [ ] Sound on hits, off by default
## Constraints
- Static files only, served by the lab
- No network calls
`,
    runs: [
      entry(38, day(1), 'BUILD', { Goal: 'Wave 3 never stalls on slower devices', 'What changed': 'Raid spawns run on a fixed 30Hz tick; wave 3 no longer stalls on the Pi browser.', Verified: 'spike_check.sh green; reached wave 3 in 3/3 headless runs', Next: 'Telegraph the Anchor Guard wind-up', Checks: './check.sh pass · app opened cleanly', Outcome: 'kept · 4f1c2ab', Ended: iso(-26 * 60), Review: 'better · 4/5 · not done yet — Enemy attacks still land without warning' }),
      entry(39, day(0), 'BUILD', { Goal: 'Every enemy attack is readable a turn ahead', 'What changed': 'A combo meter that stacks card effects.', Verified: 'played two raids', Next: 'Telegraph attacks before adding systems', Checks: './check.sh fail', Outcome: 'reverted — ./check.sh failed: raid_length test: 7m12s > 5m', Ended: iso(-190) }),
      entry(40, day(0), 'BUILD', { Goal: 'Every enemy attack is readable a turn ahead', 'What changed': 'The Anchor Guard now shows its wind-up a turn early, with what to do about it.', Verified: 'played three raids on the phone viewport; the warning shows before every heavy swing', Next: 'Sound on hits, off by default', Checks: './check.sh pass · app opened cleanly', Outcome: 'kept · 9b7e310', Ended: iso(-42), Review: 'better · 4/5 · not done yet — No sound when a card hits' }),
    ],
    status: {
      runCount: 40, stage: 'building', lastRun: day(0), lastRunType: 'BUILD', lastRunStatus: 'ok', lastOutcome: 'kept', lastOutcomeAt: iso(-42), ratchet: 'on', lastGoodCommit: '9b7e310c5a',
      lastReview: { ok: true, verdict: 'better', rating: 4, done: false, problems: ['No sound when a card hits', 'The Play button sits below the fold on small phones', 'Wave counter is easy to miss'], cut: 'the unused settings drawer', reviewer: 'claude', run: 40, at: iso(-38) },
      lastQualityRating: 4,
    },
    slot: { enabled: true, nextRunAt: min(23), lastScheduledRun: new Date(min(-7)).toISOString() },
  }),
  seed({
    id: 'taste-trainer', title: 'Taste Trainer', runner: 'claude',
    brief: `# Taste Trainer
## What it is
Learns what someone likes from a handful of either-or choices.
## Done means
- [x] A profile forms in under ten choices
- [x] Choices never repeat
- [x] Works one-handed on a phone
`,
    runs: [
      entry(66, day(0), 'POLISH', { Goal: 'Choosing feels instant', 'What changed': 'Removed the loading shimmer; the next pair is prefetched while you decide.', Verified: 'timed 20 choices', Next: 'Tighten the profile summary copy', Outcome: 'kept · 1a2b3c4', Ended: iso(-300), Review: 'better · 4.5/5 · meets the brief — Profile summary is wordy' }),
    ],
    status: {
      runCount: 66, stage: 'polishing', polishSessions: 1, lastRun: day(0), lastRunType: 'POLISH', lastRunStatus: 'ok', lastOutcome: 'kept', lastOutcomeAt: iso(-300), ratchet: 'on', lastGoodCommit: '1a2b3c4d5e', claudeModel: 'fable',
      lastReview: { ok: true, verdict: 'better', rating: 4.5, done: true, problems: ['The profile summary is wordy'], cut: 'nothing', reviewer: 'codex', run: 66, at: iso(-295) },
      session: { run: 67, stage: 'polishing', type: 'POLISH', startedAt: iso(-12), ratchet: 'on' },
    },
    slot: { enabled: true, nextRunAt: min(52), lastScheduledRun: new Date(min(-3)).toISOString() },
  }),
  seed({
    id: 'poem-machine', title: 'Poem Machine', runner: 'codex',
    brief: '# Poem Machine\n## What it is\nWrites one unique poem about moss, nature and the smell of rain.\n## Done means\n- [ ] A poem that reads well aloud\n',
    runs: [
      entry(3, day(1), 'SHAPE', { Goal: 'A first poem that reads well aloud', 'What changed': 'BRIEF.md and a first draft of the poem in POEM.md.', Verified: 'read it aloud; the third stanza stumbles', Next: 'Fix the third stanza', Outcome: 'kept · 77aa001', Ended: iso(-20 * 60) }),
      entry(4, day(0), 'FAILED', { Failure: '[run failed - codex exited 1] API Error: 529 overloaded_error — the model is overloaded, try again later', Outcome: 'failed — codex exited 1', Ended: iso(-95) }),
    ],
    status: { runCount: 4, stage: 'building', lastRun: day(0), lastRunType: 'FAILED', lastRunStatus: 'failed', lastOutcome: 'failed', lastOutcomeAt: iso(-95), lastRunFailure: '[run failed - codex exited 1] API Error: 529 overloaded_error — the model is overloaded, try again later', lastRunFailureSource: 'agent exit' },
    slot: { enabled: true, nextRunAt: min(35), failStreak: 1, backoffForRun: 4, backoffUntil: min(35), backoffReason: '1 session in a row without progress; retrying on its own' },
  }),
  seed({
    id: 'race-whisperer', title: 'Race Whisperer', runner: 'claude', blocked: true,
    runs: [],
    status: { runCount: 12, lastRun: day(3), stage: 'building' },
  }),
  seed({
    id: 'hatchery', title: 'Hatchery', runner: 'codex',
    app: '<!doctype html><title>Hatchery</title><body style="margin:0;background:#0b1020;color:#e2e8f0;font:16px system-ui;display:grid;place-items:center;height:100vh"><main style="text-align:center"><div style="font-size:96px">🥚</div><p>Tap the egg.</p></main></body>',
    brief: '# Hatchery\n## What it is\nAn idle game with one egg and one obvious thing to do.\n## Done means\n- [x] A new player knows what to press on the first screen\n- [x] The egg hatches within a minute of play\n- [x] Nothing else competes for attention\n',
    runs: [
      entry(11, day(1), 'POLISH', { Goal: 'Nothing else competes for attention', 'What changed': 'Removed the stats sidebar; the egg is the whole screen.', Verified: 'first-time player test in the phone viewport', Outcome: 'kept · 5e5e5e5', Ended: iso(-17 * 60), Review: 'better · 4.5/5 · meets the brief — nothing left worth changing' }),
      entry(12, day(0), 'POLISH', { Goal: 'Anything left worth polishing', 'What changed': 'Nothing: the brief is met and further changes would add noise.', Verified: 'played it cold', Outcome: 'no changes', Ended: iso(-9 * 60) }),
    ],
    status: {
      runCount: 12, stage: 'done', polishSessions: 2, lastRun: day(0), lastRunType: 'POLISH', lastRunStatus: 'no-changes', lastOutcome: 'no-changes', lastOutcomeAt: iso(-9 * 60), ratchet: 'on', lastGoodCommit: '5e5e5e5aaa',
      lastReview: { ok: true, verdict: 'better', rating: 4.5, done: true, problems: [], cut: 'nothing', reviewer: 'codex', run: 11, at: iso(-17 * 60) },
    },
    slot: { enabled: true, nextRunAt: min(-30), restingSince: iso(-9 * 60) },
  }),
]

// Real screenshots of the harbor app before and after its last kept session,
// taken the way the lab's own browser check takes them (when a Chromium exists).
async function screenshot(html, dir) {
  try {
    const { chromium } = await import('playwright')
    const executablePath = process.env.PREVIEW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
    const browser = await chromium.launch({ executablePath })
    fs.mkdirSync(dir, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(html)
    await page.screenshot({ path: join(dir, 'desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(dir, 'mobile.png') })
    await browser.close()
    return ['desktop.png', 'mobile.png']
  } catch {
    return []
  }
}
const harborEvidence = join(lab, 'tidebound-harbor', 'reports', 'evidence')
const beforeShots = await screenshot(harborPage({ telegraph: false }), join(harborEvidence, 'run-38'))
const afterShots = await screenshot(harborPage({ telegraph: true }), join(harborEvidence, 'run-40'))
if (afterShots.length) {
  const harborStatus = slots[0].statusPath
  const status = JSON.parse(fs.readFileSync(harborStatus, 'utf8'))
  status.keptEvidence = [
    { run: 38, evidence: 'run-38', shots: beforeShots, at: iso(-26 * 60) },
    { run: 40, evidence: 'run-40', shots: afterShots, at: iso(-42) },
  ]
  fs.writeFileSync(harborStatus, JSON.stringify(status, null, 2))
}

fs.writeFileSync(join(projects, 'incubators.json'), JSON.stringify({ slots }, null, 2))
fs.writeFileSync(join(lab, 'RUN_LOG.md'), '# Run Log\n')

// Taste Trainer is mid-session: a live process owns the global lock.
const sleeper = spawn('sleep', ['86400'], { detached: true, stdio: 'ignore' })
sleeper.unref()
fs.mkdirSync(join(projects, '.run-locks', 'global'), { recursive: true })
fs.writeFileSync(join(projects, '.run-locks', 'global', 'owner.json'), JSON.stringify({ ok: true, pid: sleeper.pid, kind: 'incubator', id: 'taste-trainer', runner: 'claude', startedAt: new Date(Date.now() - 754000).toISOString() }))

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    PI_PULSE_DISABLE_SCHEDULES: '1',
    PI_PULSE_LAB_ROOT: lab,
    PI_PULSE_INCUBATOR_REPO_ROOT: lab,
    PI_PULSE_PROJECTS_DIR: projects,
    PI_PULSE_DAY_BUFFER_PATH: join(lab, 'day-buffer.json'),
    CODEX_BIN: join(bin, 'codex'),
    CLAUDE_BIN: join(bin, 'claude'),
    PATH: `${bin}:${process.env.PATH}`,
  },
})
console.log(`Pi Pulse preview lab: http://127.0.0.1:${port}  (fixture ${lab})`)

const stop = () => {
  server.kill('SIGTERM')
  try { process.kill(sleeper.pid, 'SIGKILL') } catch {}
  fs.rmSync(lab, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.on('exit', code => { if (code) console.error(`server exited ${code}`) })
