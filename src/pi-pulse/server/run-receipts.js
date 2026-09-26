// Durable failure receipts. A run that is blocked before launch (preflight) or
// dies before writing its own summary must still leave a FAILED row in the
// target RUN_LOG.md and advance status.json, so history never silently skips.
import fs from 'fs'
import { appendFailedPreflightEntry, capturedFailureDetail, preflightFailureDetail } from '../server-core.js'
import { PROJECT_STATUS_PATH } from './config.js'
import { readStatusAt } from './incubator-store.js'
import { parsedRunsForLog } from './run-logs.js'
import { writeJsonAtomic } from './util.js'

export function nextCoreRunNum() {
  try { return (JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')).runCount ?? 0) + 1 } catch { return 1 }
}

export function nextIncubatorRunNum(slot) {
  try {
    const status = readStatusAt(slot.statusPath)
    let latest = Number(status.runCount || 0)
    if (status.runLog) {
      try {
        const runs = parsedRunsForLog(status.runLog)
        latest = Math.max(latest, ...runs.map(run => Number(run.num || 0)))
      } catch {}
    }
    return latest + 1
  } catch { return 1 }
}

function markIncubatorPreflightAttempt({ statusPath, preflight, num, label }) {
  if (!statusPath || !num) return
  try {
    const status = readStatusAt(statusPath)
    const today = new Date().toISOString().slice(0, 10)
    status.runCount = Math.max(Number(status.runCount || 0), Number(num))
    status.lastRun = today
    status.lastRunType = 'FAILED'
    status.lastRunStatus = 'failed'
    status.lastRunFailure = preflightFailureDetail(preflight) || preflight?.error || 'runner preflight failed'
    status.lastRunFailureSource = label
    writeJsonAtomic(statusPath, status)
  } catch {}
}

export function markIncubatorProcessFailure({ statusPath, capturePath, code, signal, num, error = null }) {
  if (!statusPath || !num) return
  try {
    const status = readStatusAt(statusPath)
    const today = new Date().toISOString().slice(0, 10)
    const reason = error ? `spawn failed: ${error.code || error.message}` : signal ? `signal ${signal}` : `exit ${code}`
    status.runCount = Math.max(Number(status.runCount || 0), Number(num))
    status.lastRun = today
    status.lastRunType = 'FAILED'
    status.lastRunStatus = 'failed'
    status.lastRunFailure = capturedFailureDetail(capturePath) || `runner process failed with ${reason}`
    status.lastRunFailureSource = 'process exit'
    status.lastRunExit = reason
    writeJsonAtomic(statusPath, status)
  } catch {}
}

export function appendIncubatorPreflightFailure({ slot, runLogPath, preflight, source, label }) {
  const num = nextIncubatorRunNum(slot)
  appendFailedPreflightEntry({ runLogPath, preflight, num, source, label })
  markIncubatorPreflightAttempt({ statusPath: slot.statusPath, preflight, num, label })
  return num
}

export function appendManualPreflightFailure({ slot = null, runLogPath, preflight, num = null }) {
  if (slot) {
    return appendIncubatorPreflightFailure({
      slot,
      runLogPath,
      preflight,
      source: 'manual-preflight',
      label: 'manual preflight',
    })
  }
  appendFailedPreflightEntry({
    runLogPath,
    preflight,
    num,
    source: 'manual-preflight',
    label: 'manual preflight',
  })
  return num
}
