// Core "host" lab loop: the Pi Pulse project improving itself against the lab
// root RUN_LOG.md. Both agents share controller-owned checks and review.
import fs from 'fs'
import { join } from 'path'
import { appendFailedPreflightEntry, preflightRunConfig, qualityStateFromRun, resolveClaudeModel } from '../server-core.js'
import {
  CORE_SEED_PATH,
  DAILY_SEED_PATH,
  DEFAULT_LAB_RUNNER,
  LAB_ROOT,
  LAB_SCHEDULE_PATH,
  PROJECT_STATUS_PATH,
  RUN_LOG_PATH,
} from './config.js'
import { acquireRunLock, globalRunBusy, spawnTrackedRun } from './run-lock.js'
import { parsedRunsForLog } from './run-logs.js'
import { nextCoreRunNum } from './run-receipts.js'
import { clampScheduleInterval, hoursFromNow, pidAlive, writeJsonAtomic } from './util.js'

export const LAB_RUNNERS = {
  claude: {
    script: join(LAB_ROOT, 'run-lab.sh'),
    args: [],
  },
  codex: {
    script: join(LAB_ROOT, 'run-lab.sh'),
    args: [],
  },
}

export function normalizeLabRunner(runner) {
  return Object.hasOwn(LAB_RUNNERS, runner) ? runner : DEFAULT_LAB_RUNNER
}

// Mutated in place by routes and the scheduler; persisted by saveLabSchedule().
export const labScheduleState = { enabled: false, intervalHours: 2, runner: DEFAULT_LAB_RUNNER, nextRunAt: null, lastScheduledRun: null, autoRunsSinceHuman: 0 }

try {
  Object.assign(labScheduleState, JSON.parse(fs.readFileSync(LAB_SCHEDULE_PATH, 'utf8')))
  labScheduleState.intervalHours = clampScheduleInterval(labScheduleState.intervalHours, 2)
  labScheduleState.runner = normalizeLabRunner(labScheduleState.runner)
  if (labScheduleState.enabled && labScheduleState.nextRunAt && labScheduleState.nextRunAt < Date.now()) {
    labScheduleState.nextRunAt = hoursFromNow(labScheduleState.intervalHours)
  }
} catch { /* no host lab schedule yet */ }

export function saveLabSchedule() {
  try { fs.writeFileSync(LAB_SCHEDULE_PATH, JSON.stringify(labScheduleState, null, 2) + '\n') } catch {}
}

