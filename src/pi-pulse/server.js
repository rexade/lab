// Pi Pulse HTTP server: route table and process wiring only.
// Domain logic lives in ./server/* (see docs/ARCHITECTURE.md for the map).
import express from 'express'
import fs from 'fs'
import { spawn } from 'child_process'
import { basename, dirname, join, resolve } from 'path'
import { firstRunnableClaudeModel, preflightFailureDetail, runsWithPinnedLatestFailure } from './server-core.js'
import {
  CORE_FEEDBACK_JSON,
  CORE_FEEDBACK_MD,
  DEFAULT_RUN_TYPES,
  DIST_DIR,
  GHOST_DIARY_PATH,
  HOST,
  NARRATIONS_PATH,
  PORT,
  PROJECT_STATUS_PATH,
  PROJECTS_DIR,
  RUN_LOG_PATH,
  SCHEDULES_ENABLED,
  USER_FEEDBACK_PATH,
} from './server/config.js'
import {
  activeCoreRun,
  coreRunStatus,
  LAB_RUNNERS,
  labSchedulerTick,
  labScheduleState,
  normalizeLabRunner,
  preflightLabRun,
  readCoreStatus,
  saveLabSchedule,
  startLabRun,
  syncProjectStatus,
} from './server/core-lab.js'
import { notifyIncubatorClients, notifyRunLogClients, subscribeIncubatorUpdates, subscribeRunLogUpdates } from './server/events.js'
import {
  getIncubatorRun,
  incubatorSchedulerTick,
  preflightIncubatorRun,
  startIncubatorRun,
  stopIncubatorRun,
} from './server/incubator-runs.js'
import {
  claudeRunnerSetupForStatus,
  clearSlotBlockState,
  createIncubatorProjectFromIdea,
  normalizeIncubatorStatus,
  projectFeedbackPath,
  readIncubators,
  reconcileStaleSchedulesAtBoot,
  readLatestProjectFeedback,
  readStatusAt,
  repairClaudeRunnerStatusIfNeeded,
  updateProjectRunner,
  writeIncubators,
} from './server/incubator-store.js'
import { inferIncubatorRole } from './server/incubator-templates.js'
import { aiTargetForIncubator, analyzeAiTarget, localLlmStatus, readCachedAiFeedback } from './server/local-ai.js'
import { globalRunBusy } from './server/run-lock.js'
import { appendSteeringNote, parsedRunsForLog, readLogContent } from './server/run-logs.js'
import { appendManualPreflightFailure, nextCoreRunNum } from './server/run-receipts.js'
import { createGeneratedAppWriteGuard, generatedAppSecurityHeaders, requireTrustedWrite } from './server/security.js'
import { requireFreshSource, serviceHealth } from './server/service-health.js'
import { buildStatsPayload, dayBufferEntries, startDayBuffer, startStatsSampler } from './server/system-stats.js'
import { broadcastSse, clampScheduleInterval, hoursFromNow, openSseStream, routeSlugForProject, writeJsonAtomic } from './server/util.js'

const app = express()

// ─── Generated incubator apps (play routes) ───────────────────────────────────
// A project with an index.html is served at /<project-slug>/ under a restrictive
// CSP. Routes mounted after boot land behind the SPA fallback, which resolves
// them through resolvePlayRequest().

const mountedPlayRoutes = new Set()

function mountPlayRoute(cfg) {
  const route = `/${routeSlugForProject(cfg.project)}`
  if (mountedPlayRoutes.has(route)) return route
  if (!fs.existsSync(join(cfg.repo, 'index.html'))) return null
  app.use(route, generatedAppSecurityHeaders, express.static(cfg.repo))
  mountedPlayRoutes.add(route)
  return route
}

function isGeneratedAppPath(refPath) {
  for (const route of mountedPlayRoutes) {
    if (refPath === route || refPath.startsWith(`${route}/`)) return true
  }
  for (const slot of readIncubators().slots || []) {
    try {
      const cfg = readStatusAt(slot.statusPath)
      const route = `/${routeSlugForProject(cfg.project)}`
      if ((refPath === route || refPath.startsWith(`${route}/`)) && fs.existsSync(join(cfg.repo, 'index.html'))) return true
    } catch {
      // Keep checking other incubators; auth still applies after this guard.
    }
  }
  return false
}

