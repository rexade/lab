#!/usr/bin/env node
// Node side of scripts/run-incubator.sh. The shell script owns process control
// (agents, timeouts, transcripts); this file owns JSON, git and RUN_LOG.md so
// both agents (Codex, Claude) share one implementation. See lib/session.mjs.
//
//   config         <status.json>                               -> KEY=value lines
//   recent-runs    <RUN_LOG.md> <RECENT_RUNS.md>
//   session-begin  <status.json> <run#>                        -> KEY=value lines
//   session-prompt <status.json> <run#> <today>                -> the builder's prompt
//   session-end    <status.json> <run#> <today> <agentExit> <agent> <claudeModel> <stdoutFile>  -> KEY=value lines
//   review-prompt  <status.json> <run#>                        -> the reviewer's prompt
//   review-apply   <status.json> <run#> <reviewExit> <reviewer>   (review text on stdin)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capturedFailureDetail, parseRunsFromLog, resolveClaudeModel, resolveClaudePermissionMode, resolveCodexReasoningEffort, summarizeRun } from '../../server-core.js'
import { routeSlugForProject } from '../../server/util.js'
import {
  breakage,
  checksAllowCompletion,
  CHECKS_VERSION,
  checksLine,
  diffStat,
  ideaFor,
  insertIntoRunSection,
  keepSession,
  newNotes,
  nextStage,
  lifecycleOf,
  milestoneSnapshot,
  prepareRatchet,
  productChanged,
  parseReview,
  reviewLine,
  reviewPrompt,
  revertSession,
  runChecks,
  runFields,
  sessionPrompt,
  sessionStage,
  STAGE_TYPE,
  steeringNotes,
} from './session.mjs'

const [command, ...args] = process.argv.slice(2)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_EVIDENCE_SCRIPT = process.env.APP_EVIDENCE_SCRIPT || path.join(HERE, '..', 'app-evidence.mjs')
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT || 600) * 1000

// Fields of the retired self-graded quality contract. Sessions are judged by
// the lab's checks and an independent review instead, so a stale self-grade
// must not linger in status.json and steer the scheduler.
const LEGACY_FIELDS = [
  'lastQualityGate', 'lastEvidenceConfidence', 'lastQualitySummary', 'lastNorthStar', 'lastRunStrategy',
  'lastWhyRunType', 'lastExpectedQualityDelta', 'lastActualQualityDelta', 'lastPlateauRegressionVerdict',
  'lastRecoveryRequired', 'lastRecoveryMode', 'lastNeedsHuman', 'lastAppEvidencePath', 'lastAppEvidenceGate',
  'lastAppEvidenceTopTier', 'lastAppEvidenceMode', 'lastAppEvidencePrimaryAction', 'lastAppEvidenceSemanticSuccess',
  'lastAppEvidenceSummary',
]

const RUN_STATUS = { kept: 'ok', 'no-changes': 'no-changes', reverted: 'reverted', regressed: 'regressed', failed: 'failed' }

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return '' }
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function printValues(values) {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${oneLine(value)}`)
}

// Pi Pulse reads status.json while runs are in flight; a torn write would read
// as corrupt, so replace it atomically.
function writeJsonAtomic(filePath, value) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

function writeTextAtomic(filePath, text) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, filePath)
}

function resolveAgent(status) {
  const requested = process.env.PI_PULSE_AGENT
  if (requested === 'codex' || requested === 'claude') return requested
  return status.runner === 'claude' ? 'claude' : 'codex'
}

function bypassFor(agent) {
  // Autonomous runs never bypass the sandbox, whatever the service env says.
  if (process.env.PI_PULSE_SCHEDULED_RUN === '1') return ''
  const flag = agent === 'claude' ? process.env.CLAUDE_BYPASS : process.env.CODEX_BYPASS
  return flag === '1' ? '1' : ''
}

function feedbackPathFor(status) {
  return status.feedbackPath || path.join(status.repo, 'reports', 'USER_FEEDBACK.md')
}

function briefExists(repo) {
  return fs.existsSync(path.join(repo, 'BRIEF.md'))
}

function reviewerFor(status, agent) {
  return status.reviewer === 'codex' || status.reviewer === 'claude' ? status.reviewer : agent
}

function reviewEnabled(status) {
  return process.env.PI_PULSE_REVIEW !== '0' && status.review !== false
}

function recentSessions(logPath) {
  try {
    return parseRunsFromLog(readText(logPath)).slice(-3).map(run => ({
      num: run.num,
      type: run.type,
      outcome: String(run.Outcome || '').split(/\s[·—]\s|\s-\s/)[0] || '',
      summary: run['What changed'] || summarizeRun(run) || '',
    }))
  } catch {
    return []
  }
}

function lastOutcomeSentence(status) {
  const num = Number(status.runCount || 0)
  if (!num || !status.lastOutcome) return ''
  const reason = status.lastOutcomeReason ? ` (${status.lastOutcomeReason})` : ''
  switch (status.lastOutcome) {
    case 'kept': return `The last session (#${num}) was kept.`
    case 'reverted': return `The last session (#${num}) was reverted${reason}; the product is back to the last good version, so try a different approach.`
    case 'regressed': return `The last session (#${num}) made the product worse${reason}, and version control is off, so it could not be reverted: fix that first.`
    case 'failed': return `The last session (#${num}) failed${reason}; its changes were discarded.`
    case 'no-changes': return `The last session (#${num}) changed nothing.`
    default: return ''
  }
}

