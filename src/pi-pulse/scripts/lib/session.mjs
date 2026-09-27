// The session model for autonomous incubator runs.
//
// One session = one agent owning one goal end to end. The lab (not the agent)
// decides what is kept: every session ends in a git commit, or is reverted when
// the product got measurably worse. A fresh-context reviewer then judges the
// product against its brief, and its verdict moves the project through
// shaping -> building -> polishing -> done.
//
// Pure functions are exported for the trust fixtures; the git and check
// helpers shell out and never throw (a broken repo turns the ratchet off).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const STAGES = ['shaping', 'building', 'polishing', 'done']
export const STAGE_TYPE = { shaping: 'SHAPE', building: 'BUILD', polishing: 'POLISH', done: 'POLISH' }
export const POLISH_SESSIONS = Math.max(1, Number(process.env.PI_PULSE_POLISH_SESSIONS || 2))

// Lab commits are marked as the lab's, never signed or hooked: the lab runs
// its own checks, and a missing GPG agent or a husky hook must not strand work.
const LAB_GIT = ['-c', 'user.name=Pi Pulse lab', '-c', 'user.email=lab@pi-pulse.local', '-c', 'commit.gpgsign=false']
// Caches and lab artifacts stay out of commits (local .git/info/exclude only;
// the project's own .gitignore is never edited).
const LAB_EXCLUDES = ['reports/stdout/', 'reports/evidence/', 'node_modules/', '__pycache__/', '*.pyc', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.cache/', '.DS_Store']
// reports/ holds the lab's own history (run log, notes, reviews): it survives reverts.
const OUTSIDE_REPORTS = ['--', '.', ':(exclude)reports']

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// ─── Stages ───────────────────────────────────────────────────────────────────

export function currentStage(status = {}, briefExists = false) {
  if (STAGES.includes(status.stage)) return status.stage
  return briefExists ? 'building' : 'shaping'
}

// A session on a finished project (a manual Run) is one more polish pass.
export function sessionStage(status = {}, briefExists = false) {
  const stage = currentStage(status, briefExists)
  return stage === 'done' ? 'polishing' : stage
}

// Where a project goes after a session. `review` is the parsed independent
// review, or null when none ran (no changes, a revert, or a reviewer failure).
export function nextStage({ stage, outcome, review = null, briefExists = false, polishSessions = 0 }) {
  let next = stage === 'done' ? 'polishing' : stage
  let polish = Number(polishSessions) || 0
  const productive = outcome === 'kept' || outcome === 'no-changes'
  if (next === 'shaping' && briefExists && productive) next = 'building'
  if (review?.done === true && briefExists && (next === 'shaping' || next === 'building')) {
    return { stage: 'polishing', polishSessions: 0 }
  }
  if (next === 'polishing') {
    if (review && review.done === false) return { stage: 'building', polishSessions: 0 }
    if (productive) {
      polish += 1
      if (polish >= POLISH_SESSIONS) return { stage: 'done', polishSessions: polish }
    }
  }
  return { stage: next, polishSessions: polish }
}

// Failed and reverted sessions back off; so does a building session that
// changed nothing. In polishing, "nothing left to change" is progress.
export function isUnproductive(status = {}) {
  const runStatus = String(status.lastRunStatus || '').toLowerCase()
  if (runStatus === 'failed' || runStatus === 'reverted' || runStatus === 'quality-failed') return true
  return runStatus === 'no-changes' && status.stage !== 'polishing' && status.stage !== 'done'
}

// ─── Idea and notes ───────────────────────────────────────────────────────────

// USER_FEEDBACK.md: `## Seed` is the idea; each note is a `## <ISO timestamp>` section.
export function steeringNotes(text = '') {
  const notes = []
  for (const chunk of String(text).split(/^(?=## (?:Seed\s*$|\d{4}-\d{2}-\d{2}))/im)) {
    const match = chunk.match(/^## (.*)\n([\s\S]*)$/)
    if (!match) continue
    const heading = match[1].trim()
    const body = match[2].trim()
    if (/^seed$/i.test(heading) || !body) continue
    notes.push({ at: heading, body })
  }
  return notes
}

export function seedFromFeedback(text = '') {
  const match = String(text).match(/^## Seed\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/im)
  return match ? match[1].trim() : ''
}

// Notes the builder has not acted on yet: newer than the last kept session's
// start. Without that marker (an older project) only the newest note is new.
export function newNotes(notes = [], seenAt = null) {
  if (!seenAt) return notes.slice(-1)
  const seen = Date.parse(seenAt)
  return notes.filter(note => !(Date.parse(note.at) <= seen))
}

export function ideaFor(status = {}, feedbackText = '', readmeText = '') {
  const seed = seedFromFeedback(feedbackText)
  if (seed) return seed
  const readmeSeed = String(readmeText).match(/Seed idea:\s*\n+([\s\S]*?)(?:\n\n|$)/i)?.[1]?.trim()
  if (readmeSeed) return readmeSeed
  return String(status.idea || status.current_focus || '').trim()
}

// ─── BRIEF.md ─────────────────────────────────────────────────────────────────

// Loose reading of the builder's brief for the dashboard: the "what" line and
// the "Done means" checklist. Anything else stays in the file.
export function parseBrief(text = '') {
  const source = String(text || '')
  if (!source.trim()) return { exists: false, what: '', done: [], constraints: [] }
  const section = name => {
    const match = source.match(new RegExp(`^##+\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im'))
    return match ? match[1].trim() : ''
  }
  const bullets = body => body.split('\n')
    .map(line => line.match(/^\s*[-*]\s+(?:\[( |x|X)\]\s*)?(.+)$/))
    .filter(Boolean)
    .map(match => ({ text: clip(match[2], 200), checked: match[1] ? match[1].toLowerCase() === 'x' : null }))
  const what = section('What it is') || source.replace(/^#.*$/m, '').trim().split(/\n\s*\n/)[0] || ''
  return {
    exists: true,
    what: clip(what.replace(/^[-*]\s+/gm, ''), 400),
    done: bullets(section('Done means')).slice(0, 12),
    constraints: bullets(section('Constraints')).map(item => item.text).slice(0, 8),
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const STAGE_GUIDANCE = {
  shaping: `Shaping. Turn the idea into a product. First write BRIEF.md (template below): what it is and the form it takes (web app, game, tool, text, design...), who it is for, what "done" means as 3-6 concrete outcomes a person could check, and the constraints you know of. Choose the simplest approach that runs on a Raspberry Pi. Then, in this same session, build a first version that already does the core thing. If the folder already holds work, describe what exists in BRIEF.md and continue from it: do not start over.`,
  building: `Building. Move the product toward the "Done means" list in BRIEF.md.`,
  polishing: `Polishing. The reviewer found the "Done means" list met. Add no new features. Make what exists clearer, sturdier, faster and more beautiful, fix the review's problems, and delete whatever does not earn its place. If nothing is worth changing, change nothing and say so.`,
}

const BRIEF_TEMPLATE = `# <Name>
## What it is
<one or two sentences: what it is and the form it takes>
## For whom
<who uses it, and what they want from it>
## Done means
- [ ] <an outcome a person could check>
## Constraints
- <limits you are designing within>`

export function sessionPrompt({
  name = 'this project',
  idea = '',
  stage = 'shaping',
  type = 'SHAPE',
  runNumber = 1,
  today = '',
  briefExists = false,
  lastOutcome = null,
  review = null,
  notes = [],
  recent = [],
  playPath = null,
}) {
  const standing = [
    `- Stage: ${STAGE_GUIDANCE[stage] || STAGE_GUIDANCE.building}`,
    `- This is session ${runNumber}.${lastOutcome ? ` ${lastOutcome}` : ''}`,
    briefExists ? '- Your brief is BRIEF.md: read it first.' : '- There is no BRIEF.md yet: write it before anything else.',
  ]
  if (review) {
    standing.push(`- Latest independent review (full text in reports/REVIEW.md): ${review.verdict || 'unrated'}${review.rating != null ? `, ${review.rating}/5` : ''}${review.done === true ? ', meets the brief' : review.done === false ? ', does not meet the brief yet' : ''}.`)
    for (const [index, problem] of (review.problems || []).slice(0, 3).entries()) standing.push(`  ${index + 1}. ${clip(problem, 240)}`)
    if (review.cut && !/^(nothing|none|-)\.?$/i.test(review.cut)) standing.push(`  Cut: ${clip(review.cut, 240)}`)
  } else {
    standing.push('- No independent review yet.')
  }
  if (notes.length) {
    standing.push('- New notes from the person who owns the lab (these come first):')
    for (const note of notes.slice(-5)) standing.push(`  [${note.at}] ${clip(note.body, 600)}`)
  } else {
    standing.push('- No new notes from the person. Older notes are in reports/USER_FEEDBACK.md.')
  }
  if (recent.length) {
    standing.push('- Recent sessions (newest last):')
    for (const run of recent.slice(-3)) standing.push(`  #${run.num} ${run.type}${run.outcome ? ` (${run.outcome})` : ''}: ${clip(run.summary, 180)}`)
  }

  return `You are the builder of "${name}", one project in an autonomous software lab on a Raspberry Pi. Nobody is watching this session and nobody can be asked anything: you decide, you build, and you check your own work.

THE IDEA (from the person who owns the lab)
${idea ? idea : '(not recorded; read README.md, BRIEF.md and the code to understand the project)'}

WHERE THINGS STAND
${standing.join('\n')}

THIS SESSION
1. Choose the one goal that would most improve the product for a person using it: the person's new notes first, then the review's top problem, then your brief. State it as an outcome ("a new player knows what to press on the first screen"), not a task list.
2. Build it end to end. Run the product and use it the way a person would; look at what you made (open it, screenshot it, read the output). Fix what you see, and keep going until the goal is met or the session runs out.
3. Leave the product better and simpler than you found it. Deleting weak or unused parts is progress; piling on features is not.
4. Keep BRIEF.md true: update it when the direction, the "Done means" list or a constraint changes.
5. Keep a way to check the product: ./check.sh (or npm test / npm run build) should pass when it works and fail when it is broken. Never weaken a check to make it pass.
6. Older run instructions may exist in prompts/; they are background. This message and BRIEF.md win.

WHAT THE LAB DOES FOR YOU
- Commits your work when you finish. Do not commit, branch or rewrite git history yourself.
- Runs your checks, and opens web apps in a headless browser for screenshots and errors.
- Reverts this session if the product got worse (a failing check, a blank page, new errors). The next session is told why.
- Has an independent reviewer judge the product after your session; its critique steers the next one.

LIMITS
- No sudo, no system services, nothing outside this project folder, no replies from anyone. When something is out of reach, design around it (for example, read a local file instead of calling a service) and note it under Constraints in BRIEF.md.
- The lab serves this folder as static files${playPath ? ` at ${playPath}` : ''}. A web app needs an index.html at the folder root that works when served that way: no dev server, relative paths only.

${briefExists ? '' : `BRIEF.md TEMPLATE
${BRIEF_TEMPLATE}

`}WHEN YOU FINISH, append exactly this to reports/RUN_LOG.md:

## Run ${runNumber} — ${today} — ${type}

**Goal:** <the outcome you chose>
**What changed:** <what a person would notice, in plain words>
**Verified:** <what you ran, used or looked at, and what you saw>
**Next:** <the most valuable next goal>
`
}

export function reviewPrompt({ name = 'this project', idea = '', runNumber = 1, whatChanged = '', diffStat = '', checksLine = '', shots = [] }) {
  const shotLines = shots.length
    ? shots.map(shot => `  - ${shot}`).join('\n')
    : '  (none: this is not a web app, or the browser was unavailable)'
  return `You are an independent reviewer for "${name}", one project in an autonomous software lab. You did not build it. Judge it the way the person who asked for it would.

THE IDEA
${idea || '(not recorded; see README.md and BRIEF.md)'}

WHAT TO LOOK AT
- BRIEF.md: what the product should be, and its "Done means" list.
- The product itself. Screenshots of the running app after this session (open and look at them):
${shotLines}
- The lab's checks: ${checksLine || 'none ran'}.
- What the builder says changed in session ${runNumber} (verify it, do not trust it): ${whatChanged ? clip(whatChanged, 500) : '(not reported)'}
- Files changed this session: ${diffStat ? clip(diffStat, 600) : '(unknown)'}
Read code only where it helps you judge what a person would experience.

Do not modify any file. Reply with exactly this block and nothing after it:

**Verdict:** better | same | worse — <one sentence, compared with before this session>
**Rating:** <0-5>/5 — <how good the product is for a person right now>
**Done:** yes | no — <does it meet every "Done means" item in BRIEF.md>
**Top problems:**
1. <the problem a person would feel most>
2. <next>
3. <next>
**Cut:** <what to delete or simplify, or "nothing">
`
}

// Last occurrence of each field wins: an agent's final answer comes last.
export function parseReview(text = '') {
  const source = String(text || '')
  const last = re => {
    let match = null
    let found
    const global = new RegExp(re.source, 'gim')
    while ((found = global.exec(source))) match = found
    return match
  }
  const verdict = last(/^\s*\*\*Verdict:\*\*\s*(better|same|worse)\b\s*[—–:-]*\s*(.*)$/)
  const rating = last(/^\s*\*\*Rating:\*\*\s*(\d(?:\.\d+)?)\s*\/\s*5\b\s*[—–:-]*\s*(.*)$/)
  const done = last(/^\s*\*\*Done:\*\*\s*(yes|no)\b\s*[—–:-]*\s*(.*)$/)
  const cut = last(/^\s*\*\*Cut:\*\*\s*(.*)$/)
  const problems = []
  const problemsAt = source.search(/^\s*\*\*Top problems:\*\*/im)
  if (problemsAt >= 0) {
    for (const line of source.slice(problemsAt).split('\n').slice(1)) {
      if (/^\s*\*\*[^*]+:\*\*/.test(line)) break
      const item = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)
      if (item) problems.push(clip(item[1], 400))
    }
  }
  const value = verdict && rating && done ? {
    ok: true,
    verdict: verdict[1].toLowerCase(),
    verdictNote: clip(verdict[2], 300),
    rating: Math.max(0, Math.min(5, Number(rating[1]))),
    ratingNote: clip(rating[2], 300),
    done: done[1].toLowerCase() === 'yes',
    doneNote: clip(done[2], 300),
    problems: problems.slice(0, 5),
    cut: cut ? clip(cut[1], 400) : '',
  } : { ok: false }
  return value
}

export function reviewLine(review) {
  if (!review?.ok) return 'unavailable'
  const parts = [review.verdict, `${review.rating}/5`, review.done ? 'meets the brief' : 'not done yet']
  return `${parts.join(' · ')}${review.problems[0] ? ` — ${clip(review.problems[0], 200)}` : ''}`
}

// ─── Keep or revert ───────────────────────────────────────────────────────────

// Only hard, objective breakage reverts a session: a failing check, a blank
// page, or new uncaught/console errors. The app harness's softer heuristics
// (did a guessed "primary" button visibly change something) never do.
export function breakage(baseline = null, after = null) {
  const reasons = []
  if (after?.check?.state === 'fail' && baseline?.check?.state !== 'fail') {
    reasons.push(`${after.check.command || 'the check'} failed${after.check.detail ? `: ${clip(after.check.detail.split('\n').filter(Boolean).slice(-1)[0], 200)}` : ''}`)
  }
  const app = after?.app
  const before = baseline?.app?.ran ? baseline.app : null
  if (app?.ran) {
    if (app.blank && !before?.blank) reasons.push('the app now renders a blank page')
    if (app.pageErrors > (before?.pageErrors || 0)) reasons.push(`${app.pageErrors} uncaught page error${app.pageErrors === 1 ? '' : 's'} in the app`)
    if (app.consoleErrors > (before?.consoleErrors || 0)) reasons.push(`${app.consoleErrors} console error${app.consoleErrors === 1 ? '' : 's'} in the app (was ${before?.consoleErrors || 0})`)
  }
  return reasons
}

export function checksLine(checks = null) {
  if (!checks) return 'not run'
  const parts = []
  const check = checks.check
  parts.push(check?.state === 'none' || !check ? 'no check script' : `${check.command} ${check.state}`)
  const app = checks.app
  if (app?.ran) {
    const errors = (app.pageErrors || 0) + (app.consoleErrors || 0)
    parts.push(`app opened${app.blank ? ' blank' : ''}${errors ? ` with ${errors} error${errors === 1 ? '' : 's'}` : ' cleanly'}`)
  } else if (app?.state === 'unavailable') {
    parts.push('browser unavailable')
  }
  return parts.join(' · ')
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function git(repo, args, options = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: options.timeout ?? 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return {
    ok: result.status === 0,
    out: String(result.stdout || '').trim(),
    err: String(result.stderr || result.error?.message || '').trim(),
  }
}

function realpath(target) {
  try { return fs.realpathSync(target) } catch { return path.resolve(target) }
}

function ensureLabExcludes(repo) {
  const gitDir = git(repo, ['rev-parse', '--git-dir']).out
  if (!gitDir) return
  const excludePath = path.resolve(repo, gitDir, 'info', 'exclude')
  let current = ''
  try { current = fs.readFileSync(excludePath, 'utf8') } catch {}
  const missing = LAB_EXCLUDES.filter(line => !current.split('\n').includes(line))
  if (!missing.length) return
  fs.mkdirSync(path.dirname(excludePath), { recursive: true })
  fs.appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}# Pi Pulse lab: caches and lab artifacts\n${missing.join('\n')}\n`)
}

export function headCommit(repo) {
  const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
  return head.ok ? head.out : null
}

function productDirty(repo) {
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all', ...OUTSIDE_REPORTS])
  return status.ok && status.out.length > 0
}

function commitAll(repo, message, { allowEmpty = false } = {}) {
  git(repo, ['add', '-A'])
  const args = [...LAB_GIT, 'commit', '-q', '--no-verify', '-m', message]
  if (allowEmpty) args.push('--allow-empty')
  const result = git(repo, args)
  return result.ok || /nothing to commit/i.test(`${result.out} ${result.err}`)
}

// Before a session: make the project a git repo the lab can commit to and
// revert in, and pin the baseline the session will be judged against.
export function prepareRatchet({ repo, lastGoodCommit = null, runNumber = 0 }) {
  const off = reason => ({ ratchet: 'off', reason, baseline: null, adopted: false, leftovers: 'none', headMoved: false })
  try {
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return off('project folder is missing')
    const top = git(repo, ['rev-parse', '--show-toplevel'])
    if (top.ok) {
      if (realpath(top.out) !== realpath(repo)) return off(`the project is inside another git repository (${top.out}); the lab will not commit or revert there`)
    } else {
      const init = git(repo, ['init', '-q'])
      if (!init.ok) return off(`git init failed: ${clip(init.err, 200)}`)
    }
    ensureLabExcludes(repo)
    let adopted = false
    let leftovers = 'none'
    if (!headCommit(repo)) {
      if (!commitAll(repo, 'Baseline: the project before autonomous sessions', { allowEmpty: true })) return off('could not create the baseline commit')
      adopted = true
    } else if (!lastGoodCommit) {
      if (productDirty(repo)) {
        if (!commitAll(repo, 'Baseline: work before autonomous sessions')) return off('could not commit the existing work')
      }
      adopted = true
    } else if (productDirty(repo)) {
      // An interrupted session (stopped, killed, rebooted) left unverified
      // changes. Stash them: recoverable with `git stash list`, never lost.
      const stash = git(repo, ['stash', 'push', '-u', '-q', '-m', `pi-pulse: leftovers of an interrupted session (before run ${runNumber})`, ...OUTSIDE_REPORTS])
      if (stash.ok) leftovers = 'stashed'
      else if (commitAll(repo, `Checkpoint: leftovers of an interrupted session (before run ${runNumber})`)) leftovers = 'committed'
      else return off(`could not set aside an interrupted session's changes: ${clip(stash.err, 200)}`)
    }
    const baseline = headCommit(repo)
    if (!baseline) return off('no baseline commit')
    return { ratchet: 'on', reason: '', baseline, adopted, leftovers, headMoved: Boolean(lastGoodCommit && baseline !== lastGoodCommit) }
  } catch (err) {
    return off(`git unavailable: ${clip(err.message, 200)}`)
  }
}

export function productChanged(repo, baseline) {
  return productDirty(repo) || (baseline && headCommit(repo) !== baseline)
}

// What a kept session changed (it is committed by the time anyone asks).
export function diffStat(repo, baseline) {
  if (!baseline) return ''
  const stat = git(repo, ['diff', '--stat=100', baseline, 'HEAD', ...OUTSIDE_REPORTS])
  return stat.ok ? stat.out.split('\n').slice(-12).join('\n') : ''
}

export function keepSession(repo, message) {
  if (!commitAll(repo, message)) return null
  return headCommit(repo)
}

// Back to the baseline, except reports/: the lab's history of the session
// (its run log entry, transcripts, evidence) must survive the revert.
export function revertSession(repo, baseline) {
  git(repo, ['reset', '-q', '--mixed', baseline])
  const checkout = git(repo, ['checkout', baseline, ...OUTSIDE_REPORTS])
  if (!checkout.ok && !/did not match any file/i.test(checkout.err)) return { ok: false, error: clip(checkout.err, 300) }
  git(repo, ['clean', '-fdq', ...OUTSIDE_REPORTS])
  const clean = !productDirty(repo) && headCommit(repo) === baseline
  return clean ? { ok: true } : { ok: false, error: 'the working tree still differs from the baseline after reverting' }
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function tailLines(text, lines = 12, max = 800) {
  return String(text || '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-lines).join('\n').slice(-max)
}

function checkCommands(repo) {
  if (fs.existsSync(path.join(repo, 'check.sh'))) return { label: './check.sh', commands: [['bash', ['check.sh']]] }
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) } catch {}
  const scripts = pkg?.scripts || {}
  const commands = []
  const labels = []
  if (scripts.build) { commands.push(['npm', ['run', '--silent', 'build']]); labels.push('npm run build') }
  if (scripts.test && !/no test specified/i.test(scripts.test)) { commands.push(['npm', ['test', '--silent']]); labels.push('npm test') }
  return commands.length ? { label: labels.join(' + '), commands } : null
}

export function runChecks({ repo, label, appEvidenceScript = null, timeoutMs = 600000 }) {
  const result = { at: new Date().toISOString(), check: { state: 'none', command: null, detail: '' }, app: { state: 'n/a', ran: false } }
  const plan = checkCommands(repo)
  if (plan) {
    result.check.command = plan.label
    result.check.state = 'pass'
    for (const [command, args] of plan.commands) {
      const run = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
      if (run.status !== 0) {
        result.check.state = 'fail'
        result.check.detail = run.error?.code === 'ETIMEDOUT' || run.signal
          ? `${[command, ...args].join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s`
          : tailLines(`${run.stdout || ''}\n${run.stderr || ''}`) || `${[command, ...args].join(' ')} exited ${run.status}`
        break
      }
    }
  }
  const isWeb = fs.existsSync(path.join(repo, 'index.html'))
  if (isWeb && appEvidenceScript && fs.existsSync(appEvidenceScript)) {
    spawnSync(process.execPath, [appEvidenceScript, '--repo', repo, '--run', label, '--type', 'session'], { cwd: repo, encoding: 'utf8', timeout: 240000 })
    const dir = path.join(repo, 'reports', 'evidence', `run-${label}`)
    let summary = null
    try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) } catch {}
    const ran = summary && ['semantic', 'degraded'].includes(summary.evidenceMode)
    result.app = {
      state: !summary ? 'unavailable' : summary.evidenceMode === 'unavailable' ? 'unavailable' : summary.gate || 'NEEDS-EVIDENCE',
      ran: Boolean(ran),
      blank: Boolean(ran && summary.blank),
      pageErrors: ran ? Number(summary.pageErrorCount || 0) : 0,
      consoleErrors: ran ? Number(summary.consoleErrorCount || 0) : 0,
      notes: clip((summary?.notes || []).join(' '), 400),
      evidence: `run-${label}`,
      shots: ['desktop.png', 'mobile.png', 'after-action.png'].filter(file => fs.existsSync(path.join(dir, file))),
    }
  }
  return result
}

// ─── Run log ──────────────────────────────────────────────────────────────────

// Adds harness fields to the end of run N's own section, even when other
// sections (a steering note written mid-run) were appended after it.
export function insertIntoRunSection(text, runNumber, lines, { date = new Date().toISOString().slice(0, 10), type = 'SESSION' } = {}) {
  const source = String(text || '')
  const heading = new RegExp(`^## Run ${runNumber}(?!\\d)[^\\n]*$`, 'gm')
  let last = null
  let match
  while ((match = heading.exec(source))) last = match
  const block = lines.filter(Boolean).join('\n')
  if (!last) return `${source.replace(/\s*$/, '')}\n\n## Run ${runNumber} - ${date} - ${type}\n\n${block}\n`
  const start = last.index + last[0].length
  const nextHeading = source.slice(start).search(/^## /m)
  const end = nextHeading < 0 ? source.length : start + nextHeading
  const before = source.slice(0, end).replace(/\s*$/, '')
  const after = nextHeading < 0 ? '' : `\n${source.slice(end)}`
  return `${before}\n${block}\n${after}`
}

export function runFields(text, runNumber) {
  const heading = new RegExp(`^## Run ${runNumber}(?!\\d)[^\\n]*$`, 'gm')
  let last = null
  let match
  while ((match = heading.exec(String(text || '')))) last = match
  if (!last) return {}
  const rest = String(text).slice(last.index + last[0].length)
  const next = rest.search(/^## /m)
  const fields = {}
  for (const line of (next < 0 ? rest : rest.slice(0, next)).split('\n')) {
    const field = line.match(/^\*\*(.+?):\*\*\s*(.*)$/)
    if (field) fields[field[1].trim()] = field[2].trim()
  }
  return fields
}