// Resolves a request against the incubator play routes.
//   null                      -> not a play route; serve the Pi Pulse SPA
//   { redirect }              -> bare /<slug>; relative app URLs need the slash
//   { file }                  -> serve this file from the project repo
//   { file: null }            -> a play route with no such public file: 404
// Hidden paths (.git, .env, ...) are never public: a repo's git config can
// carry credentials in its remote URL.
function resolvePlayRequest(requestPath) {
  const match = String(requestPath || '').match(/^\/([a-z0-9_-]+)(\/(.*))?$/i)
  if (!match) return null
  const slug = match[1].toLowerCase()
  const requestFile = match[3] ? match[3] : 'index.html'

  for (const slot of readIncubators().slots) {
    let cfg
    try {
      cfg = readStatusAt(slot.statusPath)
    } catch {
      continue // malformed slot state must not break the SPA fallback
    }
    if (routeSlugForProject(cfg.project) !== slug || !fs.existsSync(join(cfg.repo, 'index.html'))) continue
    if (!match[2]) return { redirect: `/${slug}/` }
    if (requestFile.split('/').some(segment => segment.startsWith('.'))) return { file: null }

    const repoRoot = resolve(cfg.repo)
    const candidate = resolve(repoRoot, requestFile)
    if (candidate !== repoRoot && !candidate.startsWith(repoRoot + '/')) return { file: null }
    try {
      const stat = fs.statSync(candidate)
      if (stat.isDirectory()) {
        const indexPath = join(candidate, 'index.html')
        return { file: fs.existsSync(indexPath) ? indexPath : null }
      }
      return { file: stat.isFile() ? candidate : null }
    } catch {
      return { file: null }
    }
  }
  return null
}

const rejectGeneratedAppControlWrite = createGeneratedAppWriteGuard(isGeneratedAppPath)

// ─── Incubator view model ─────────────────────────────────────────────────────

