#!/usr/bin/env node
// Serves the real Pi Pulse against a disposable lab seeded with every slot state
// (healthy, running, failed, blocked, paused), so UI work can be seen and
// screenshotted without touching the real lab. Schedules stay off; nothing runs.
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

function seed({ id, title, runner, role = 'product', phase, runs, status = {}, slot = {}, prompts = true, app = false, critic = null }) {
  const repo = join(lab, id)
  fs.mkdirSync(join(repo, 'reports'), { recursive: true })
  if (prompts) {
    fs.mkdirSync(join(repo, 'prompts'), { recursive: true })
    for (const type of ['create', 'mutate', 'research']) fs.writeFileSync(join(repo, 'prompts', `${type}.md`), `${type} prompt\n`)
  } else {
    fs.writeFileSync(join(repo, 'prompts'), 'not a directory\n')
  }
  if (app) fs.writeFileSync(join(repo, 'index.html'), `<!doctype html><title>${title}</title><body style="background:#0b1020;color:#e2e8f0;font:16px system-ui;display:grid;place-items:center;height:100vh"><h1>${title}</h1></body>`)
  if (critic) fs.writeFileSync(join(repo, 'reports', 'DRIFT_FEEDBACK.json'), JSON.stringify({ ok: true, incubatorId: id, response: critic, model: 'qwen2.5-instruct:1.5b', ts: Date.now() - 42 * 60000 }, null, 2))
  fs.writeFileSync(join(repo, 'reports', 'RUN_LOG.md'), ['# Run Log', '', ...runs].join('\n'))
  fs.mkdirSync(join(projects, id), { recursive: true })
  const statusPath = join(projects, id, 'status.json')
  fs.writeFileSync(statusPath, JSON.stringify({
    project: id, displayName: title, incubatorRole: role, phase, runner, repo,
    runLog: join(repo, 'reports', 'RUN_LOG.md'), runTypes: ['mutate', 'research', 'mutate'],
    ...status,
  }, null, 2))
  return { id, type: 'project', statusPath, enabled: false, intervalHours: 0.5, nextRunAt: null, ...slot }
}