export function readCoreStatus() {
  try { return JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch { return {} }
}

// Active core run tracking — cleared after the process exits.
let activeRun = null // { pid, startTime, runner }

export function activeCoreRun() {
  if (!activeRun) return null
  if (pidAlive(activeRun.pid)) return activeRun
  activeRun = null
  return null
}

export function coreRunStatus() {
  if (!activeRun) return { running: false, pid: null, elapsed: 0, startTime: null }
  const elapsed = Math.floor((Date.now() - activeRun.startTime) / 1000)
  const startTime = activeRun.startTime
  if (!pidAlive(activeRun.pid)) {
    activeRun = null
    return { running: false, pid: null, elapsed, startTime }
  }
  return { running: true, pid: activeRun.pid, elapsed, startTime, runner: activeRun.runner ?? null }
}

export function preflightLabRun(runner = labScheduleState.runner) {
  const selected = normalizeLabRunner(runner)
  const cfg = LAB_RUNNERS[selected]
  const status = readCoreStatus()
  const claudeModel = selected === 'claude' ? resolveClaudeModel(status.claudeModel) : status.claudeModel
  return preflightRunConfig({
    id: 'core',
    project: status.project || 'pi-pulse',
    runner: selected,
    runScript: cfg.script,
    repo: LAB_ROOT,
    runLog: RUN_LOG_PATH,
    statusPath: PROJECT_STATUS_PATH,
    promptDir: status.promptDir,
    runTypes: status.runTypes,
    claudeModel,
    allowClaudeDefaultModel: selected === 'claude',
  })
}

export function startLabRun(runner = labScheduleState.runner, options = {}) {
  const selected = normalizeLabRunner(runner)
  const preflight = preflightLabRun(selected)
  if (!preflight.ok) return null
  const existing = globalRunBusy()
  if (existing) return null
  const lock = acquireRunLock({ kind: 'core', id: 'pi-pulse', runner: selected })
  if (!lock.ok) return null
  const cfg = LAB_RUNNERS[selected]
  const runEnv = { PI_PULSE_AGENT: selected, PI_PULSE_CORE_RUN: '1', PI_PULSE_CORE_STATUS_PATH: PROJECT_STATUS_PATH,
    ...(options.scheduled ? { PI_PULSE_SCHEDULED_RUN: '1' } : {}) }
  if (selected === 'claude') {
    const status = readCoreStatus()
    const model = resolveClaudeModel(status.claudeModel)
    if (model) runEnv.CLAUDE_MODEL = model
  }
  const child = spawnTrackedRun({
    script: cfg.script,
    args: cfg.args,
    cwd: LAB_ROOT,
    captureName: `core-${selected}`,
    runLogPath: RUN_LOG_PATH,
    nextRunNum: nextCoreRunNum,
    env: runEnv,
    lock,
  })
  activeRun = { pid: child.pid, startTime: Date.now(), runner: selected }
  return child
}

// Mirror the latest RUN_LOG.md entry into the core status.json so the UI and
// the scheduler read one cached summary instead of re-parsing the log.
export function syncProjectStatus() {
  try {
    const runs = parsedRunsForLog(RUN_LOG_PATH)
    const latest = runs[runs.length - 1] ?? null

    const current = readCoreStatus()

    const controlled = current.session?.run === latest?.num || current.lastSession?.run === latest?.num
    const qualityState = latest && !controlled ? qualityStateFromRun(latest, latest.type !== 'FAILED') : {}
    const updated = {
      ...current,
      runCount: latest?.num ?? current.runCount ?? 0,
      lastRun: latest?.date ?? current.lastRun,
      lastRunType: latest?.type ?? current.lastRunType,
      ...qualityState,
      syncedAt: new Date().toISOString(),
    }

    writeJsonAtomic(PROJECT_STATUS_PATH, updated)

    // Keep project-level seed.md in sync with the daily seed
    try {
      const seedContent = fs.readFileSync(DAILY_SEED_PATH, 'utf8')
      fs.writeFileSync(CORE_SEED_PATH, seedContent)
    } catch { /* non-fatal */ }
  } catch (err) {
    console.warn('[pi-pulse] status sync error:', err.message)
  }
}

// Fire the host lab loop if its schedule is due. Called every 60s.
export function labSchedulerTick() {
  if (!labScheduleState.enabled || !labScheduleState.nextRunAt) return
  if (Date.now() < labScheduleState.nextRunAt) return
  if (activeCoreRun() || globalRunBusy()) return
  const runner = normalizeLabRunner(labScheduleState.runner)
  const child = startLabRun(runner, { scheduled: true })
  if (!child) {
    const preflight = preflightLabRun(runner)
    appendFailedPreflightEntry({
      runLogPath: RUN_LOG_PATH,
      preflight,
      num: nextCoreRunNum(),
    })
    console.warn(`[pi-pulse] schedule: host preflight blocked run: ${preflight.error || 'runner preflight failed'}`)
    labScheduleState.runner = runner
    labScheduleState.lastScheduleBlockedAt = new Date().toISOString()
    labScheduleState.nextRunAt = hoursFromNow(labScheduleState.intervalHours)
    saveLabSchedule()
    return
  }
  console.log(`[pi-pulse] schedule: firing host lab run via ${runner}`)
  labScheduleState.runner = runner
  labScheduleState.lastScheduledRun = new Date().toISOString()
  labScheduleState.nextRunAt = hoursFromNow(labScheduleState.intervalHours)
  labScheduleState.autoRunsSinceHuman = (labScheduleState.autoRunsSinceHuman || 0) + 1
  saveLabSchedule()
}