function hydrateIncubator(slot) {
  const { status: cfg, repaired } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)
  const repoStatusPath = join(cfg.repo, 'status.json')
  let repoStatus = {}
  try { repoStatus = JSON.parse(fs.readFileSync(repoStatusPath, 'utf8')) } catch {}
  const running = getIncubatorRun(slot.id)
  const playRoute = fs.existsSync(join(cfg.repo, 'index.html')) ? mountPlayRoute(cfg) : null
  const claudeSetup = claudeRunnerSetupForStatus(cfg)
  const claudeRelayScript = claudeSetup.script || claudeSetup.expectedScript || cfg.claudeRunScript || null
  const runTypes = Array.isArray(cfg.runTypes) && cfg.runTypes.length ? cfg.runTypes : DEFAULT_RUN_TYPES
  return {
    ...slot,
    project: cfg.project,
    name: cfg.displayName ?? cfg.incubatorTitle ?? repoStatus.displayName ?? repoStatus.incubatorTitle ?? cfg.project,
    displayName: cfg.displayName ?? cfg.incubatorTitle ?? repoStatus.displayName ?? repoStatus.incubatorTitle ?? cfg.project,
    incubatorRole: cfg.incubatorRole ?? cfg.role ?? repoStatus.incubatorRole ?? repoStatus.role ?? inferIncubatorRole({ ...repoStatus, ...cfg, id: slot.id }),
    phase: cfg.phase ?? repoStatus.phase ?? null,
    runner: cfg.runner ?? 'script',
    repo: cfg.repo,
    runLog: cfg.runLog,
    launchScript: cfg.runScript ?? null,
    launcher: cfg.launcher ?? null,
    claudeRelayScript,
    relayScript: cfg.runner === 'claude' ? claudeRelayScript : null,
    playUrl: playRoute ? `${playRoute}/` : null,
    runCount: cfg.runCount ?? repoStatus.runCount ?? 0,
    runTypes,
    // The runner picks runTypes[runCount % length] unless the scheduler shifts strategy.
    nextRunType: String(runTypes[Number(cfg.runCount || 0) % runTypes.length] || 'mutate').toUpperCase(),
    lastRun: cfg.lastRun ?? repoStatus.lastRun ?? null,
    lastRunType: cfg.lastRunType ?? repoStatus.lastRunType ?? null,
    lastRunStatus: cfg.lastRunStatus ?? repoStatus.lastRunStatus ?? null,
    lastRunnerStatus: cfg.lastRunnerStatus ?? repoStatus.lastRunnerStatus ?? null,
    lastQualityGate: cfg.lastQualityGate ?? repoStatus.lastQualityGate ?? null,
    lastQualityRating: cfg.lastQualityRating ?? repoStatus.lastQualityRating ?? null,
    lastEvidenceConfidence: cfg.lastEvidenceConfidence ?? repoStatus.lastEvidenceConfidence ?? null,
    lastQualitySummary: cfg.lastQualitySummary ?? repoStatus.lastQualitySummary ?? null,
    lastNorthStar: cfg.lastNorthStar ?? repoStatus.lastNorthStar ?? null,
    lastRunStrategy: cfg.lastRunStrategy ?? repoStatus.lastRunStrategy ?? null,
    lastWhyRunType: cfg.lastWhyRunType ?? repoStatus.lastWhyRunType ?? null,
    lastExpectedQualityDelta: cfg.lastExpectedQualityDelta ?? repoStatus.lastExpectedQualityDelta ?? null,
    lastActualQualityDelta: cfg.lastActualQualityDelta ?? repoStatus.lastActualQualityDelta ?? null,
    lastPlateauRegressionVerdict: cfg.lastPlateauRegressionVerdict ?? repoStatus.lastPlateauRegressionVerdict ?? null,
    lastRecoveryRequired: cfg.lastRecoveryRequired ?? repoStatus.lastRecoveryRequired ?? null,
    lastRecoveryMode: cfg.lastRecoveryMode ?? repoStatus.lastRecoveryMode ?? null,
    lastAppEvidencePath: cfg.lastAppEvidencePath ?? repoStatus.lastAppEvidencePath ?? null,
    lastAppEvidenceGate: cfg.lastAppEvidenceGate ?? repoStatus.lastAppEvidenceGate ?? null,
    lastAppEvidenceTopTier: cfg.lastAppEvidenceTopTier ?? repoStatus.lastAppEvidenceTopTier ?? null,
    lastAppEvidenceMode: cfg.lastAppEvidenceMode ?? repoStatus.lastAppEvidenceMode ?? null,
    lastAppEvidencePrimaryAction: cfg.lastAppEvidencePrimaryAction ?? repoStatus.lastAppEvidencePrimaryAction ?? null,
    lastAppEvidenceSemanticSuccess: cfg.lastAppEvidenceSemanticSuccess ?? repoStatus.lastAppEvidenceSemanticSuccess ?? null,
    lastAppEvidenceSummary: cfg.lastAppEvidenceSummary ?? repoStatus.lastAppEvidenceSummary ?? null,
    lastRunFailure: cfg.lastRunFailure ?? repoStatus.lastRunFailure ?? null,
    lastRunFailureSource: cfg.lastRunFailureSource ?? repoStatus.lastRunFailureSource ?? null,
    lastRunExit: cfg.lastRunExit ?? repoStatus.lastRunExit ?? null,
    availableRunners: ['codex', 'claude'],
    runnerSetups: { claude: claudeSetup },
    repairedRunnerConfig: repaired ? 'claude' : null,
    claudeModel: firstRunnableClaudeModel(cfg.claudeModel) ?? null,
    codexModel: cfg.codexModel ?? null,
    current_focus: cfg.current_focus ?? repoStatus.current_focus ?? null,
    next_run_goal: cfg.next_run_goal ?? repoStatus.next_run_goal ?? null,
    notes: cfg.notes ?? repoStatus.notes ?? null,
    feedbackPath: projectFeedbackPath(cfg),
    latestUserFeedback: cfg.latestUserFeedback ?? readLatestProjectFeedback(projectFeedbackPath(cfg)),
    feedbackUpdatedAt: cfg.feedbackUpdatedAt ?? null,
    lastAutonomyInterventionAt: slot.lastAutonomyInterventionAt ?? null,
    lastAutonomyInterventionReason: slot.lastAutonomyInterventionReason ?? null,
    lastAutonomyInterventionCode: slot.lastAutonomyInterventionCode ?? null,
    running,
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

startStatsSampler()
syncProjectStatus()
startDayBuffer()
reconcileStaleSchedulesAtBoot()

app.use(express.json({ limit: '1mb' }))
app.use('/api', rejectGeneratedAppControlWrite, requireTrustedWrite)

// Serve built frontend in production
app.use(express.static(DIST_DIR))

for (const slot of readIncubators().slots) {
  try {
    mountPlayRoute(readStatusAt(slot.statusPath))
  } catch { /* skip malformed incubator slots */ }
}

// ─── Health + host telemetry ──────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json(serviceHealth())
})

