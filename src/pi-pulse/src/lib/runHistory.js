import { runHistoryKey } from './runSignals.js'

export const RUN_TYPE_COLOR = {
  SHAPE: '#22d3ee',
  DEVELOP: '#34d399',
  BUILD: '#a78bfa',
  POLISH: '#fbbf24',
  CREATE: '#22d3ee',
  MUTATE: '#a78bfa',
  RESEARCH: '#34d399',
  HARVEST: '#fbbf24',
  FAILED: '#f87171',
}

const SESSION_TYPES = ['SHAPE', 'DEVELOP', 'BUILD', 'POLISH']

const SUMMARY_FIELDS = [
  'Failure',
  'Error',
  'What changed',
  'Goal',
  'Acceptance check',
  'Done',
  'What I investigated',
  'Investigated',
  'What I built',
  'What I changed',
  'What changed',
  'What improved',
  'What I found',
  'Finding',
  'Key finding',
  'Quality gate',
  'Quality rating',
  'Output excerpt',
  'Suggested next move',
]

const SYNTHETIC_DONE_RE = /^(Claude|Codex) completed but did not append a run summary\.$/

function isStdoutPathOnly(value = '') {
  return /^Full stdout saved to\s+\S+\s*$/i.test(String(value || '').trim())
}

export function runAttemptText(run = {}) {
  return run.attemptTotal > 1 && run.attempt ? `attempt ${run.attempt}/${run.attemptTotal}` : ''
}

// The most telling line of a failure: the command error when there is one.
export function failureSignal(detail = '') {
  const lines = String(detail).split('\n').map(line => line.trim()).filter(Boolean)
  const commandError = lines.find(line => /command not found|not found|enoent|permission denied|exit status|exit \d+|error|failed/i.test(line))
  return commandError || lines.find(line => !line.startsWith('[run failed')) || lines[0] || 'failure detail unavailable'
}

// The failure as a person would say it: the error itself, without the runner's marker.
export function failureHeadline(detail = '') {
  const line = failureSignal(detail)
  return line.replace(/^\[run failed[^\]]*\]\s*/i, '').trim() || line
}

export function outputSignal(detail = '') {
  const text = String(detail || '')
  const stdoutPath = text.match(/Full stdout saved to\s+(\S+)/i)?.[1]?.replace(/[.)\]]+$/, '')
  if (stdoutPath) return `stdout: ${stdoutPath}`
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.find(line => !/^Output(?: excerpt)?|Stdout tail|Next move/i.test(line)) || lines[0] || 'captured stdout'
}

export function runHistorySummary(run = {}) {
  const syntheticDone = SYNTHETIC_DONE_RE.test(run.Done || '')
  if (syntheticDone && run['Output excerpt'] && !isStdoutPathOnly(run['Output excerpt'])) {
    return run['Output excerpt']
  }
  for (const field of SUMMARY_FIELDS) {
    if (field === 'Done' && syntheticDone) continue
    if ((field === 'Output excerpt' || field === 'Output') && isStdoutPathOnly(run[field])) continue
    if (run[field]) return run[field]
  }
  if (run['Stdout tail']) return run['Stdout tail']
  if (run.Output && !isStdoutPathOnly(run.Output)) return run.Output
  if (run.Done) return run.Done
  if (run['Next move']) return run['Next move']
  return 'stdout captured with no summary'
}

export function runFailureDetail(run = {}) {
  if (run.detail) return run.detail
  return ['Failure', 'Error', 'Output excerpt', 'Output', 'Stdout tail', 'Next move']
    .filter(field => run[field])
    .map(field => `${field}: ${run[field]}`)
    .join('\n')
}

export function runOutputDetail(run = {}) {
  if (run.type === 'FAILED') return runFailureDetail(run)
  const detailFields = [
    'Goal',
    'Verified',
    'Checks',
    'Outcome',
    'Review',
    'Next',
    'Acceptance check',
    'Evidence',
    'Quality gate',
    'Quality rating',
    'Evidence confidence',
    'Risk / regression',
    'Output excerpt',
    'Stdout tail',
    'Output',
    'Next move',
  ]
  return detailFields
    .filter(field => run[field])
    .map(field => `${field}: ${run[field]}`)
    .join('\n')
}

// A session's outcome as the lab recorded it: kept, reverted, failed, no changes.
export function runOutcome(run = {}) {
  if (run.type === 'FAILED') return { key: 'failed', text: run.Outcome || '' }
  const text = String(run.Outcome || '').trim()
  const key = /^kept\b/i.test(text) ? 'kept'
    : /^no changes\b/i.test(text) ? 'no-changes'
      : /^reverted\b/i.test(text) ? 'reverted'
        : /^regressed\b/i.test(text) ? 'regressed'
          : /^failed\b/i.test(text) ? 'failed' : null
  const reason = text.replace(/^(kept|no changes|reverted|regressed|failed)\s*[·—–-]*\s*/i, '')
  return { key, text, reason }
}

export function runTone(run = {}) {
  if (run.type === 'FAILED') return 'fail'
  const outcome = runOutcome(run).key
  if (outcome === 'kept') return 'ok'
  if (outcome === 'reverted') return 'warn'
  if (outcome === 'failed' || outcome === 'regressed') return 'fail'
  if (outcome === 'no-changes') return 'neutral'
  const gate = String(run['Quality gate'] || '').toUpperCase()
  if (gate.startsWith('PASS')) return 'ok'
  if (gate.startsWith('FAIL')) return 'fail'
  if (gate.includes('EVIDENCE')) return 'warn'
  return 'neutral'
}

function recoveredAfterFailure(run) {
  if (!run || run.type === 'FAILED') return false
  const gate = String(run['Quality gate'] || '').toUpperCase()
  return gate === 'PASS' || ['CREATE', 'MUTATE', 'RESEARCH', 'HARVEST', ...SESSION_TYPES].includes(String(run.type || '').toUpperCase())
}

// Newest first. A failure older than the window stays visible (as `pinned`)
// until a later run recovers from it.
export function timelineRuns(runs = [], limit = 8) {
  const recent = runs.slice(-limit)
  const latestFailure = [...runs].reverse().find(run => run?.type === 'FAILED')
  let pinned = null
  if (latestFailure && !recent.includes(latestFailure)) {
    const index = runs.indexOf(latestFailure)
    const recovered = index >= 0 && runs.slice(index + 1).some(recoveredAfterFailure)
    if (!recovered) pinned = latestFailure
  }
  return { runs: [...recent].reverse(), pinned }
}

// The newest failure in view opens by default: a failure must never need a click to be seen.
export function defaultOpenRunKey(runs = [], slotId = 'slot') {
  const index = runs.findIndex(run => run?.type === 'FAILED')
  return index >= 0 ? runHistoryKey(slotId, runs[index], index) : null
}

// What the agent itself said comes next: the newest completed run's own next
// step. Never a field written once at creation and left to go stale.
export function nextMoveFromRuns(runs = []) {
  for (const run of [...runs].reverse()) {
    if (!run || run.type === 'FAILED') continue
    const next = run.Next || run['Next move'] || run['Suggested next move']
    if (next && !/^ask the next run to append/i.test(next)) return next
  }
  return ''
}
