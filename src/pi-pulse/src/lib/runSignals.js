const SUMMARY_FIELDS = [
  'Failure',
  'Error',
  'Goal',
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
  'Output excerpt',
  'Stdout tail',
  'Output',
  'Suggested next move',
  'Next move',
]

export function runSignalSummary(run = {}) {
  const skipSyntheticDone = /^(Claude|Codex) completed but did not append a run summary\.$/.test(run.Done || '')
  for (const field of SUMMARY_FIELDS) {
    if (field === 'Done' && skipSyntheticDone) continue
    if (run[field]) return run[field]
  }
  return ''
}

export function latestCompletedRunSignature(runs = []) {
  const latest = [...runs].reverse().find(run => run?.type !== 'FAILED')
  if (!latest) return 'no-completed-run'
  const summary = runSignalSummary(latest)
  return latest.signature || `${latest.num ?? ''}|${latest.date ?? ''}|${latest.type ?? ''}|${summary}|${runs.length}`
}

export function runHistoryKey(slotId, run = {}, index = 0) {
  return `${slotId}-${run.signature || `${run.num}-${run.date}-${run.type}-${run.attempt || index}`}`
}

export function newestFailedRunKey(displayRuns = [], slotId = 'slot') {
  const index = displayRuns.findIndex(run => run?.type === 'FAILED')
  return index >= 0 ? runHistoryKey(slotId, displayRuns[index], index) : null
}