const statsClients = new Set()
let statsPushInterval = null

function startStatsPush() {
  if (statsPushInterval) return
  statsPushInterval = setInterval(() => {
    if (statsClients.size === 0) {
      clearInterval(statsPushInterval)
      statsPushInterval = null
      return
    }
    broadcastSse(statsClients, JSON.stringify(buildStatsPayload()))
  }, 2000)
}

app.get('/api/stats/stream', (req, res) => {
  openSseStream(req, res, statsClients)
  startStatsPush()
  // Push immediately so the client gets data right away
  try { res.write(`data: ${JSON.stringify(buildStatsPayload())}\n\n`) } catch {}
})

app.get('/api/stats', (req, res) => {
  res.json(buildStatsPayload())
})

// Day history — 24h rolling buffer of 5-min system snapshots
app.get('/api/history/day', (req, res) => {
  res.json({ ok: true, entries: dayBufferEntries() })
})

// ─── Core host lab loop ───────────────────────────────────────────────────────

app.get('/api/runs', (req, res) => {
  try {
    const runs = parsedRunsForLog(RUN_LOG_PATH)
    res.json(runsWithPinnedLatestFailure(runs, 10))
  } catch {
    res.json([])
  }
})

app.get('/api/runs/stream', (req, res) => {
  subscribeRunLogUpdates(req, res)
})

app.get('/api/run/preflight', (req, res) => {
  res.json(preflightLabRun(req.query.runner || labScheduleState.runner))
})

app.get('/api/logs', (req, res) => {
  try {
    const log = readLogContent(RUN_LOG_PATH, { full: req.query.full === '1' })
    res.json(log)
  } catch {
    res.json({ content: '*(no log file found)*' })
  }
})

app.post('/api/run', requireFreshSource, (req, res) => {
  const activeRun = activeCoreRun()
  if (activeRun) {
    return res.status(409).json({ ok: false, error: 'lab run already active', pid: activeRun.pid, runner: activeRun.runner })
  }
  const busy = globalRunBusy()
  if (busy) return res.status(409).json({ ok: false, code: 'GLOBAL_RUN_LOCK_ACTIVE', error: 'another run is already active', owner: busy })
  const runner = normalizeLabRunner(req.body?.runner || labScheduleState.runner)
  const preflight = preflightLabRun(runner)
  if (!preflight.ok) {
    appendManualPreflightFailure({
      runLogPath: RUN_LOG_PATH,
      preflight,
      num: nextCoreRunNum(),
    })
    return res.status(422).json({ ok: false, error: 'runner preflight failed', preflight })
  }
  const child = startLabRun(runner)
  if (!child) {
    return res.status(404).json({ ok: false, error: `${runner} lab runner not found` })
  }
  labScheduleState.runner = runner
  labScheduleState.autoRunsSinceHuman = 0
  saveLabSchedule()
  res.json({ ok: true, pid: child.pid, runner })
})

