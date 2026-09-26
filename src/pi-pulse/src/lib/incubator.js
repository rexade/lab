// Pure view-model derivations for incubator slots. Components render these;
// tests pin them without a browser.
import { clip, fmtDuration, timeValue } from './format.js'
import { failureHeadline, runTone } from './runHistory.js'

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

function runTypeAt(slot, index) {
  const types = Array.isArray(slot.runTypes) && slot.runTypes.length ? slot.runTypes : ['mutate', 'research', 'mutate']
  return String(types[index % types.length]).toUpperCase()
}

// The run a launch starts now: runTypes[runCount % length].
export function nextRunType(slot = {}) {
  if (slot.nextRunType) return String(slot.nextRunType).toUpperCase()
  return runTypeAt(slot, Number(slot.runCount || 0))
}

// The run after whatever is in flight: while a run is going, that is one further on.
export function upcomingRun(slot = {}) {
  const count = Number(slot.runCount || 0)
  if (!slot.running?.running) return { num: count + 1, type: nextRunType(slot) }
  return { num: count + 2, type: runTypeAt(slot, count + 1) }
}

export function runnerLabel(runner) {
  return runner === 'claude' ? 'Claude' : runner === 'codex' ? 'Codex' : 'Script'
}

// One state per slot, most urgent first: a person should see the thing that
// needs them before the thing that is merely scheduled.
export function slotState(slot = {}, { preflight = null, now = Date.now() } = {}) {
  const running = slot.running?.running
  if (running) {
    const startedAt = timeValue(slot.running.startTime) || now
    return {
      kind: 'running',
      tone: 'run',
      label: 'Incubating',
      detail: `${nextRunType(slot)} run in progress`,
      startedAt,
    }
  }
  const problems = preflightProblems(preflight)
  if (problems.length) {
    return { kind: 'blocked', tone: 'fail', label: 'Blocked', detail: problems[0], problems }
  }
  if (slot.lastRunStatus === 'failed') {
    const reason = failureHeadline(slot.lastRunFailure || '') || 'the last run failed'
    return { kind: 'failed', tone: 'fail', label: 'Last run failed', detail: clip(reason, 160), nextRunAt: slot.enabled ? timeValue(slot.nextRunAt) : 0 }
  }
  if (!slot.enabled && slot.schedulePauseReason) {
    return { kind: 'paused', tone: 'warn', label: 'Autopilot paused', detail: clip(slot.schedulePauseReason.replace(/^schedule paused:\s*/i, ''), 160) }
  }
  // The agent asked for something only a person can do; the loop keeps running.
  const ask = String(slot.lastNeedsHuman || '').trim()
  if (ask) {
    return { kind: 'needs-human', tone: 'warn', label: 'Needs you', detail: clip(ask, 160), ask, nextRunAt: slot.enabled ? timeValue(slot.nextRunAt) : 0 }
  }
  if (slot.enabled) {
    const at = timeValue(slot.nextRunAt)
    const due = at ? at - now : 0
    return {
      kind: 'scheduled',
      tone: 'ok',
      label: due > 0 ? `Next in ${fmtDuration(due)}` : 'Starting soon',
      detail: `${nextRunType(slot)} next`,
      nextRunAt: at,
    }
  }
  return { kind: 'manual', tone: 'idle', label: 'Manual', detail: 'Autopilot off' }
}

export function qualityState(slot = {}) {
  const gate = slot.lastQualityGate || null
  const appGate = slot.lastAppEvidenceGate || null
  const rating = Number.isFinite(Number(slot.lastQualityRating)) && slot.lastQualityRating !== null ? Number(slot.lastQualityRating) : null
  const confidence = Number.isFinite(Number(slot.lastEvidenceConfidence)) && slot.lastEvidenceConfidence !== null ? Number(slot.lastEvidenceConfidence) : null
  let tone = 'idle'
  let label = 'Not rated yet'
  if (slot.lastRecoveryRequired) { tone = 'warn'; label = 'Recovery mode' }
  else if (appGate === 'FAIL') { tone = 'fail'; label = 'App evidence failed' }
  else if (gate === 'FAIL') { tone = 'fail'; label = 'Quality failed' }
  else if (gate === 'NEEDS-EVIDENCE' || appGate === 'NEEDS-EVIDENCE') { tone = 'warn'; label = 'Needs evidence' }
  else if (gate === 'PASS') { tone = 'ok'; label = 'Quality pass' }
  return { gate, appGate, rating, confidence, tone, label }
}

export function outcomeStrip(runs = [], count = 10) {
  return runs.slice(-count).map(run => ({ num: run.num, type: run.type, tone: runTone(run) }))
}

export function runsOnDay(runsBySlot = {}, day = localDay()) {
  let total = 0
  let failed = 0
  for (const runs of Object.values(runsBySlot)) {
    for (const run of runs || []) {
      if (run?.date !== day) continue
      total += 1
      if (run.type === 'FAILED') failed += 1
    }
  }
  return { total, failed }
}

// Upcoming launches inside the window, repeating each enabled slot's interval.
// The global lock may delay a launch; this is the intended cadence.
export function upcomingSchedule(slots = [], now = Date.now(), windowMs = 6 * 3600 * 1000) {
  const out = []
  for (const slot of slots) {
    if (!slot.enabled) continue
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

// The one sentence at the top of the dashboard.
export function loopHeadline(slots = [], { preflightBySlot = {}, now = Date.now() } = {}) {
  const states = slots.map(slot => ({ slot, state: slotState(slot, { preflight: preflightBySlot[slot.id], now }) }))
  const attention = states.filter(({ state }) => ['blocked', 'failed', 'paused', 'needs-human'].includes(state.kind))
  const running = states.find(({ state }) => state.kind === 'running')
  const autopilot = slots.filter(slot => slot.enabled).length
  const next = states
    .filter(({ slot }) => slot.enabled && !slot.running?.running)
    .map(({ slot }) => ({ slot, at: timeValue(slot.nextRunAt) }))
    .filter(item => item.at)
    .sort((a, b) => a.at - b.at)[0]

  const base = { autopilot, attention: attention.map(({ slot, state }) => ({ id: slot.id, name: slotName(slot), state })) }
  if (!slots.length) {
    return { ...base, tone: 'idle', title: 'No incubators yet', subtitle: 'Describe an idea below and the lab will start building it.', focusId: null }
  }
  if (running) {
    const { slot, state } = running
    return {
      ...base,
      tone: 'run',
      title: `${slotName(slot)} is incubating`,
      subtitle: `${nextRunType(slot)} · via ${runnerLabel(slot.running?.runner || slot.runner)}`,
      focusId: slot.id,
      since: state.startedAt,
    }
  }
  if (next) {
    const due = next.at - now
    return {
      ...base,
      tone: attention.length ? 'warn' : 'ok',
      title: due > 0 ? `Next run in ${fmtDuration(due)}` : 'Next run starting',
      subtitle: `${slotName(next.slot)} · ${nextRunType(next.slot)} · via ${runnerLabel(next.slot.runner)}`,
      focusId: next.slot.id,
      until: next.at,
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
