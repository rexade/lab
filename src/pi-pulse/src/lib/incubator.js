// Pure view-model derivations for incubator slots. Components render these;
// tests pin them without a browser.
import { clip, fmtDuration, timeValue } from './format.js'
import { failureHeadline, runHistorySummary, runOutcome, runTone } from './runHistory.js'

const PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#38bdf8', '#f472b6', '#a3e635']

export function slotHue(id = '') {
  let hash = 0
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export function slotName(slot = {}) {
  return slot.displayName || slot.name || slot.project || slot.id || 'Incubator'
}

export function localDay(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function preflightProblems(preflight) {
  if (!preflight || preflight.ok !== false) return []
  const failed = (preflight.checks || []).filter(check => !check.ok)
  if (!failed.length) return [preflight.error || 'runner preflight failed']
  return failed.map(check => `${check.label || check.id || 'check'}: ${check.detail || 'failed'}${check.path ? ` (${check.path})` : ''}`)
}

// A project's life: the lab moves it forward, nobody has to.
export const STAGE_STEPS = [
  { key: 'shaping', label: 'Shaping', type: 'SHAPE', blurb: 'turning the idea into a brief and a first version' },
  { key: 'building', label: 'Building', type: 'BUILD', blurb: 'working toward the current milestone across as many sessions as needed' },
  { key: 'polishing', label: 'Polishing', type: 'POLISH', blurb: 'no new features: clearer, sturdier, simpler' },
  { key: 'done', label: 'Milestone complete', type: 'DEVELOP', blurb: 'reviewed milestone complete; the next session develops the next worthwhile improvement' },
]

export function stageOf(slot = {}) {
  if (slot.stage === 'advancing') return { key: 'advancing', label: 'Next milestone', type: 'DEVELOP', index: 0 }
  if (slot.stage === 'done' && slot.lifecycle === 'finite') return { key: 'done', label: 'Done', type: 'POLISH', index: 3 }
  const index = Math.max(0, STAGE_STEPS.findIndex(step => step.key === slot.stage))
  return { ...STAGE_STEPS[index], index }
}

// The session a launch starts now (a run on a finished project is a polish pass).
export function nextRunType(slot = {}) {
  if (slot.nextRunType) return String(slot.nextRunType).toUpperCase()
  return stageOf(slot).type
}

// The session after whatever is in flight.
export function upcomingRun(slot = {}) {
  const count = Number(slot.runCount || 0)
  return { num: count + (slot.running?.running ? 2 : 1), type: nextRunType(slot) }
}

export function runnerLabel(runner) {
  return runner === 'claude' ? 'Claude' : runner === 'codex' ? 'Codex' : 'Script'
}

export const OUTCOME = {
  kept: { label: 'Kept', tone: 'ok' },
  'no-changes': { label: 'No changes', tone: 'idle' },
  reverted: { label: 'Reverted', tone: 'warn' },
  regressed: { label: 'Made it worse', tone: 'fail' },
  failed: { label: 'Failed', tone: 'fail' },
}

// One state per slot, most urgent first: a person should see what the lab
// cannot fix by itself before what is merely scheduled.
export function slotState(slot = {}, { preflight = null, now = Date.now() } = {}) {
  const running = slot.running?.running
  if (running) {
    const startedAt = timeValue(slot.running.startTime) || now
    return {
      kind: 'running',
      tone: 'run',
      label: 'Incubating',
      detail: `${slot.session?.type || nextRunType(slot)} session in progress`,
      startedAt,
    }
  }
  const problems = preflightProblems(preflight)
  if (problems.length) {
    return { kind: 'blocked', tone: 'fail', label: 'Blocked', detail: problems[0], problems }
  }
  if (slot.lastRunStatus === 'failed') {
    const reason = failureHeadline(slot.lastRunFailure || '') || 'the last session failed'
    return { kind: 'failed', tone: 'fail', label: 'Last session failed', detail: clip(reason, 160), nextRunAt: slot.enabled ? timeValue(slot.nextRunAt) : 0 }
  }
  if (!slot.enabled && slot.schedulePauseReason) {
    return { kind: 'paused', tone: 'warn', label: 'Autopilot paused', detail: clip(slot.schedulePauseReason.replace(/^schedule paused:\s*/i, ''), 160) }
  }
  if (slot.stage === 'done' && slot.lifecycle === 'finite') {
    return { kind: 'resting', tone: 'ok', label: 'Done', detail: 'resting until a note wakes it' }
  }
  if (slot.enabled) {
    const at = timeValue(slot.nextRunAt)
    const due = at ? at - now : 0
    const backingOff = Number(slot.failStreak) > 0 && timeValue(slot.backoffUntil) > now
    const detail = backingOff
      ? `retrying after ${slot.failStreak} session${slot.failStreak === 1 ? '' : 's'} without progress`
      : slot.lastOutcome === 'reverted' ? 'last session reverted' : `${nextRunType(slot)} next`
    return { kind: 'scheduled', tone: 'ok', label: due > 0 ? `Next in ${fmtDuration(due)}` : 'Starting soon', detail, nextRunAt: at }
  }
  return { kind: 'manual', tone: 'idle', label: 'Manual', detail: 'Autopilot off' }
}

// The independent reviewer's latest word on the product.
export function reviewState(slot = {}) {
  const review = slot.lastReview
  if (!review) {
    const legacy = Number.isFinite(Number(slot.lastQualityRating)) && slot.lastQualityRating !== null ? Number(slot.lastQualityRating) : null
    return { reviewed: false, tone: 'idle', label: 'Not reviewed yet', rating: legacy, problems: [] }
  }
  const verdict = String(review.verdict || '')
  return {
    reviewed: true,
    tone: verdict === 'better' ? 'ok' : verdict === 'worse' ? 'fail' : 'idle',
    label: verdict ? `${verdict[0].toUpperCase()}${verdict.slice(1)} than before` : 'Reviewed',
    verdict,
    rating: Number.isFinite(Number(review.rating)) ? Number(review.rating) : null,
    done: review.done === true,
    problems: Array.isArray(review.problems) ? review.problems : [],
    cut: review.cut && !/^(nothing|none|-)\.?$/i.test(review.cut) ? review.cut : '',
    reviewer: review.reviewer || null,
    run: review.run ?? null,
    at: timeValue(review.at),
  }
}

export function outcomeStrip(runs = [], count = 10) {
  return runs.slice(-count).map(run => ({ num: run.num, type: run.type, tone: runTone(run) }))
}

export function runsOnDay(runsBySlot = {}, day = localDay()) {
  let total = 0
  let failed = 0
  let kept = 0
  for (const runs of Object.values(runsBySlot)) {
    for (const run of runs || []) {
      if (run?.date !== day) continue
      total += 1
      if (run.type === 'FAILED') failed += 1
      if (runOutcome(run).key === 'kept') kept += 1
    }
  }
  return { total, failed, kept }
}

// Upcoming launches inside the window, repeating each enabled slot's interval.
// Finished projects rest; the global lock may delay a launch.
export function upcomingSchedule(slots = [], now = Date.now(), windowMs = 6 * 3600 * 1000) {
  const out = []
  for (const slot of slots) {
    if (!slot.enabled || (slot.stage === 'done' && slot.lifecycle === 'finite')) continue
    const intervalMs = Math.max(0.25, Number(slot.intervalHours) || 0.5) * 3600 * 1000
    let at = Math.max(timeValue(slot.nextRunAt) || now, now)
    let first = true
    while (at <= now + windowMs && out.length < 240) {
      out.push({ slotId: slot.id, at, first })
      at += intervalMs
      first = false
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

// What the lab did while you were away: sessions that ended after `since`.
export function awayDigest(slots = [], runsBySlot = {}, since = 0) {
  const items = []
  for (const slot of slots) {
    for (const run of runsBySlot[slot.id] || []) {
      const ended = timeValue(run?.Ended)
      if (!ended || ended <= since) continue
      const outcome = runOutcome(run).key
      items.push({
        slotId: slot.id,
        name: slotName(slot),
        num: run.num,
        type: run.type,
        outcome,
        text: clip(outcome === 'failed' ? failureHeadline(run.Failure || runHistorySummary(run)) : run['What changed'] || runHistorySummary(run), 160),
        ended,
      })
    }
  }
  items.sort((a, b) => b.ended - a.ended)
  const count = key => items.filter(item => item.outcome === key).length
  const finished = slots.filter(slot => slot.stage === 'done' && slot.lifecycle === 'finite' && timeValue(slot.lastOutcomeAt) > since).map(slotName)
  return { items, total: items.length, kept: count('kept'), reverted: count('reverted'), failed: count('failed'), finished }
}

// The one sentence at the top of the dashboard.
export function loopHeadline(slots = [], { preflightBySlot = {}, now = Date.now() } = {}) {
  const states = slots.map(slot => ({ slot, state: slotState(slot, { preflight: preflightBySlot[slot.id], now }) }))
  // Only what the lab cannot fix by itself: a failing slot retries on its own.
  const attention = states.filter(({ state }) => ['blocked', 'paused'].includes(state.kind))
  const running = states.find(({ state }) => state.kind === 'running')
  const autopilot = slots.filter(slot => slot.enabled).length
  const resting = states.filter(({ state }) => state.kind === 'resting')
  const next = states
    .filter(({ slot, state }) => slot.enabled && state.kind !== 'resting' && !slot.running?.running)
    .map(({ slot }) => ({ slot, at: timeValue(slot.nextRunAt) }))
    .filter(item => item.at)
    .sort((a, b) => a.at - b.at)[0]

  const base = { autopilot, resting: resting.length, attention: attention.map(({ slot, state }) => ({ id: slot.id, name: slotName(slot), state })) }
  if (!slots.length) {
    return { ...base, tone: 'idle', title: 'No incubators yet', subtitle: 'Describe an idea below and the lab will start building it.', focusId: null }
  }
  if (running) {
    const { slot, state } = running
    return {
      ...base,
      tone: 'run',
      title: `${slotName(slot)} is incubating`,
      subtitle: `${state.detail} · via ${runnerLabel(slot.running?.runner || slot.runner)}`,
      focusId: slot.id,
      since: state.startedAt,
    }
  }
  if (next) {
    const due = next.at - now
    return {
      ...base,
      tone: attention.length ? 'warn' : 'ok',
      title: due > 0 ? `Next session in ${fmtDuration(due)}` : 'Next session starting',
      subtitle: `${slotName(next.slot)} · ${stageOf(next.slot).label.toLowerCase()} · via ${runnerLabel(next.slot.runner)}`,
      focusId: next.slot.id,
      until: next.at,
    }
  }
  if (resting.length) {
    return {
      ...base,
      tone: attention.length ? 'warn' : 'ok',
      title: 'All caught up',
      subtitle: `${resting.length === 1 ? `${slotName(resting[0].slot)} is` : `${resting.length} projects are`} done and resting. A note or a new idea starts more work.`,
      focusId: attention[0]?.slot?.id ?? resting[0].slot.id,
    }
  }
  return {
    ...base,
    tone: attention.length ? 'warn' : 'idle',
    title: 'The lab is resting',
    subtitle: 'No incubator is on autopilot. Switch one on to let it run feral.',
    focusId: attention[0]?.slot?.id ?? null,
  }
}