const slots = [
  seed({
    id: 'tidebound-harbor', title: 'Tidebound Harbor', runner: 'codex', phase: 'm1b combat kit', app: true,
    critic: 'DIRECTION: Tightening the M1b combat loop toward a shippable harbor raid.\nSTRONGEST: Contract tests keep every new card honest.\nWEAKEST: Enemy telegraphs are hard to read on mobile.\nDRIFT: no - the milestone plan is being followed.\nNEXT: Add a readable telegraph for the Anchor Guard wind-up.',
    runs: [
      entry(38, day(1), 'MUTATE', { 'What I changed': 'Powder Keg now chains into adjacent crates with a visible fuse arc.', 'Quality gate': 'PASS', 'Quality rating': '4/5', 'Evidence confidence': '4/5' }),
      entry(39, day(0), 'RESEARCH', { 'What I investigated': 'Why Black Tide raids stall at wave 3 on slower devices.', 'Key finding': 'Spawn pacing ties to frame time; a fixed tick removes the stall.', 'Quality gate': 'NEEDS-EVIDENCE', 'Quality rating': '3/5' }),
      entry(40, day(0), 'MUTATE', { 'What I changed': 'Raid spawns run on a fixed 30Hz tick; wave 3 no longer stalls on the Pi browser.', 'Evidence': 'spike_check.sh green; wave 3 reached in 3/3 headless runs.', 'Quality gate': 'PASS', 'Quality rating': '4.5/5', 'Evidence confidence': '4/5' }),
    ],
    status: { runCount: 40, lastRun: day(0), lastRunType: 'MUTATE', lastRunStatus: 'ok', lastQualityGate: 'PASS', lastQualityRating: 4.5, lastEvidenceConfidence: 4, lastNorthStar: 'A harbor raid a new player can finish on a phone in five minutes, and wants to replay.', lastRunStrategy: 'Remove the wave-3 stall before adding content.', lastPlateauRegressionVerdict: 'IMPROVED - stall gone', next_run_goal: 'Give the Anchor Guard a readable wind-up telegraph and prove it on mobile.' },
    slot: { enabled: true, nextRunAt: min(23), lastScheduledRun: new Date(min(-7)).toISOString() },
  }),
  seed({
    id: 'taste-trainer', title: 'Taste Trainer', runner: 'claude', phase: 'preference loop',
    runs: [
      entry(66, day(0), 'MUTATE', { 'What I changed': 'Pairs now come from the least-certain region of the preference model.', 'Quality gate': 'PASS', 'Quality rating': '4/5' }),
      entry(67, day(0), 'RESEARCH', { 'What I investigated': 'Whether 12 comparisons are enough to separate two taste clusters.', 'Key finding': 'Eight are enough when pairs are chosen by uncertainty.', 'Quality gate': 'PASS', 'Quality rating': '4/5' }),
    ],
    status: { runCount: 67, lastRun: day(0), lastRunType: 'RESEARCH', lastRunStatus: 'ok', lastQualityGate: 'PASS', lastQualityRating: 4, lastEvidenceConfidence: 3, claudeModel: 'fable', lastNorthStar: 'Learn a person\'s taste in under ten choices.' },
    slot: { enabled: true, nextRunAt: min(52), lastScheduledRun: new Date(min(-3)).toISOString() },
  }),
  seed({
    id: 'poem-machine', title: 'Poem Machine', runner: 'codex', phase: 'first prototype',
    runs: [
      entry(23, day(1), 'MUTATE', { 'What I changed': 'Poems now keep a single image across all stanzas.', 'Quality gate': 'NEEDS-EVIDENCE', 'Quality rating': '3/5' }),
      entry(24, day(0), 'FAILED', { Failure: '[run failed - codex exited 1] API Error: 529 overloaded_error — the model is overloaded, try again later', 'Quality gate': 'FAIL', 'Quality rating': '0/5' }),
    ],
    status: { runCount: 24, lastRun: day(0), lastRunType: 'FAILED', lastRunStatus: 'failed', lastQualityGate: 'FAIL', lastRunFailure: '[run failed - codex exited 1] API Error: 529 overloaded_error — the model is overloaded, try again later', lastRunFailureSource: 'agent exit' },
    slot: { enabled: true, nextRunAt: min(9) },
  }),
  seed({
    id: 'race-whisperer', title: 'Race Whisperer', runner: 'claude', phase: 'v85 analysis', prompts: false,
    runs: [entry(12, day(3), 'RESEARCH', { 'What I investigated': 'Holdout accuracy of the V32 weights on May 2026 races.', 'Key finding': 'V32 beats the default weights on 61% of races.', 'Quality gate': 'PASS', 'Quality rating': '3.5/5' })],
    status: { runCount: 12, lastRun: day(3), lastRunType: 'RESEARCH', lastRunStatus: 'ok', lastQualityGate: 'PASS', lastQualityRating: 3.5 },
  }),
  seed({
    id: 'hatchery', title: 'Hatchery', runner: 'codex', phase: 'idle game',
    runs: [
      entry(7, day(2), 'MUTATE', { 'What I changed': 'Eggs hatch on a visible timer instead of instantly.', 'Quality gate': 'FAIL', 'Quality rating': '2/5' }),
      entry(8, day(1), 'MUTATE', { 'What I changed': 'Tried a second timer style; first screen still confusing.', 'Quality gate': 'FAIL', 'Quality rating': '2/5', 'Next move': 'Cut the timer panel and show one egg with one obvious tap target.' }),
    ],
    status: { runCount: 8, lastRun: day(1), lastRunType: 'MUTATE', lastRunStatus: 'quality-failed', lastQualityGate: 'FAIL', lastQualityRating: 2, lastRecoveryRequired: true, latestUserFeedback: 'The first screen is confusing, I do not know what to press.', lastRunFailure: 'Quality gate FAIL: the first screen still does not say what to press.' },
    slot: { enabled: true, nextRunAt: min(150), failStreak: 2, backoffForRun: 8, backoffUntil: min(150), backoffReason: '2 failed runs in a row; retrying on its own' },
  }),
]


fs.writeFileSync(join(projects, 'incubators.json'), JSON.stringify({ slots }, null, 2))
fs.writeFileSync(join(lab, 'RUN_LOG.md'), '# Run Log\n')

// Taste Trainer is mid-run: a live process owns the global lock.
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