app.get('/api/run/status', (req, res) => {
  res.json(coreRunStatus())
})

app.get('/api/lab/schedule', (req, res) => {
  res.json({ ok: true, availableRunners: Object.keys(LAB_RUNNERS), ...labScheduleState })
})

app.post('/api/lab/schedule', requireFreshSource, (req, res) => {
  const { enabled, intervalHours, runner } = req.body ?? {}
  if (typeof runner === 'string') {
    const requestedRunner = normalizeLabRunner(runner)
    if (requestedRunner === 'claude') {
      const preflight = preflightLabRun(requestedRunner)
      if (!preflight.ok) return res.status(422).json({ ok: false, error: 'runner preflight failed', preflight })
    }
    labScheduleState.runner = requestedRunner
  }
  if (typeof enabled === 'boolean') labScheduleState.enabled = enabled
  if (intervalHours != null) labScheduleState.intervalHours = clampScheduleInterval(intervalHours, labScheduleState.intervalHours)
  if (labScheduleState.enabled) {
    if (!labScheduleState.nextRunAt || labScheduleState.nextRunAt < Date.now()) {
      labScheduleState.nextRunAt = hoursFromNow(labScheduleState.intervalHours)
    }
  } else {
    labScheduleState.nextRunAt = null
  }
  labScheduleState.autoRunsSinceHuman = 0
  saveLabSchedule()
  res.json({ ok: true, availableRunners: Object.keys(LAB_RUNNERS), ...labScheduleState })
})

app.post('/api/lab/feedback', requireFreshSource, (req, res) => {
  const feedback = String(req.body?.feedback || '').trim()
  if (feedback.length < 3) return res.status(400).json({ ok: false, error: 'feedback is too short' })
  try {
    let status = readCoreStatus()
    const filePath = status.feedbackPath || USER_FEEDBACK_PATH
    const stamp = appendSteeringNote({
      feedbackPath: filePath,
      runLogPath: RUN_LOG_PATH,
      feedback,
      header: '# User Feedback / Steering Notes\n\nThese notes are written from the Pi Pulse UI and injected into future host incubator runs.\n',
    })
    status = {
      ...status,
      feedbackPath: filePath,
      latestUserFeedback: feedback.slice(0, 2000),
      feedbackUpdatedAt: stamp,
      next_run_goal: `Use latest user feedback: ${feedback.slice(0, 180)}`,
    }
    writeJsonAtomic(PROJECT_STATUS_PATH, status)
    res.json({ ok: true, status })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/project/status', (req, res) => {
  try {
    const status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8'))
    res.json(status)
  } catch {
    res.json({ project: 'pi-pulse', status: 'unknown', runCount: 0 })
  }
})

// ─── Incubator slots ──────────────────────────────────────────────────────────

function newSlot(id, statusPath, { enabled = false, intervalHours = 0.5 } = {}) {
  const interval = clampScheduleInterval(intervalHours)
  return {
    id,
    type: 'project',
    statusPath,
    enabled: !!enabled,
    intervalHours: interval,
    nextRunAt: enabled ? hoursFromNow(interval) : null,
    lastScheduledRun: null,
    autoRunsSinceHuman: 0,
    charges: null,
  }
}

app.get('/api/incubators', (req, res) => {
  const data = readIncubators()
  const slots = data.slots.map(slot => {
    try { return hydrateIncubator(slot) } catch { return { ...slot, error: 'invalid slot' } }
  })
  res.json({ ok: true, slots })
})

app.get('/api/incubators/stream', (req, res) => {
  subscribeIncubatorUpdates(req, res)
})

app.get('/api/incubators/:id/runs', (req, res) => {
  const slot = readIncubators().slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    const { status: cfg } = normalizeIncubatorStatus(slot.statusPath)
    const runs = parsedRunsForLog(cfg.runLog)
    res.json({ ok: true, runs: runsWithPinnedLatestFailure(runs, 10) })
  } catch (err) {
    res.status(500).json({
      ok: false,
      runs: [],
      error: err.message,
      statusPath: slot.statusPath,
    })
  }
})

