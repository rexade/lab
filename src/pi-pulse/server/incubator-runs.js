// Incubator run orchestration: preflight, launch, live-run tracking, and the
// autonomous scheduler. The scheduler never switches autopilot off: failing
// slots back off and retry on their own.
import { preflightRunConfig, resolveClaudeModel } from '../server-core.js'
import { LAB_ROOT, MAX_BACKOFF_HOURS } from './config.js'
import { notifyIncubatorClients } from './events.js'
import { readIncubators, readStatusAt, repairClaudeRunnerStatusIfNeeded, writeIncubators } from './incubator-store.js'
import { acquireRunLock, currentRunLock, globalRunBusy, spawnTrackedRun } from './run-lock.js'
import { appendIncubatorPreflightFailure, markIncubatorProcessFailure, nextIncubatorRunNum } from './run-receipts.js'
import { hoursFromNow, shellQuote } from './util.js'

const activeIncubatorRuns = new Map()

export function getIncubatorRun(id) {
  const run = activeIncubatorRuns.get(id)
  if (!run) {
    const lock = currentRunLock()
    if (lock?.kind === 'incubator' && lock.id === id) {
      return { running: true, pid: lock.pid, elapsed: 0, startTime: Date.parse(lock.startedAt) || null, runner: lock.runner, lockRecovered: true }
    }
    return { running: false, pid: null, elapsed: 0, startTime: null }
  }
  try {
    process.kill(run.pid, 0)
    return {
      running: true,
      pid: run.pid,
      elapsed: Math.floor((Date.now() - run.startTime) / 1000),
      startTime: run.startTime,
      runner: run.runner,
    }
  } catch {
    activeIncubatorRuns.delete(id)
    return { running: false, pid: null, elapsed: 0, startTime: null }
  }
}

export function stopIncubatorRun(id) {
  // After a Pi Pulse restart the in-memory map is empty; the lock still names the run.
  const lock = currentRunLock()
  const pid = activeIncubatorRuns.get(id)?.pid ?? (lock?.kind === 'incubator' && lock.id === id ? lock.pid : null)
  let stoppedPid = null
  if (pid && Number(pid) > 1) {
    stoppedPid = pid
    try { process.kill(-pid, 'SIGTERM') } catch {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
  }
  activeIncubatorRuns.delete(id)
  return stoppedPid
}

function incubatorRunArgs(cfg, statusPath, runType = null) {
  const args = []
  if (
    cfg.runScript === cfg.launcher ||
    cfg.runner === 'codex' ||
    cfg.runScript?.includes('run-codex-incubator.sh') ||
    cfg.runScript?.includes('run-incubator.sh')
  ) {
    args.push(statusPath)
    if (runType) args.push(runType)
  } else if (cfg.runner === 'claude' && cfg.runScript?.includes('run-claude-incubator.sh')) {
    args.push(statusPath)
    if (runType) args.push(runType)
  }
  return args
}

function incubatorLaunchCommand(cfg, statusPath, runType = null) {
  return ['bash', cfg.runScript, ...incubatorRunArgs(cfg, statusPath, runType)]
    .filter(Boolean)
    .map(shellQuote)
    .join(' ')
}

export function preflightIncubatorRun(slot, runType = null) {
  const { status: cfg } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)
  const selected = cfg.runner ?? 'script'
  const claudeModel = selected === 'claude' ? resolveClaudeModel(cfg.claudeModel) : cfg.claudeModel
  const preflight = preflightRunConfig({
    id: slot.id,
    project: cfg.project,
    runner: selected,
    runScript: cfg.runScript,
    relayScript: selected === 'claude' ? cfg.claudeRunScript : null,
    launcher: cfg.launcher ?? null,
    repo: cfg.repo,
    runLog: cfg.runLog,
    statusPath: slot.statusPath,
    promptDir: cfg.promptDir,
    runTypes: cfg.runTypes,
    runType,
    claudeModel,
    allowClaudeDefaultModel: selected === 'claude',
  })
  return {
    ...preflight,
    statusPath: slot.statusPath,
    command: incubatorLaunchCommand(cfg, slot.statusPath, runType),
  }
}

export function startIncubatorRun(slot, runType = null, options = {}) {
  const existing = globalRunBusy()
  if (existing) return { ok: false, error: 'global run already active', code: 'GLOBAL_RUN_LOCK_ACTIVE', pid: existing.pid, owner: existing }
  const alive = getIncubatorRun(slot.id)
  if (alive.running) return { ok: false, error: 'incubator run already active', code: 'GLOBAL_RUN_LOCK_ACTIVE', pid: alive.pid, owner: { kind: 'incubator', id: slot.id, pid: alive.pid, runner: alive.runner } }
  const preflight = preflightIncubatorRun(slot, runType)
  if (!preflight.ok) return { ok: false, error: 'runner preflight failed', preflight }
  const cfg = readStatusAt(slot.statusPath)
  const args = incubatorRunArgs(cfg, slot.statusPath, runType)
  const lock = acquireRunLock({ kind: 'incubator', id: slot.id, runner: cfg.runner ?? 'script' })
  if (!lock.ok) return { ok: false, error: 'global run already active', code: 'GLOBAL_RUN_LOCK_ACTIVE', pid: lock.pid, owner: lock }
  const child = spawnTrackedRun({
    script: cfg.runScript,
    args,
    cwd: cfg.repo || LAB_ROOT,
    captureName: `incubator-${slot.id}`,
    runLogPath: cfg.runLog,
    nextRunNum: () => nextIncubatorRunNum(slot),
    env: options.scheduled ? { PI_PULSE_SCHEDULED_RUN: '1', CODEX_BYPASS: '', CLAUDE_BYPASS: '' } : {},
    lock,
    onExit: (code, signal, exitMeta = {}) => {
      if (code || signal) {
        markIncubatorProcessFailure({
          statusPath: slot.statusPath,
          capturePath: exitMeta.capturePath,
          code,
          signal,
          num: exitMeta.failedRunNum,
          error: exitMeta.error,
        })
      }
      activeIncubatorRuns.delete(slot.id)
      notifyIncubatorClients()
    },
  })
  const run = { pid: child.pid, startTime: Date.now(), runner: cfg.runner ?? 'script' }
  activeIncubatorRuns.set(slot.id, run)
  return { ok: true, pid: child.pid, runner: run.runner, startTime: run.startTime }
}

