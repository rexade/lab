// The session model for autonomous incubator runs.
//
// One session = one agent owning one goal end to end. The lab (not the agent)
// decides what is kept: every session ends in a git commit, or is reverted when
// the product got measurably worse. A fresh-context reviewer then judges the
// product against its mission and milestone. Reviewed milestone completion
// leads to the next milestone, except for explicitly finite projects.
//
// Pure functions are exported for the trust fixtures; the git and check
// helpers shell out and never throw (a broken repo turns the ratchet off).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const STAGES = ['shaping', 'advancing', 'building', 'polishing', 'done']
export const STAGE_TYPE = { shaping: 'SHAPE', advancing: 'DEVELOP', building: 'BUILD', polishing: 'POLISH', done: 'DEVELOP' }
export const lifecycleOf = (status = {}) => ['finite', 'explore'].includes(status.lifecycle) ? status.lifecycle : 'product'
export const projectRests = (status = {}) => status.stage === 'done' && lifecycleOf(status) === 'finite'

// Lab commits are marked as the lab's, never signed or hooked: the lab runs
// its own checks, and a missing GPG agent or a husky hook must not strand work.
const LAB_GIT = ['-c', 'user.name=Pi Pulse lab', '-c', 'user.email=lab@pi-pulse.local', '-c', 'commit.gpgsign=false']
// Caches and lab artifacts stay out of commits (local .git/info/exclude only;
// the project's own .gitignore is never edited).
const LAB_EXCLUDES = ['reports/stdout/', 'reports/evidence/', 'reports/screenshots/', 'node_modules/', '__pycache__/', '*.pyc', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.cache/', '.tmp/', 'test-results/', 'playwright-report/', '.DS_Store', '.env', '.env.*', '.npmrc', '*.pem', '*.key']
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

// Completing a milestone does not end an ongoing product's development.
export function sessionStage(status = {}, briefExists = false) {
  const stage = currentStage(status, briefExists)
  return stage === 'done' ? lifecycleOf(status) === 'finite' ? 'polishing' : 'advancing' : stage
}

// Where a project goes after a session. `review` is the parsed independent
// review, or null when none ran (a revert or a reviewer failure).
export function nextStage({ stage, outcome, review = null, briefExists = false, newMilestone = true }) {
  let next = stage === 'done' ? 'advancing' : stage
  const productive = outcome === 'kept' || outcome === 'no-changes'
  if (!productive) return { stage: next, polishSessions: 0 }
  if (next === 'advancing' && !newMilestone) return { stage: 'advancing', polishSessions: 0 }
  if (['shaping', 'advancing'].includes(next) && briefExists) next = 'building'
  if (review?.ok && briefExists) {
    if (!review.done || review.verdict === 'worse') next = 'building'
    else next = review.problems?.length ? 'polishing' : 'done'
  }
  // A failed/missing review, or a counter of previous polish runs, cannot finish work.
  return { stage: next, polishSessions: 0 }
}

// Failed and reverted sessions back off; so does a building session that
// changed nothing without a reviewed milestone completion.
export function isUnproductive(status = {}) {
  const runStatus = String(status.lastRunStatus || '').toLowerCase()
  if (runStatus === 'failed' || runStatus === 'reverted' || runStatus === 'quality-failed') return true
  return runStatus === 'no-changes' && status.stage !== 'done'
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
export function parseBrief(text = '', { compact = true } = {}) {
  const source = String(text || '')
  if (!source.trim()) return { exists: false, what: '', done: [], constraints: [] }
  const section = name => {
    const match = source.match(new RegExp(`^##+\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im'))
    return match ? match[1].trim() : ''
  }
  const bullets = body => body.split('\n')
    .map(line => line.match(/^\s*[-*]\s+(?:\[( |x|X)\]\s*)?(.+)$/))
    .filter(Boolean)
    .map(match => ({ text: clip(match[2], compact ? 200 : Infinity), checked: match[1] ? match[1].toLowerCase() === 'x' : null }))
  const what = section('Goal') || section('What it is') || source.replace(/^#.*$/m, '').trim().split(/\n\s*\n/)[0] || ''
  return {
    exists: true,
    what: clip(what.replace(/^[-*]\s+/gm, ''), compact ? 400 : Infinity),
    done: bullets(section('Done means')).slice(0, compact ? 12 : Infinity),
    constraints: bullets(section('Constraints')).map(item => item.text).slice(0, 8),
  }
}

// Checkbox edits do not create a new milestone. Legacy briefs provide the
// first milestone until the builder separates mission from current work.
export function milestoneSnapshot(repo) {
  for (const source of ['MILESTONE.md', 'BRIEF.md']) {
    let text
    try { text = fs.readFileSync(path.join(repo, source), 'utf8') } catch { continue }
    const brief = parseBrief(text, { compact: false })
    if (!brief.what || !brief.done.length) return null
    const goal = brief.what
    const outcomes = brief.done.map(item => item.text)
    const key = createHash('sha256').update(JSON.stringify({ goal, outcomes })).digest('hex').slice(0, 20)
    return { key, goal, outcomes, source }
  }
  return null
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const STAGE_GUIDANCE = {
  shaping: `Shaping. Turn the idea into a product. Write a concise BRIEF.md for its lasting purpose, audience, constraints and important decisions. Choose a meaningful first milestone in MILESTONE.md and start building it in this session. If work already exists, understand and develop it; do not start over. The size of the product is not limited by a session.`,
  advancing: `Developing the next milestone. The previous milestone is complete; the product mission continues. Inspect the actual experience, unresolved problems and opportunities in BRIEF.md. Choose the next substantial improvement and replace MILESTONE.md with its goal and checkable outcomes, then start implementing in this same session. Preserve existing capabilities and useful architectural decisions. Do not repeat a completed checklist or invent cosmetic changes to appear busy. If no change is justified, explain the opportunities considered; the lab will revisit later automatically.`,
  building: `Building. Continue the current milestone in MILESTONE.md (or the legacy "Done means" list in BRIEF.md). A milestone may take many sessions. Work toward its outcomes while keeping the whole product sound.`,
  polishing: `Polishing the current milestone. Resolve the review's concrete problems, make the result coherent, and simplify weak parts. Do not expand the milestone just to keep working. Completion requires a fresh review; there is no fixed number of polishing passes.`,
}

const BRIEF_TEMPLATE = `# <Name>
## What it is
<one or two sentences: what it is and the form it takes>
## For whom
<who uses it, and what they want from it>
## Constraints
- <limits you are designing within>
## Decisions and lessons
- <only important decisions, their reasons, and useful failed approaches>
## Opportunities
- <worthwhile future outcomes, revisable as the product develops>`

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
  lifecycle = 'product',
  lastMilestone = null,
  milestones = [],
  runtimeMinutes = 40,
  services = [],
}) {
  const standing = [
    `- Stage: ${STAGE_GUIDANCE[stage] || STAGE_GUIDANCE.building}`,
    `- This is session ${runNumber}.${lastOutcome ? ` ${lastOutcome}` : ''}`,
    briefExists ? '- Your brief is BRIEF.md: read it first.' : '- There is no BRIEF.md yet: write it before anything else.',
  ]
  if (review) {
    standing.push(`- Latest independent review (full text in reports/REVIEW.md; it describes the previous session, not necessarily the new milestone): ${review.verdict || 'unrated'}${review.rating != null ? `, ${review.rating}/5` : ''}${review.done === true ? ', milestone outcomes met' : review.done === false ? ', milestone outcomes not met yet' : ''}.`)
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
  if (lastMilestone) standing.push(`- Last completed milestone (historical context, not a new task): ${clip(lastMilestone.goal, 400)}.`)
  if (milestones.length) standing.push(`- Earlier completed milestones: ${milestones.slice(-5).map(m => clip(m.goal, 160)).join('; ')}.`)

  return `You are the builder of "${name}", one project in an autonomous software lab on a Raspberry Pi. Nobody is watching this session and nobody can be asked anything: you decide, you build, and you check your own work.

THE IDEA (from the person who owns the lab)
${idea ? idea : '(not recorded; read README.md, BRIEF.md and the code to understand the project)'}

WHERE THINGS STAND
${standing.join('\n')}

DEVELOPMENT HORIZON
${lifecycle === 'finite' ? 'This is a bounded deliverable; finish its agreed scope.' : lifecycle === 'explore' ? 'This creative lab develops a collection of experiments. A promising idea may deserve several milestones. Choose between deepening it and exploring a distinct idea, preserving earlier playable work.' : 'Own this product over time. Its mission persists across milestones and sessions; completing one does not finish the product. Improve the core experience and architecture when justified, including substantial redesign, while preserving what already works. Feature count and code size are not measures of progress.'}
BRIEF.md is the compact product memory. MILESTONE.md contains the current goal and a short "## Done means" checklist. Keep architectural decisions and lessons that help later sessions; avoid an accumulating diary. The owner\'s idea and new notes take precedence over these files. Do not weaken acceptance outcomes just to claim completion; explain any justified scope change for review.
This builder session has up to ${runtimeMinutes} minutes. Finish a checked, usable increment before the limit; an unfinished milestone continues in the next session. Do not stop after planning alone.

THIS SESSION
1. Choose the one goal that would most improve the product for a person using it. The person's new notes come first. Otherwise pick what would make the owner most likely to come back to it; the review's top problem is strong input, not an order. Prefer a change a person would notice in the first minute of use over hardening edge cases, and fix a defect only when it breaks the main flow. State it as an outcome ("a new player knows what to press on the first screen"), not a task list.
2. Build it end to end. Run the product and use it the way a person would; look at what you made (open it, screenshot it, read the output). Fix what you see, and keep going until the goal is met or the session runs out.
3. Leave the product better and simpler than you found it. Deleting weak or unused parts is progress; piling on features is not. Do not build test harnesses, diagnostics pages or recovery tooling as product work: ./check.sh is enough verification.
4. Keep BRIEF.md and MILESTONE.md current when the work changes their relevant decisions, lessons or outcomes.
5. Keep a way to check the product: ./check.sh (or npm test / npm run build) should pass when it works and fail when it is broken. Never weaken a check to make it pass.
6. Older run instructions may exist in prompts/; they are background. This message and BRIEF.md win.

WHAT THE LAB DOES FOR YOU
- Commits your work when you finish. Do not commit, branch or rewrite git history yourself.
- Runs your checks, and opens web apps in a headless browser for screenshots and errors.
- Reverts this session if the product got worse (a failing check, a blank page, new errors). The next session is told why.
- Has an independent reviewer judge the product after your session; its critique steers the next one.

LIMITS
- No sudo, no system services, nothing outside this project folder${services.length ? ' except the local services listed below' : ''}, no replies from anyone. When something is out of reach, design around it (for example, read a local file instead of calling a service) and note it under Constraints in BRIEF.md.
- The lab serves this folder as static files${playPath ? ` at ${playPath}` : ''}. A web app needs an index.html at the folder root that works when served that way: no dev server, relative paths only.
${services.length ? `- This project may call these local Pi services from the page, same-origin, at the relative path _services/<name>/ (for example fetch('_services/${services[0].name}/...') from index.html). Nothing else outside the folder is reachable. You cannot reach them from this session (it has no network): write the calls against the description below, keep a clear state for when a service is slow or down, and the lab's browser check will exercise the real thing.
${services.map(service => `  - ${service.name}: ${service.about}${service.probe ? ` Just before this session, ${service.probe}` : ''}`).join('\n')}
` : ''}
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

export function reviewPrompt({ name = 'this project', idea = '', runNumber = 1, whatChanged = '', diffStat = '', checksLine = '', shots = [], beforeShots = [], visualComparison = false, milestoneBefore = null, milestone = null }) {
  const shotLines = shots.length
    ? shots.map(shot => `  - ${shot}`).join('\n')
    : '  (none: this is not a web app, or the browser was unavailable)'
  return `You are an independent reviewer for "${name}", one project in an autonomous software lab, reviewing on behalf of its owner. You did not build it. You are not a QA tester: the owner does not care how many defects remain, only whether this is becoming something they would want to use. The question behind every answer is: would the owner notice this session's work, and would they come back to the product?

THE IDEA
${idea || '(not recorded; see README.md and BRIEF.md)'}

WHAT TO LOOK AT
- reports/USER_FEEDBACK.md: the owner's latest direction takes precedence over earlier scope.
- BRIEF.md: the lasting product purpose, constraints and decisions. MILESTONE.md: the current goal and "Done means" outcomes (legacy projects may still keep these in BRIEF.md).
- Milestone at session start: ${milestoneBefore ? JSON.stringify(milestoneBefore) : '(not yet defined)'}.
- Milestone now: ${milestone ? JSON.stringify(milestone) : '(not yet defined)'}.
- Judge the milestone against the owner's idea and the whole existing product. Reject weakened criteria, scope drift or regressions hidden by a small passing checklist. A milestone can span many sessions; partial progress is not completion. A milestone made of hardening, recovery paths or verification tooling is itself drift unless the owner asked for it.
- The product itself. Screenshots of the running app after this session (open and look at them):
${shotLines}
${visualComparison ? `- Before-session screenshots for comparison (open both versions; do not infer appearance from filenames):\n${beforeShots.map(shot => `  - ${shot}`).join('\n') || '  (unavailable)'}` : ''}
- The lab's checks: ${checksLine || 'none ran'}.
- What the builder says changed in session ${runNumber} (verify it, do not trust it): ${whatChanged ? clip(whatChanged, 500) : '(not reported)'}
- Files changed this session: ${diffStat ? clip(diffStat, 600) : '(unknown)'}
Read code only where it helps you judge what a person would experience.
- Never ask for evidence the lab cannot produce (real devices, live services the builder cannot reach, owner playtests). If something can only be judged by the owner, say so once in the Rating note and move on.

Do not modify any file. Reply with exactly this block and nothing after it:

**Verdict:** better | same | worse — <one sentence: what the owner would notice, compared with before this session; polish nobody would notice is "same">
**Rating:** <0-5>/5 — <1 = the owner would not open it again, 2 = interesting but not useful yet, 3 = they would try it once, 4 = they would come back to it, 5 = they would prefer it to what they use today>
**Done:** yes | no — <does the current milestone meet its outcomes without weakening the product>
**Top problems:**
<at most 3, most important first: what most stands between this and something the owner would come back to. A missing capability or a broken main flow comes before anything else. Leave out edge cases, error recovery, storage limits and test coverage unless it breaks the main thing a person comes to do. Write "none" if there are none. Future milestones are not blockers.>
**Cut:** <what to delete or simplify so the core is clearer, or "nothing">
${visualComparison ? '**Visual comparison:** <specific observed before/after differences with screenshot filenames; write "unavailable" if either version could not be inspected>' : ''}
`
}

// "none" as the review prompt asks, or as reviewers actually write it: "None —
// the milestone is ready.", "No blocking problems." A line that goes on to name
// something ("None of the buttons respond") is a problem.
const NO_PROBLEMS = /^(?:none|nothing|n\/a|no(?:\s+[a-z-]+){0,2}\s+(?:problems?|issues?|blockers?)(?:\s+(?:remain(?:ing)?|found|left|identified|to report|for this milestone))?)(?:$|[^\p{L}\p{N}\s]|\s+[—–-])/iu

// Last occurrence of each field wins: an agent's final answer comes last.
export function parseReview(text = '') {
  const raw = String(text || '')
  const verdictAt = raw.lastIndexOf('**Verdict:**')
  const source = verdictAt >= 0 ? raw.slice(verdictAt) : raw
  const last = re => {
    let match = null
    let found
    const global = new RegExp(re.source, 'gim')
    while ((found = global.exec(source))) match = found
    return match
  }
  const verdict = last(/^[ \t]*\*\*Verdict:\*\*[ \t]*(better|same|worse)\b[ \t]*[—–:-]*[ \t]*(.*)$/)
  const rating = last(/^[ \t]*\*\*Rating:\*\*[ \t]*(\d(?:\.\d+)?)[ \t]*\/[ \t]*5\b[ \t]*[—–:-]*[ \t]*(.*)$/)
  const done = last(/^[ \t]*\*\*Done:\*\*[ \t]*(yes|no)\b[ \t]*[—–:-]*[ \t]*(.*)$/)
  const cut = last(/^[ \t]*\*\*Cut:\*\*[ \t]*(.*)$/)
  const problems = []
  let explicitNone = false
  const problemsHeader = last(/^[ \t]*\*\*Top problems:\*\*[ \t]*(.*)$/)
  const problemsAt = problemsHeader?.index ?? -1
  const addProblem = line => {
    const item = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)
    const content = (item?.[1] || line).trim()
    if (NO_PROBLEMS.test(content)) explicitNone = true
    else if (content) problems.push(clip(content, 400))
  }
  if (problemsAt >= 0) {
    addProblem(problemsHeader[1])
    for (const line of source.slice(problemsAt + problemsHeader[0].length).split('\n')) {
      if (/^\s*\*\*[^*]+:\*\*/.test(line)) break
      addProblem(line)
    }
  }
  const value = verdict && rating && done && cut && problemsAt >= 0 && (explicitNone || problems.length) ? {
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
  const parts = [review.verdict, `${review.rating}/5`, review.done ? 'meets the milestone' : 'not done yet']
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
    const how = errors ? ` with ${errors} error${errors === 1 ? '' : 's'}` : app.blank === false ? ' cleanly' : app.blank === true ? '' : '; render check incomplete'
    parts.push(`app opened${app.blank === true ? ' blank' : ''}${how}`)
    if (app.inspectionComplete === false) parts.push('browser inspection incomplete')
  } else if (app?.state === 'unavailable') {
    parts.push('browser unavailable')
  }
  return parts.join(' · ')
}

// An inconclusive browser probe must not cause a rollback, but it also cannot
// certify milestone completion. Keep these decisions deliberately separate.
export function checksAllowCompletion(checks) {
  if (!checks || breakage(null, checks).length) return false
  const app = checks.app
  return app?.state !== 'unavailable' && app?.state !== 'NEEDS-EVIDENCE' && app?.inspectionComplete !== false && (!app?.ran || app.blank === false)
}

// ─── Git ──────────────────────────────────────────────────────────────────────

function git(repo, args, options = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: options.timeout ?? 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env } })
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

// Preserve rejected work for inspection without moving HEAD, changing the
// real index or treating it as a kept product version. A private local ref
// keeps the object reachable after rollback and garbage collection.
export function saveRejectedVersion(repo, baseline, runNumber) {
  if (!Number.isSafeInteger(Number(runNumber)) || Number(runNumber) < 1 || !/^[a-f0-9]{40,64}$/.test(baseline || '')) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pulse-candidate-index-'))
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
  const run = args => git(repo, args, { env })
  try {
    if (!run(['read-tree', baseline]).ok || !run(['add', '-A', ...OUTSIDE_REPORTS]).ok) return null
    const tree = run(['write-tree'])
    if (!tree.ok) return null
    const snapshot = run([...LAB_GIT, 'commit-tree', tree.out, '-p', baseline, '-m', `Rejected candidate for run ${runNumber} (not the kept product)`])
    if (!snapshot.ok) return null
    const retained = run(['update-ref', `refs/pi-pulse/candidates/run-${runNumber}`, snapshot.out])
    return retained.ok ? snapshot.out : null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

// Cached baselines from the old checker may contain the false blank-page
// observation, or error counts from a different viewport collection strategy.
export const CHECKS_VERSION = 2

export function runChecks({ repo, label, appEvidenceScript = null, timeoutMs = 600000, services = [] }) {
  const result = { version: CHECKS_VERSION, at: new Date().toISOString(), check: { state: 'none', command: null, detail: '' }, app: { state: 'n/a', ran: false } }
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
    spawnSync(process.execPath, [appEvidenceScript, '--repo', repo, '--run', label, '--type', 'session', ...(services.length ? ['--services', services.join(',')] : [])], { cwd: repo, encoding: 'utf8', timeout: 240000 })
    const dir = path.join(repo, 'reports', 'evidence', `run-${label}`)
    let summary = null
    try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) } catch {}
    const ran = summary && ['semantic', 'degraded'].includes(summary.evidenceMode)
    result.app = {
      state: !summary ? 'unavailable' : summary.evidenceMode === 'unavailable' ? 'unavailable' : summary.gate || 'NEEDS-EVIDENCE',
      ran: Boolean(ran),
      blank: ran && typeof summary.blank === 'boolean' ? summary.blank : null,
      inspectionComplete: Boolean(ran && summary.inspectionComplete !== false),
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