app.get('/api/incubators/:id/run/status', (req, res) => {
  res.json({ ok: true, ...getIncubatorRun(req.params.id) })
})

app.get('/api/incubators/:id/preflight', (req, res) => {
  const slot = readIncubators().slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    res.json(preflightIncubatorRun(slot, req.query.runType ?? null))
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message })
  }
})

app.post('/api/incubators/:id/run', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const result = startIncubatorRun(slot, req.body?.runType ?? null)
  if (!result) return res.status(404).json({ ok: false, error: 'run script not found' })
  if (result.ok === false) {
    if (result.code === 'GLOBAL_RUN_LOCK_ACTIVE') {
      return res.status(409).json(result)
    }
    let runLogPath = null
    try { runLogPath = readStatusAt(slot.statusPath).runLog } catch {}
    appendManualPreflightFailure({
      slot,
      runLogPath,
      preflight: result.preflight,
    })
    notifyIncubatorClients()
    return res.status(422).json(result)
  }
  slot.autoRunsSinceHuman = 0
  clearSlotBlockState(slot)
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, ...result })
})

// Schedule state only. The runner lives in status.json and is changed through
// /api/incubators/:id/runner; a `runner` field in this body is ignored.
app.post('/api/incubators/:id/schedule', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const { enabled, intervalHours } = req.body ?? {}
  if (typeof enabled === 'boolean') slot.enabled = enabled
  if (intervalHours != null) slot.intervalHours = clampScheduleInterval(intervalHours, slot.intervalHours || 0.5)
  if (slot.enabled) {
    if (!slot.nextRunAt || slot.nextRunAt < Date.now()) {
      slot.nextRunAt = hoursFromNow(slot.intervalHours || 0.5)
    }
    clearSlotBlockState(slot)
  } else {
    slot.nextRunAt = null
  }
  slot.autoRunsSinceHuman = 0
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, slot: hydrateIncubator(slot) })
})

app.post('/api/incubators/:id/runner', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const { runner } = req.body ?? {}
  const result = updateProjectRunner(slot.statusPath, runner)
  if (!result.ok) return res.status(400).json(result)
  notifyIncubatorClients()
  // A runner switch is configuration, not a run: a blocked launch is reported
  // here and in the slot's live preflight, never written into run history.
  const preflight = preflightIncubatorRun(slot)
  const launchBlocked = runner === 'claude' && preflight && !preflight.ok
  const hydratedSlot = hydrateIncubator(slot)
  const warning = launchBlocked
    ? `Claude relay selected but launch preflight blocked: ${preflightFailureDetail(preflight) || preflight.error || 'runner preflight failed'}`
    : result.warning ?? null
  res.json({
    ok: true,
    slot: hydratedSlot,
    warning,
    repaired: result.repaired ?? false,
    setup: result.setup ?? hydratedSlot.runnerSetups?.[runner] ?? null,
    preflight,
  })
})

app.post('/api/incubators/create', requireFreshSource, (req, res) => {
  const result = createIncubatorProjectFromIdea(req.body?.idea, req.body?.title)
  if (!result.ok) return res.status(result.status || 400).json(result)
  const data = readIncubators()
  const slot = newSlot(result.slug, result.statusPath)
  data.slots.push(slot)
  writeIncubators(data)
  try { mountPlayRoute(result.status) } catch {}
  notifyIncubatorClients()
  res.json({ ok: true, slot: hydrateIncubator(slot) })
})