// ─── Autonomy: back off, never switch off ─────────────────────────────────────
// A failing slot keeps its autopilot. Each new failed run doubles the wait
// before the next attempt (capped), and the first good run resets it. A
// person is never required to resume anything.

export function isFailingRunStatus(status = {}) {
  const runStatus = String(status.lastRunStatus || '').toLowerCase()
  return runStatus === 'failed' || runStatus === 'quality-failed' || String(status.lastQualityGate || '').toUpperCase() === 'FAIL'
}

// Pure: what the scheduler should do with a due slot given its last result.
//   { action: 'run' }                     healthy, or a backoff that has elapsed
//   { action: 'wait', until, streak, ...} a new failure: wait before retrying
// A failure is counted once per run (keyed by runCount), so re-reading the
// same result on later ticks never grows the streak.
export function backoffPlan({ slot = {}, status = {}, now = Date.now() }) {
  if (!isFailingRunStatus(status)) {
    return { action: 'run', reset: Boolean(slot.failStreak || slot.backoffForRun != null || slot.backoffReason) }
  }
  const runCount = Number(status.runCount || 0)
  if (slot.backoffForRun === runCount) return { action: 'run', retry: true }
  const streak = Number(slot.failStreak || 0) + 1
  const intervalHours = Number(slot.intervalHours) || 0.5
  const waitHours = Math.min(MAX_BACKOFF_HOURS, intervalHours * (2 ** Math.min(streak, 8) - 1))
  const until = now + Math.round(waitHours * 3600 * 1000)
  return {
    action: 'wait',
    streak,
    runCount,
    until,
    reason: `${streak} failed run${streak === 1 ? '' : 's'} in a row; retrying on its own`,
  }
}

function applyBackoffPlan(slot, plan) {
  if (plan.action === 'wait') {
    slot.failStreak = plan.streak
    slot.backoffForRun = plan.runCount
    slot.backoffUntil = plan.until
    slot.backoffReason = plan.reason
    slot.nextRunAt = plan.until
    return true
  }
  if (plan.reset) {
    slot.failStreak = 0
    slot.backoffForRun = null
    slot.backoffUntil = null
    slot.backoffReason = null
    return true
  }
  return false
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

// One pass over every enabled slot whose nextRunAt is due. Called every 60s.
export function incubatorSchedulerTick() {
  const data = readIncubators()
  let changed = false
  for (const slot of data.slots) {
    if (!slot.enabled || !slot.nextRunAt || Date.now() < slot.nextRunAt) continue
    if (getIncubatorRun(slot.id).running) continue
    // Another run holds the lock: stay due and start on the first free tick. Judging
    // the slot now would count its last failure again on every blocked minute.
    if (globalRunBusy()) continue
    let status = {}
    try { status = readStatusAt(slot.statusPath) } catch {}
    const plan = backoffPlan({ slot, status })
    if (applyBackoffPlan(slot, plan)) changed = true
    if (plan.action === 'wait') {
      console.warn(`[pi-pulse] incubator: ${slot.id} ${plan.reason}`)
      continue
    }
    const result = startIncubatorRun(slot, null, { scheduled: true })
    if (!result) continue
    if (result.ok === false) {
      if (result.code === 'GLOBAL_RUN_LOCK_ACTIVE') {
        slot.nextRunAt = hoursFromNow(slot.intervalHours || 0.5)
        changed = true
        continue
      }
      let runLogPath = null
      try { runLogPath = readStatusAt(slot.statusPath).runLog } catch {}
      appendIncubatorPreflightFailure({
        slot,
        runLogPath,
        preflight: result.preflight,
        source: 'scheduled-preflight',
        label: 'scheduled preflight',
      })
      console.warn(`[pi-pulse] incubator: ${slot.id} preflight blocked run: ${result.preflight?.error || result.error}`)
      slot.lastScheduleBlockedAt = new Date().toISOString()
      slot.nextRunAt = hoursFromNow(slot.intervalHours || 0.5)
      changed = true
      continue
    }
    console.log(`[pi-pulse] incubator: firing ${slot.id}`)
    slot.lastScheduledRun = new Date().toISOString()
    slot.nextRunAt = hoursFromNow(slot.intervalHours || 0.5)
    slot.autoRunsSinceHuman = (slot.autoRunsSinceHuman || 0) + 1
    if (typeof slot.charges === 'number') {
      slot.charges = Math.max(0, slot.charges - 1)
      if (slot.charges === 0) slot.enabled = false
    }
    changed = true
  }
  if (changed) {
    writeIncubators(data)
    notifyIncubatorClients()
  }
}