function commitMessage({ runNumber, type, fields, agent }) {
  const headline = oneLine(fields['What changed'] || fields.Goal || 'session changes').slice(0, 72)
  const body = [
    fields.Goal ? `Goal: ${oneLine(fields.Goal)}` : null,
    fields.Verified ? `Verified: ${oneLine(fields.Verified)}` : null,
    `Autonomous session by ${agent} via Pi Pulse.`,
  ].filter(Boolean).join('\n')
  return `Run ${runNumber} (${type}): ${headline}\n\n${body}`
}

function finishSession(status, extra = {}) {
  const session = status.session || {}
  status.lastSession = {
    run: session.run ?? null,
    stage: session.stage ?? null,
    type: session.type ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: new Date().toISOString(),
    outcome: session.outcome ?? status.lastOutcome ?? null,
    ...extra,
  }
  delete status.session
}

function advanceSession(status, session, review = null) {
  const milestone = milestoneSnapshot(status.repo)
  const newMilestone = Boolean(milestone && milestone.key !== status.lastMilestone?.key && !(status.milestoneHistory || []).some(m => m.key === milestone.key))
  const checks = status.lastSessionChecks
  const canComplete = checksAllowCompletion(checks)
  const next = nextStage({
    stage: session.stage, outcome: session.outcome, briefExists: Boolean(milestone), newMilestone,
    review: review?.ok && canComplete ? review : null,
  })
  status.stage = next.stage
  status.polishSessions = 0
  status.milestone = milestone
  if (next.stage === 'done' && newMilestone) {
    const completed = { ...milestone, completedAt: new Date().toISOString(), run: session.run, commit: status.lastGoodCommit, reviewer: review.reviewer }
    status.lastMilestone = completed
    status.milestoneCount = Number(status.milestoneCount || 0) + 1
    status.milestoneHistory = [...(status.milestoneHistory || []), completed].slice(-30)
    try {
      writeTextAtomic(status.runLog, insertIntoRunSection(readText(status.runLog), session.run, [`**Milestone:** ${oneLine(milestone.goal)}`]))
    } catch (err) { console.error(`[incubator] could not log milestone: ${err.message}`) }
  }
}