app.post('/api/incubators/:id/feedback', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const feedback = String(req.body?.feedback || '').trim()
  if (feedback.length < 3) return res.status(400).json({ ok: false, error: 'feedback is too short' })
  try {
    const cfg = readStatusAt(slot.statusPath)
    const filePath = projectFeedbackPath(cfg)
    const stamp = appendSteeringNote({
      feedbackPath: filePath,
      runLogPath: cfg.runLog,
      feedback,
      header: '# User Feedback / Steering Notes\n\nThese notes are written from the Pi Pulse UI and injected into future incubator runs.\n',
    })
    cfg.feedbackPath = filePath
    cfg.latestUserFeedback = feedback.slice(0, 2000)
    cfg.feedbackUpdatedAt = stamp
    cfg.next_run_goal = `Use latest user feedback: ${feedback.slice(0, 180)}`
    slot.autoRunsSinceHuman = 0
    clearSlotBlockState(slot)
    if (slot.enabled && (!slot.nextRunAt || slot.nextRunAt < Date.now())) {
      slot.nextRunAt = hoursFromNow(slot.intervalHours || 0.5)
    }
    writeJsonAtomic(slot.statusPath, cfg)
    writeIncubators(data)
    notifyIncubatorClients()
    res.json({ ok: true, slot: hydrateIncubator(slot) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Register an existing projects/<id>/status.json as a slot.
app.post('/api/incubators', requireFreshSource, (req, res) => {
  const { project, intervalHours = 0.5, enabled = false } = req.body ?? {}
  if (!project || typeof project !== 'string' || project.includes('..') || project === 'pi-pulse') {
    return res.status(400).json({ ok: false, error: 'invalid project' })
  }
  const statusPath = join(PROJECTS_DIR, project, 'status.json')
  if (!fs.existsSync(statusPath)) return res.status(404).json({ ok: false, error: 'project status not found' })
  const data = readIncubators()
  if (data.slots.some(s => s.id === project)) return res.status(409).json({ ok: false, error: 'incubator already exists' })
  const slot = newSlot(project, statusPath, { enabled, intervalHours })
  data.slots.push(slot)
  writeIncubators(data)
  try { mountPlayRoute(readStatusAt(statusPath)) } catch {}
  notifyIncubatorClients()
  res.json({ ok: true, slot: hydrateIncubator(slot) })
})

app.delete('/api/incubators/:id', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const next = data.slots.filter(s => s.id !== req.params.id)
  if (next.length === data.slots.length) return res.status(404).json({ ok: false, error: 'incubator not found' })
  data.slots = next
  writeIncubators(data)
  const stoppedPid = stopIncubatorRun(req.params.id)
  notifyIncubatorClients()
  res.json({ ok: true, removed: req.params.id, stoppedPid })
})

// ─── Local critic (Ollama/Qwen) ───────────────────────────────────────────────
// Per-slot endpoints; 'core' addresses the host lab loop. /api/ai/* are the
// original core-only aliases kept for existing clients.

app.get('/api/incubators/:id/ai/latest', (req, res) => {
  const target = aiTargetForIncubator(req.params.id)
  if (!target) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    res.json(readCachedAiFeedback(target))
  } catch {
    res.json({ ok: false })
  }
})

app.post('/api/incubators/:id/ai/analyze', requireFreshSource, async (req, res) => {
  const target = aiTargetForIncubator(req.params.id)
  if (!target) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const result = await analyzeAiTarget(target, req.params.id === 'core' ? 'core' : 'incubator')
  res.status(result.status).json(result.body)
})

app.get('/api/ai/status', async (req, res) => {
  res.json(await localLlmStatus())
})

app.post('/api/ai/analyze', requireFreshSource, async (req, res) => {
  const result = await analyzeAiTarget(aiTargetForIncubator('core'), 'core')
  res.status(result.status).json(result.body)
})

app.get('/api/ai/latest', (req, res) => {
  try {
    res.json(readCachedAiFeedback({
      id: 'core',
      project: 'pi-pulse',
      paths: { json: CORE_FEEDBACK_JSON, md: CORE_FEEDBACK_MD },
    }))
  } catch {
    res.json({ ok: false })
  }
})

// ─── Side channels (narrator, ghost diary) ────────────────────────────────────

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
}

// Narrator — all narrations (newest first) for the archive modal
app.get('/api/narrations', (req, res) => {
  try {
    const entries = readJsonLines(NARRATIONS_PATH).map(l => {
      const e = JSON.parse(l)
      if (e.text) e.text = e.text.split('\n')[0].trim().slice(0, 100)
      return e
    }).reverse()
    res.json({ ok: true, entries })
  } catch {
    res.json({ ok: true, entries: [] })
  }
})

// Ghost-trio diary — reads diary.jsonl directly; works even when daily.js is not running
app.get('/api/ghost/diary', (req, res) => {
  try {
    const entries = readJsonLines(GHOST_DIARY_PATH).map(l => {
      try {
        const e = JSON.parse(l)
        // Only return non-pending entries with actual text
        return (e.text && !e.pending) ? { ts: e.ts, text: e.text, classState: e.classState ?? null, convCount: e.convCount ?? 0 } : null
      } catch { return null }
    }).filter(Boolean).reverse() // newest first
    res.json({ ok: true, entries })
  } catch {
    res.json({ ok: true, entries: [] })
  }
})

// ─── Process control ──────────────────────────────────────────────────────────

// Reboot — 1.5s delay so the HTTP response can complete first
app.post('/api/reboot', (req, res) => {
  res.json({ ok: true })
  setTimeout(() => {
    spawn('sudo', ['reboot'], { detached: true, stdio: 'ignore' }).unref()
  }, 1500)
})

// Restart only Pi Pulse so stale-source write gates can be cleared without a full host reboot.
// The supervisor (systemd Restart=always) brings the process back.
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, restarting: true })
  setTimeout(() => process.exit(0), 500)
})

