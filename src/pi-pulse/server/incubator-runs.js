// Incubator run orchestration: preflight, launch, live-run tracking, and the
// autonomous scheduler's safety decisions (failure fuse, strategy shifts).
import { preflightRunConfig } from '../server-core.js'
import { LAB_ROOT, MAX_CONSECUTIVE_AUTONOMOUS_FAILS } from './config.js'
import { notifyIncubatorClients } from './events.js'
import { inferIncubatorRole } from './incubator-templates.js'
import { readIncubators, readStatusAt, repairClaudeRunnerStatusIfNeeded, resolveClaudeModel, writeIncubators } from './incubator-store.js'
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
  const running = activeIncubatorRuns.get(id)
  let stoppedPid = null
  if (running?.pid && Number(running.pid) > 1) {
    stoppedPid = running.pid
    try { process.kill(-running.pid, 'SIGTERM') } catch {
      try { process.kill(running.pid, 'SIGTERM') } catch {}
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
  const { status: cfg } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)
  const preflight = preflightIncubatorRun(slot, runType)
  if (!preflight.ok) return { ok: false, error: 'runner preflight failed', preflight }
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

// ─── Autonomy guards ──────────────────────────────────────────────────────────

export function incubatorFailureFuseDecision(slot) {
  let cfg = {}
  try { cfg = readStatusAt(slot.statusPath) } catch { return null }
  const gate = String(cfg.lastQualityGate || '').toUpperCase()
  const status = String(cfg.lastRunStatus || '').toLowerCase()
  const failing = gate === 'FAIL' || status === 'failed' || status === 'quality-failed'
  if (!failing) {
    if (slot.consecutiveFailGates) slot.consecutiveFailGates = 0
    return null
  }
  const count = Number(slot.consecutiveFailGates || 0) + 1
  slot.consecutiveFailGates = count
  if (count < MAX_CONSECUTIVE_AUTONOMOUS_FAILS) return null
  return {
    count,
    reason: `schedule paused: ${count} consecutive failed quality gates; needs deliberate steering or manual run`,
    code: 'AUTO_FAIL_FUSE',
  }
}

export function applyIncubatorFailureFuse(slot, decision) {
  const ts = new Date().toISOString()
  slot.enabled = false
  slot.nextRunAt = null
  slot.schedulePausedAt = ts
  slot.schedulePauseReason = decision.reason
  slot.lastScheduleBlockedAt = ts
  slot.lastScheduleBlockedReason = decision.reason
  slot.lastScheduleBlockedCode = decision.code
}

export function incubatorAutoStrategyDecision(slot) {
  let cfg = {}
  try { cfg = readStatusAt(slot.statusPath) } catch { return null }
  const autoRuns = Number(slot.autoRunsSinceHuman || 0)
  const qualityGate = String(cfg.lastQualityGate || '').toUpperCase()
  const qualityRating = Number(cfg.lastQualityRating)
  const evidenceConfidence = Number(cfg.lastEvidenceConfidence)
  const role = cfg.incubatorRole || cfg.role || inferIncubatorRole({ ...cfg, id: slot.id })
  const text = [
    cfg.next_run_goal,
    cfg.lastQualitySummary,
    cfg.lastRecoveryMode,
    cfg.current_focus,
  ].filter(Boolean).join(' ').toLowerCase()

  // Manual/human validation requests are not a scheduler stop condition.
  // Future runs should create stronger automated proxy evidence unless the
  // user explicitly pauses or provides new steering.
  const verdict = String(cfg.lastPlateauRegressionVerdict || '').toUpperCase()
  const plateau = verdict.startsWith('PLATEAU') || /(plateau|no measurable application improvement|score_delta:\s*0|score delta 0|algorithm-score plateau|unchanged hard metrics)/.test(text)
  if (autoRuns >= 3 && plateau && qualityGate === 'PASS') {
    return {
      runType: 'research',
      reason: 'strategy shift: plateau detected; choose a stronger north star or a different measurable tactic',
      code: 'AUTO_PLATEAU_RESEARCH',
    }
  }

  const highQuality = qualityGate === 'PASS'
    && Number.isFinite(qualityRating)
    && qualityRating >= 4.5
    && (!Number.isFinite(evidenceConfidence) || evidenceConfidence >= 4)
  const maxAutoRuns = role === 'signal-feeder' ? 12 : 8
  if (autoRuns >= maxAutoRuns && highQuality) {
    return {
      runType: 'research',
      reason: `strategy shift: ${autoRuns} autonomous high-quality runs; select the strongest north star and next measurable bet`,
      code: 'AUTO_NORTH_STAR_RESEARCH',
    }
  }

  return null
}

export function applyIncubatorAutoStrategy(slot, decision) {
  const ts = new Date().toISOString()
  slot.lastAutonomyInterventionAt = ts
  slot.lastAutonomyInterventionReason = decision.reason
  slot.lastAutonomyInterventionCode = decision.code
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

// One pass over every enabled slot whose nextRunAt is due. Called every 60s.
export function incubatorSchedulerTick() {
  const data = readIncubators()
  let changed = false
  for (const slot of data.slots) {
    if (!slot.enabled || !slot.nextRunAt || Date.now() < slot.nextRunAt) continue
    if (getIncubatorRun(slot.id).running) continue
    const failureFuse = incubatorFailureFuseDecision(slot)
    if (failureFuse) {
      applyIncubatorFailureFuse(slot, failureFuse)
      console.warn(`[pi-pulse] incubator: ${slot.id} ${failureFuse.reason}`)
      changed = true
      continue
    }
    const autoStrategy = incubatorAutoStrategyDecision(slot)
    if (autoStrategy) {
      applyIncubatorAutoStrategy(slot, autoStrategy)
      console.warn(`[pi-pulse] incubator: ${slot.id} ${autoStrategy.reason}`)
      changed = true
    }
    const result = startIncubatorRun(slot, autoStrategy?.runType || null, { scheduled: true })
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