const commands = {
  config([statusPath]) {
    let status
    try {
      status = readJson(statusPath)
    } catch (err) {
      console.error(`[incubator] cannot read status file ${statusPath}: ${err.message}`)
      process.exit(2)
    }
    const missing = ['project', 'repo', 'runLog'].filter(key => !status[key])
    if (missing.length) {
      console.error(`[incubator] ${statusPath} is missing required field(s): ${missing.join(', ')}`)
      process.exit(2)
    }
    const agent = resolveAgent(status)
    const godot = status.godotAi || {}
    printValues({
      agent,
      reviewer: reviewerFor(status, agent),
      project: status.project,
      repo: status.repo,
      runLog: status.runLog,
      recentRuns: status.recentRuns || path.join(path.dirname(status.runLog), 'RECENT_RUNS.md'),
      runCount: Math.max(0, Math.floor(Number(status.runCount) || 0)),
      bypass: bypassFor(agent),
      codexModel: status.codexModel || process.env.CODEX_MODEL || '',
      codexReasoningEffort: resolveCodexReasoningEffort(status.codexReasoningEffort),
      claudeModel: agent === 'claude' || reviewerFor(status, agent) === 'claude' ? resolveClaudeModel(status.claudeModel) : '',
      claudePermissionMode: agent === 'claude' ? resolveClaudePermissionMode(status.claudePermissionMode) : '',
      godotAiEnabled: godot.enabled ? '1' : '',
      godotAiMcpUrl: godot.mcpUrl || '',
      godotAiStatusUrl: godot.statusUrl || 'http://127.0.0.1:8020/godot-ai/status',
      godotAiVersion: godot.serverVersion || '',
      godotAiLog: godot.log || path.join(status.repo, 'reports', 'godot-ai', 'editor.log'),
    })
  },

  'recent-runs'([logPath, recentPath]) {
    const text = readText(logPath)
    const runs = text.split(/(?=^## Run \d)/m).map(s => s.trim()).filter(s => s.startsWith('## Run'))
    const recent = runs.slice(-4)
    fs.mkdirSync(path.dirname(recentPath), { recursive: true })
    fs.writeFileSync(recentPath, [
      '# Recent Runs\n\n',
      '*Auto-generated. Last 4 runs. Full history in RUN_LOG.md.*\n\n---\n\n',
      recent.length ? recent.join('\n\n---\n\n') : '*(no runs yet)*\n',
    ].join(''))
  },

  // Pins the stage, the git baseline, and the baseline checks the session is
  // judged against. Never fails the run: without git the ratchet is just off.
  'session-begin'([statusPath, runNumber]) {
    const status = readJson(statusPath)
    const repo = status.repo
    if (status.stage === 'done' && !status.lastMilestone) {
      const previous = milestoneSnapshot(repo)
      if (previous) status.lastMilestone = { ...previous, legacy: true }
    }
    const stage = sessionStage(status, briefExists(repo))
    const ratchet = prepareRatchet({ repo, lastGoodCommit: status.lastGoodCommit || null, runNumber })
    let baselineChecks = null
    if (ratchet.ratchet === 'on') {
      const known = status.lastChecks?.version === CHECKS_VERSION && status.lastGoodCommit === ratchet.baseline && !ratchet.adopted
      baselineChecks = known ? status.lastChecks : runChecks({ repo, label: `${runNumber}-baseline`, appEvidenceScript: APP_EVIDENCE_SCRIPT, timeoutMs: CHECK_TIMEOUT_MS })
    }
    status.stage = stage
    status.polishSessions = 0
    status.ratchet = ratchet.ratchet
    status.ratchetReason = ratchet.reason || null
    status.session = {
      run: Number(runNumber),
      startedAt: new Date().toISOString(),
      stage,
      type: STAGE_TYPE[stage],
      ratchet: ratchet.ratchet,
      baseline: ratchet.baseline,
      baselineChecks,
      milestoneBefore: milestoneSnapshot(repo),
      leftovers: ratchet.leftovers,
    }
    writeJsonAtomic(statusPath, status)
    const note = ratchet.ratchet === 'off'
      ? `version control off: ${ratchet.reason}`
      : ratchet.adopted ? 'existing work committed as the baseline'
        : ratchet.leftovers === 'stashed' ? "an interrupted session's changes were set aside (git stash)"
          : ratchet.leftovers === 'committed' ? "an interrupted session's changes were committed as a checkpoint" : ''
    printValues({ stage, type: STAGE_TYPE[stage], ratchet: ratchet.ratchet, baseline: ratchet.baseline || '', note })
  },

  'session-prompt'([statusPath, runNumber, today]) {
    const status = readJson(statusPath)
    const repo = status.repo
    const feedbackText = readText(feedbackPathFor(status))
    const session = status.session || {}
    const stage = session.stage || sessionStage(status, briefExists(repo))
    const lastOutcome = [
      lastOutcomeSentence(status),
      session.leftovers === 'stashed' ? "An interrupted session's unverified changes were set aside with git stash; the project is at its last good version." : '',
      session.ratchet === 'off' ? `Version control is off for this project (${status.ratchetReason || 'unavailable'}): nothing can be reverted, so keep the product working at every step.` : '',
    ].filter(Boolean).join(' ')
    process.stdout.write(sessionPrompt({
      name: status.displayName || status.incubatorTitle || status.project,
      idea: ideaFor(status, feedbackText, readText(path.join(repo, 'README.md'))),
      stage,
      type: STAGE_TYPE[stage],
      runNumber: Number(runNumber),
      today,
      briefExists: briefExists(repo),
      lastOutcome,
      review: status.lastReview?.ok ? status.lastReview : null,
      notes: newNotes(steeringNotes(feedbackText), status.notesSeenAt || null),
      recent: recentSessions(status.runLog),
      playPath: `/${routeSlugForProject(status.project)}/`,
      lifecycle: lifecycleOf(status),
      lastMilestone: status.lastMilestone,
      milestones: status.milestoneHistory,
      runtimeMinutes: Math.round(Number(process.env[resolveAgent(status) === 'claude' ? 'CLAUDE_TIMEOUT' : 'CODEX_TIMEOUT'] || 2400) / 60),
    }))
  },

  // Judges the session: checks, then keep (commit) or revert, then records the
  // outcome in RUN_LOG.md and status.json. Prints whether a review should run.
  'session-end'([statusPath, runNumber, today, agentExit, agent, model, stdoutFile]) {
    const status = readJson(statusPath)
    const repo = status.repo
    const run = Number(runNumber)
    const fallbackStage = sessionStage(status, briefExists(repo))
    const session = status.session?.run === run ? status.session : {
      run,
      stage: fallbackStage,
      type: STAGE_TYPE[fallbackStage],
      ratchet: 'off',
      baseline: null,
      baselineChecks: null,
      startedAt: null,
    }
    const ratchetOn = session.ratchet === 'on' && Boolean(session.baseline)
    const agentOk = agentExit === '0'
    let outcome
    let reason = ''
    let checks = null
    let commit = null

    if (!agentOk) {
      outcome = 'failed'
      reason = agentExit === '124' || agentExit === '137' ? `${agent} ran out of time` : `${agent} exited ${agentExit}`
      if (ratchetOn && productChanged(repo, session.baseline)) {
        const reverted = revertSession(repo, session.baseline)
        reason += reverted.ok ? '; its changes were discarded' : `; its changes could not be discarded (${reverted.error})`
      }
    } else if (ratchetOn && !productChanged(repo, session.baseline)) {
      outcome = 'no-changes'
      // Fresh checks: unchanged files alone do not prove a milestone is complete.
      checks = runChecks({ repo, label: String(run), appEvidenceScript: APP_EVIDENCE_SCRIPT, timeoutMs: CHECK_TIMEOUT_MS })
    } else {
      checks = runChecks({ repo, label: String(run), appEvidenceScript: APP_EVIDENCE_SCRIPT, timeoutMs: CHECK_TIMEOUT_MS })
      const problems = breakage(session.baselineChecks, checks)
      if (problems.length && ratchetOn) {
        const reverted = revertSession(repo, session.baseline)
        outcome = 'reverted'
        reason = problems.join('; ') + (reverted.ok ? '' : ` (revert incomplete: ${reverted.error})`)
      } else if (ratchetOn) {
        commit = keepSession(repo, commitMessage({ runNumber: run, type: session.type, fields: runFields(readText(status.runLog), run), agent }))
        outcome = 'kept'
        if (!commit) reason = 'the lab could not commit it'
      } else {
        outcome = problems.length ? 'regressed' : 'kept'
        reason = problems.join('; ')
      }
    }

    const outcomeText = outcome === 'kept'
      ? `kept${commit ? ` · ${commit.slice(0, 7)}` : ''}${reason ? ` — ${reason}` : ''}`
      : outcome === 'no-changes' ? 'no changes' : `${outcome} — ${reason}`
    try {
      writeTextAtomic(status.runLog, insertIntoRunSection(readText(status.runLog), run, [
        checks ? `**Checks:** ${checksLine(checks)}` : null,
        `**Outcome:** ${outcomeText}`,
        `**Ended:** ${new Date().toISOString()}`,
      ], { date: today, type: agentOk ? session.type : 'FAILED' }))
    } catch (err) {
      console.error(`[incubator] warning: could not record the session outcome: ${err.message}`)
    }

    status.runner = status.runner || agent
    status.runCount = run
    status.lastRun = today
    status.lastRunType = agentOk ? session.type : 'FAILED'
    status.lastRunnerStatus = agentOk ? 'ok' : 'failed'
    status.lastRunStatus = RUN_STATUS[outcome]
    status.lastOutcome = outcome
    status.lastOutcomeReason = reason || null
    status.lastOutcomeAt = new Date().toISOString()
    status.lastSessionChecks = checks
    if (outcome === 'failed') {
      status.lastRunFailure = `[run failed - ${agent} exited ${agentExit}] ${capturedFailureDetail(stdoutFile, 900) || reason}`.trim()
      status.lastRunFailureSource = 'agent exit'
    } else {
      delete status.lastRunFailure
      delete status.lastRunFailureSource
      delete status.lastRunExit
    }
    if (outcome === 'kept') {
      status.lastChecks = checks
      status.lastGoodCommit = ratchetOn ? (commit || session.baseline) : null
      if (session.startedAt) status.notesSeenAt = session.startedAt
      if (checks?.app?.shots?.length) {
        status.keptEvidence = [...(status.keptEvidence || []), { run, evidence: checks.app.evidence, shots: checks.app.shots, at: new Date().toISOString() }].slice(-3)
      }
    } else if (ratchetOn) {
      status.lastGoodCommit = session.baseline
      status.lastChecks = session.baselineChecks
    } else if (outcome === 'regressed') {
      status.lastChecks = checks
    }
    for (const field of LEGACY_FIELDS) delete status[field]
    if (agent === 'claude') {
      if (model) status.claudeModel = model
      else delete status.claudeModel
    }

    const review = ['kept', 'no-changes'].includes(outcome) && reviewEnabled(status)
    session.outcome = outcome
    status.session = session
    if (!review) {
      advanceSession(status, session)
      finishSession(status)
    }
    writeJsonAtomic(statusPath, status)
    printValues({ outcome, review: review ? '1' : '0', reviewer: reviewerFor(status, agent), reason })
  },

  'review-prompt'([statusPath, runNumber]) {
    const status = readJson(statusPath)
    const repo = status.repo
    const run = Number(runNumber)
    const session = status.session || {}
    const checks = status.lastSessionChecks
    const fields = runFields(readText(status.runLog), run)
    const shots = (checks?.app?.shots || []).map(file => path.join('reports', 'evidence', checks.app.evidence, file))
    process.stdout.write(reviewPrompt({
      name: status.displayName || status.incubatorTitle || status.project,
      idea: ideaFor(status, readText(feedbackPathFor(status)), readText(path.join(repo, 'README.md'))),
      runNumber: run,
      whatChanged: fields['What changed'] || fields.Goal || '',
      diffStat: diffStat(repo, session.baseline),
      checksLine: checksLine(checks),
      shots,
      milestoneBefore: session.milestoneBefore,
      milestone: milestoneSnapshot(repo),
    }))
  },

  // Stores the independent review and moves the project through its stages.
  'review-apply'([statusPath, runNumber, reviewExit, reviewer]) {
    const status = readJson(statusPath)
    const repo = status.repo
    const run = Number(runNumber)
    let text = ''
    try { text = fs.readFileSync(0, 'utf8') } catch {}
    const review = reviewExit === '0' ? parseReview(text) : { ok: false }
    const at = new Date().toISOString()
    const verdictAt = text.lastIndexOf('**Verdict:**')
    const body = review.ok && verdictAt >= 0
      ? text.slice(verdictAt).trim()
      : `The reviewer did not return a usable review (${reviewExit === '0' ? 'no verdict in its reply' : `exit ${reviewExit}`}).`
    try {
      fs.mkdirSync(path.join(repo, 'reports'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'reports', 'REVIEW.md'), `# Review of session ${run}\n\n_Independent review by ${reviewer}, ${at}_\n\n${body}\n`)
      writeTextAtomic(status.runLog, insertIntoRunSection(readText(status.runLog), run, [`**Review:** ${reviewLine(review)}`]))
    } catch (err) {
      console.error(`[incubator] warning: could not record the review: ${err.message}`)
    }
    if (review.ok) {
      status.lastReview = { ...review, run, at, reviewer }
      status.lastQualityRating = review.rating
      delete status.lastReviewError
    } else {
      status.lastReviewError = reviewExit === '0' ? 'the reviewer returned no verdict' : `the reviewer exited ${reviewExit}`
    }
    const session = status.session?.run === run ? status.session : { stage: status.stage, outcome: 'kept' }
    advanceSession(status, session, review.ok ? { ...review, reviewer } : null)
    finishSession(status, { review: review.ok ? review.verdict : 'unavailable' })
    writeJsonAtomic(statusPath, status)
    console.log(`review=${review.ok ? reviewLine(review) : status.lastReviewError}`)
    console.log(`stage=${status.stage}`)
  },
}

// Run as a CLI only when executed directly; tests import the pure helpers.
// Node reports the main module by its real path, so compare real paths.
function invokedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}

if (invokedDirectly()) {
  if (!Object.hasOwn(commands, command)) {
    console.error(`usage: incubator-run.mjs <${Object.keys(commands).join('|')}> ...`)
    process.exit(64)
  }
  commands[command](args)
}