// ─── Background loops ─────────────────────────────────────────────────────────

if (SCHEDULES_ENABLED) {
  setInterval(labSchedulerTick, 60 * 1000)
  setInterval(incubatorSchedulerTick, 60 * 1000)
}

// Push 'update' to /api/runs/stream clients whenever the core RUN_LOG.md changes.
// Directory watch instead of file watch — survives rename-replace (new inode)
// and a log that doesn't exist yet. Filter to the log's own name so the rest of
// the lab dir's churn (MEMORY_BRIEF.md, ACTIVE_THREADS.md, ...) doesn't spam clients.
let runLogWatchTimer = null
function notifyRunLogChanged() {
  syncProjectStatus()
  notifyRunLogClients()
}
try {
  const runLogName = basename(RUN_LOG_PATH)
  fs.watch(dirname(RUN_LOG_PATH), { persistent: false }, (eventType, filename) => {
    if (filename && filename !== runLogName) return
    clearTimeout(runLogWatchTimer)
    runLogWatchTimer = setTimeout(notifyRunLogChanged, 500)
  })
} catch { /* lab dir missing would be fatal elsewhere anyway */ }

// ─── Fallbacks (order matters: API errors → API 404 → SPA) ────────────────────

app.use('/api', (err, req, res, next) => {
  console.error('[pi-pulse] api error:', err?.stack || err?.message || err)
  if (res.headersSent) return next(err)
  const status = Number.isInteger(err?.status) ? err.status : 500
  res.status(status).json({
    ok: false,
    error: err?.message || 'api route failed',
    path: req.originalUrl,
  })
})

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'api route not found', path: req.originalUrl })
})

// SPA fallback
app.get('*', (req, res) => {
  const play = resolvePlayRequest(req.path)
  if (play?.redirect) return res.redirect(301, play.redirect)
  if (play) {
    generatedAppSecurityHeaders(req, res, () => {})
    if (!play.file) return res.status(404).type('text/plain').send('not found')
    return res.sendFile(play.file)
  }

  const indexPath = join(DIST_DIR, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(404).send('Build not found. Run: npm run build')
  }
})

function startServer(port = PORT, host = HOST) {
  const server = app.listen(port, host, () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    const actualHost = typeof address === 'object' && address ? address.address : host
    console.log(`Pi Pulse API -> http://${actualHost}:${actualPort}/api/stats`)
  })
  server.on('error', (err) => {
    console.error('[pi-pulse] fatal listen error:', err.message)
    process.exit(1)
  })
  return server
}
if (process.env.PI_PULSE_NO_LISTEN !== '1') startServer()

export { app, startServer }
