// Stable keys for run history rows, so an expanded row stays expanded while
// new runs stream in.
export function runHistoryKey(slotId, run = {}, index = 0) {
  return `${slotId}-${run.signature || `${run.num}-${run.date}-${run.type}-${run.attempt || index}`}`
}

export function newestFailedRunKey(displayRuns = [], slotId = 'slot') {
  const index = displayRuns.findIndex(run => run?.type === 'FAILED')
  return index >= 0 ? runHistoryKey(slotId, displayRuns[index], index) : null
}
