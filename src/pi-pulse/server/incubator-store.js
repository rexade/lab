// Incubator slot registry (projects/incubators.json) and per-project status
// files (projects/<id>/status.json).
//
// Authority split:
//   incubators.json  -> schedule state only (enabled, interval, nextRunAt, fuses)
//   status.json      -> everything about the project, including `runner`
// The slot record used to carry its own `runner` copy that drifted from
// status.json; it is no longer written and is stripped on read.
import fs from 'fs'
import { basename, dirname, join, resolve } from 'path'
import {
  checkClaudeCommand,
  checkClaudeModel,
  checkPath,
  firstRunnableClaudeModel,
  resolveClaudeModel,
  resolveClaudePermissionMode,
} from '../server-core.js'
import {
  CODEX_INCUBATOR_SCRIPT,
  CORE_FEEDBACK_JSON,
  CORE_FEEDBACK_MD,
  DEFAULT_RUN_TYPES,
  GENERIC_CLAUDE_INCUBATOR_SCRIPT,
  INCUBATOR_REPO_ROOT,
  INCUBATOR_RUNNER_SCRIPT,
  INCUBATORS_PATH,
  LAB_ROOT,
  PI_PULSE_ROOT,
  PROJECTS_DIR,
} from './config.js'
import {
  inferIncubatorRole,
  incubatorLauncherScript,
  normalizedIncubatorTitle,
  promptForIncubatorRunType,
  safeRunTypeName,
  slugifyProjectName,
  suggestedIncubatorTitle,
} from './incubator-templates.js'
import { clampScheduleInterval, pathInside, pathInsideAny, safePathSegment, writeJsonAtomic } from './util.js'

// ─── Slot registry ────────────────────────────────────────────────────────────

const UNREADABLE = Symbol('incubators-unreadable')
let lastRegistryWarning = ''

function warnRegistryOnce(message) {
  if (message === lastRegistryWarning) return
  lastRegistryWarning = message
  console.warn(`[pi-pulse] incubators: ${message}`)
}

// A missing registry is simply "no slots yet". An unreadable one is served as
// empty but marked read-only, so a later write cannot silently replace the
// operator's real slot list (it used to be overwritten with a seeded default).
export function readIncubators() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(INCUBATORS_PATH, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return { slots: [] }
    warnRegistryOnce(`could not parse ${INCUBATORS_PATH} (${err.message}); serving no slots until it is fixed`)
    return { slots: [], [UNREADABLE]: true }
  }
  if (!Array.isArray(data?.slots)) {
    warnRegistryOnce(`${INCUBATORS_PATH} has no "slots" array; serving no slots until it is fixed`)
    return { slots: [], [UNREADABLE]: true }
  }
  lastRegistryWarning = ''
  return reconcileIncubatorScheduleState(data)
}

export function writeIncubators(data) {
  if (data?.[UNREADABLE]) {
    const err = new Error(`refusing to overwrite unreadable ${INCUBATORS_PATH}; fix or remove it first`)
    err.status = 409
    throw err
  }
  try { writeJsonAtomic(INCUBATORS_PATH, data) } catch (err) {
    console.warn(`[pi-pulse] incubators: write failed: ${err.message}`)
  }
}

export function findIncubatorSlot(id) {
  return readIncubators().slots.find(slot => slot.id === id) || null
}

export function pauseIncubatorSchedule(slot, reason, code) {
  const ts = new Date().toISOString()
  slot.enabled = false
  slot.nextRunAt = null
  slot.schedulePausedAt = ts
  slot.schedulePauseReason = reason
  slot.lastScheduleBlockedAt = ts
  slot.lastScheduleBlockedReason = reason
  slot.lastScheduleBlockedCode = code
}

export function clearSlotBlockState(slot) {
  slot.lastScheduleBlockedAt = null
  slot.lastScheduleBlockedReason = null
  slot.lastScheduleBlockedCode = null
  slot.schedulePausedAt = null
  slot.schedulePauseReason = null
  slot.lastAutonomyInterventionAt = null
  slot.lastAutonomyInterventionReason = null
  slot.lastAutonomyInterventionCode = null
}

function reconcileIncubatorScheduleState(data) {
  let changed = false
  const now = Date.now()
  for (const slot of data.slots || []) {
    if (Object.hasOwn(slot, 'runner')) {
      // status.json owns the runner; a slot-level copy only ever drifted.
      delete slot.runner
      changed = true
    }
    const interval = clampScheduleInterval(slot.intervalHours, 0.5)
    if (slot.intervalHours !== interval) { slot.intervalHours = interval; changed = true }
    if (!pathInside(slot.statusPath, PROJECTS_DIR)) {
      if (slot.enabled) {
        pauseIncubatorSchedule(slot, 'schedule paused: status path is outside trusted project root', 'UNTRUSTED_STATUS_PATH')
        changed = true
      }
      continue
    }
    try {
      const status = JSON.parse(fs.readFileSync(slot.statusPath, 'utf8'))
      if (status.codexBypass === true || status.claudeBypass === true) {
        status.codexBypass = false
        status.claudeBypass = false
        writeJsonAtomic(slot.statusPath, status)
        if (slot.enabled) {
          pauseIncubatorSchedule(slot, 'schedule paused: persisted bypass flags are not allowed for autonomous runs', 'PERSISTED_BYPASS_DISABLED')
        }
        changed = true
      }
    } catch {
      if (slot.enabled) {
        pauseIncubatorSchedule(slot, 'schedule paused: status file could not be read', 'STATUS_READ_FAILED')
        changed = true
      }
    }
    if (slot.enabled && !slot.nextRunAt) {
      slot.nextRunAt = now + slot.intervalHours * 60 * 60 * 1000
      changed = true
    }
  }
  if (changed) writeIncubators(data)
  return data
}

// Boot-only: after downtime, overdue slots start one interval from now instead
// of firing in a burst. This must never run on ordinary reads; the scheduler
// tick reads the registry itself, so doing it there pushed every due slot
// forward before the tick could see it, and scheduled runs never fired.
export function reconcileStaleSchedulesAtBoot() {
  const data = readIncubators()
  const now = Date.now()
  let changed = false
  for (const slot of data.slots) {
    if (!slot.enabled || !slot.nextRunAt || Number(slot.nextRunAt) >= now) continue
    slot.nextRunAt = now + slot.intervalHours * 60 * 60 * 1000
    slot.lastScheduleBlockedAt = new Date().toISOString()
    slot.lastScheduleBlockedReason = 'overdue at service start; next run moved one interval out'
    slot.lastScheduleBlockedCode = 'STALE_SCHEDULE_RECONCILED'
    changed = true
  }
  if (changed) writeIncubators(data)
}

// ─── Trusted status files ─────────────────────────────────────────────────────

export function trustedIncubatorRepo(repoPath) {
  if (!pathInside(repoPath, INCUBATOR_REPO_ROOT)) return false
  if (resolve(INCUBATOR_REPO_ROOT) === resolve(LAB_ROOT)) return true
  return !pathInside(repoPath, LAB_ROOT)
}

export function assertTrustedStatusPath(statusPath) {
  const resolved = resolve(String(statusPath || ''))
  if (!pathInside(resolved, PROJECTS_DIR)) throw new Error('status path outside trusted project root')
  const st = fs.lstatSync(resolved)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('status path is not a regular trusted file')
  return resolved
}

export function readStatusAt(statusPath) {
  const safeStatusPath = assertTrustedStatusPath(statusPath)
  return JSON.parse(fs.readFileSync(safeStatusPath, 'utf8'))
}

// ─── Runner setup (Claude relay + project launcher) ───────────────────────────

function expectedClaudeRunScriptForProject(project, cfg = {}) {
  if (cfg.claudeRunScript === GENERIC_CLAUDE_INCUBATOR_SCRIPT && fs.existsSync(cfg.claudeRunScript)) return cfg.claudeRunScript
  return GENERIC_CLAUDE_INCUBATOR_SCRIPT
}

function claudeRunScriptForProject(project, cfg = {}) {
  const candidate = expectedClaudeRunScriptForProject(project, cfg)
  return fs.existsSync(candidate) ? candidate : null
}

function runnableLauncherForStatus(cfg = {}) {
  if (!cfg.launcher || !pathInside(cfg.launcher, PROJECTS_DIR)) return null
  try {
    const st = fs.lstatSync(cfg.launcher)
    if (!st.isFile() || st.isSymbolicLink()) return null
    fs.accessSync(cfg.launcher, fs.constants.X_OK)
    return cfg.launcher
  } catch {
    return null
  }
}

export function claudeRunnerSetupForStatus(cfg) {
  const expectedScript = expectedClaudeRunScriptForProject(cfg.project, cfg)
  const model = resolveClaudeModel(cfg.claudeModel)
  const checks = [
    checkPath('script', 'Claude runner script', expectedScript),
    checkClaudeCommand(),
    checkClaudeModel(model, true),
  ]
  const ok = checks.every(check => check.ok)
  return {
    runner: 'claude',
    ok,
    script: claudeRunScriptForProject(cfg.project, cfg),
    expectedScript,
    repairedScript: cfg.claudeRunScript && cfg.claudeRunScript !== expectedScript ? cfg.claudeRunScript : null,
    model,
    permissionMode: resolveClaudePermissionMode(cfg.claudePermissionMode),
    checks,
    error: ok ? null : checks.find(check => !check.ok)?.detail || 'Claude runner setup failed',
  }
}

export function updateProjectRunner(statusPath, runner) {
  const normalized = normalizeIncubatorStatus(statusPath)
  const status = normalized.status
  if (runner === 'codex') {
    status.runner = 'codex'
    status.runScript = runnableLauncherForStatus(status) || INCUBATOR_RUNNER_SCRIPT
    status.promptDir = status.promptDir || join(status.repo, 'prompts')
    status.runTypes = status.runTypes || [...DEFAULT_RUN_TYPES]
    status.codexBypass = false
  } else if (runner === 'claude') {
    const setup = claudeRunnerSetupForStatus(status)
    const relayScript = setup.script || setup.expectedScript || GENERIC_CLAUDE_INCUBATOR_SCRIPT
    status.runner = 'claude'
    status.runScript = runnableLauncherForStatus(status) || relayScript
    if (setup.model) status.claudeModel = setup.model
    else delete status.claudeModel
    status.claudeRunScript = relayScript
    status.claudeBypass = false
    status.promptDir = status.promptDir || join(status.repo, 'prompts')
    status.runTypes = status.runTypes || [...DEFAULT_RUN_TYPES]
    writeJsonAtomic(statusPath, status)
    const selectedDetail = `${setup.model || 'Claude CLI default'} via ${status.runScript}${status.runScript === relayScript ? '' : ` -> ${relayScript}`}`
    return {
      ok: true,
      status,
      setup,
      repaired: normalized.repaired,
      warning: setup.ok ? `Claude relay selected: ${selectedDetail}` : `Claude relay selected but blocked: ${setup.error || 'runner preflight failed'} (${selectedDetail})`,
    }
  } else {
    return { ok: false, error: 'unsupported runner' }
  }
  writeJsonAtomic(statusPath, status)
  return { ok: true, status, repaired: normalized.repaired }
}

export function repairClaudeRunnerStatusIfNeeded(statusPath) {
  const normalized = normalizeIncubatorStatus(statusPath)
  const status = normalized.status
  if (status.runner !== 'claude') return normalized

  const setup = claudeRunnerSetupForStatus(status)
  const next = { ...status }
  let repaired = normalized.repaired
  const safeRelayScript = setup.script || setup.expectedScript || GENERIC_CLAUDE_INCUBATOR_SCRIPT
  const safeRunScript = runnableLauncherForStatus(next) || safeRelayScript

  if (next.runScript !== safeRunScript) {
    next.runScript = safeRunScript
    repaired = true
  }
  if (next.claudeRunScript !== safeRelayScript) {
    next.claudeRunScript = safeRelayScript
    repaired = true
  }
  if (next.claudeModel !== setup.model) {
    if (setup.model) next.claudeModel = setup.model
    else delete next.claudeModel
    repaired = true
  }
  if (!next.promptDir && next.repo) {
    next.promptDir = join(next.repo, 'prompts')
    repaired = true
  }
  if (!next.runTypes) {
    next.runTypes = [...DEFAULT_RUN_TYPES]
    repaired = true
  }
  if (next.claudeBypass !== false) {
    next.claudeBypass = false
    repaired = true
  }

  if (repaired) {
    writeJsonAtomic(statusPath, next)
  }
  return { status: next, repaired }
}

// ─── Project scaffold ─────────────────────────────────────────────────────────

export function uniqueIncubatorSlug(seed) {
  const base = slugifyProjectName(seed)
  const data = readIncubators()
  const used = new Set(data.slots.map(slot => slot.id))
  for (let i = 0; i < 50; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`
    if (used.has(slug)) continue
    if (fs.existsSync(join(INCUBATOR_REPO_ROOT, slug))) continue
    if (fs.existsSync(join(PROJECTS_DIR, slug))) continue
    return slug
  }
  return `${base}-${Date.now().toString(36)}`
}

export function projectFeedbackPath(cfg) {
  const fallback = join(cfg.repo || LAB_ROOT, 'reports', 'USER_FEEDBACK.md')
  return pathInside(cfg.feedbackPath, cfg.repo || '') ? cfg.feedbackPath : fallback
}

// Notes are appended as `## <timestamp>` sections under a file header; the
// latest note is the last section's body, never the header text.
export function readLatestProjectFeedback(filePath, maxChars = 900) {
  try {
    const sections = fs.readFileSync(filePath, 'utf8').split(/^## .*$/m).slice(1)
    const latest = sections.map(section => section.trim()).filter(Boolean).pop()
    return latest ? latest.slice(-maxChars) : null
  } catch {
    return null
  }
}

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function ensureDirectory(filePath) {
  try {
    fs.mkdirSync(filePath, { recursive: true })
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function ensureIncubatorProjectScaffold(status) {
  const project = status.project || 'incubator'
  if (status.repo) ensureDirectory(join(status.repo, 'reports'))
  if (status.runLog) writeFileIfMissing(status.runLog, '# Run Log\n\n')
  if (status.recentRuns) writeFileIfMissing(status.recentRuns, '# Recent Runs\n\n*(no runs yet)*\n')
  if (status.feedbackPath) {
    writeFileIfMissing(status.feedbackPath, `# User Feedback / Steering Notes

These notes are written from the Pi Pulse UI and injected into future incubator runs.
`)
  }
  if (status.promptDir && ensureDirectory(status.promptDir)) {
    const runTypes = Array.isArray(status.runTypes) && status.runTypes.length ? status.runTypes : ['mutate']
    for (const runType of new Set(runTypes.map(safeRunTypeName))) {
      writeFileIfMissing(join(status.promptDir, `${runType}.md`), promptForIncubatorRunType(project, runType))
    }
  }
}

function writeIncubatorLauncher({ slug, statusPath }) {
  const launcherPath = join(PROJECTS_DIR, slug, `run-${slug}.sh`)
  const content = incubatorLauncherScript({ runnerScript: INCUBATOR_RUNNER_SCRIPT, statusPath })
  let repaired = false
  try {
    const current = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : ''
    if (current !== content) {
      fs.mkdirSync(dirname(launcherPath), { recursive: true })
      fs.writeFileSync(launcherPath, content)
      repaired = true
    }
  } catch {
    try {
      fs.mkdirSync(dirname(launcherPath), { recursive: true })
      fs.writeFileSync(launcherPath, content)
      repaired = true
    } catch {}
  }
  try { fs.chmodSync(launcherPath, 0o755) } catch {}
  return { path: launcherPath, repaired }
}

// Repairs a status file in place so every code path sees the same shape:
// trusted repo/log/prompt paths, no persisted bypass, generic Claude relay, a
// current project launcher, and the prompt/log scaffold the runner expects.
export function normalizeIncubatorStatus(statusPath) {
  const safeStatusPath = assertTrustedStatusPath(statusPath)
  const status = readStatusAt(safeStatusPath)
  const next = { ...status }
  let changed = false
  const project = safePathSegment(next.project || basename(dirname(safeStatusPath)), 'incubator')
  const fallbackProjectRoot = join(INCUBATOR_REPO_ROOT, project)
  const projectRoot = trustedIncubatorRepo(next.repo) ? resolve(next.repo) : fallbackProjectRoot
  const reportsRoot = join(projectRoot, 'reports')

  if (next.project !== project) {
    next.project = project
    changed = true
  }
  if (!pathInside(next.repo, projectRoot)) {
    next.repo = projectRoot
    changed = true
  }
  if (!pathInside(next.runLog, reportsRoot)) {
    next.runLog = join(reportsRoot, 'RUN_LOG.md')
    changed = true
  }
  if (!pathInside(next.recentRuns, reportsRoot)) {
    next.recentRuns = join(reportsRoot, 'RECENT_RUNS.md')
    changed = true
  }
  if (!pathInside(next.promptDir, projectRoot)) {
    next.promptDir = join(projectRoot, 'prompts')
    changed = true
  }
  if (!next.runTypes) {
    next.runTypes = [...DEFAULT_RUN_TYPES]
    changed = true
  }
  if (next.codexBypass !== false) {
    next.codexBypass = false
    changed = true
  }
  if (next.claudeBypass !== false) {
    next.claudeBypass = false
    changed = true
  }
  if (!pathInside(next.feedbackPath, reportsRoot)) {
    next.feedbackPath = join(reportsRoot, 'USER_FEEDBACK.md')
    changed = true
  }

  const launcherInfo = writeIncubatorLauncher({ slug: project, statusPath: safeStatusPath })
  const launcher = launcherInfo.path
  if (launcherInfo.repaired) changed = true
  if (next.launcher !== launcher) {
    next.launcher = launcher
    changed = true
  }
  if (next.claudeRunScript !== GENERIC_CLAUDE_INCUBATOR_SCRIPT) {
    next.claudeRunScript = GENERIC_CLAUDE_INCUBATOR_SCRIPT
    changed = true
  }
  if (next.claudeModel && !firstRunnableClaudeModel(next.claudeModel)) {
    delete next.claudeModel
    changed = true
  }

  const genericEntrypoints = new Set([
    INCUBATOR_RUNNER_SCRIPT,
    CODEX_INCUBATOR_SCRIPT,
    GENERIC_CLAUDE_INCUBATOR_SCRIPT,
  ])
  const allowedRunScriptRoots = [PROJECTS_DIR, join(LAB_ROOT, 'scripts'), join(PI_PULSE_ROOT, 'scripts')]
  if (!next.runScript || genericEntrypoints.has(next.runScript) || !pathInsideAny(next.runScript, allowedRunScriptRoots)) {
    next.runScript = next.launcher
    changed = true
  }

  ensureIncubatorProjectScaffold(next)

  if (changed) writeJsonAtomic(safeStatusPath, next)
  return { status: next, repaired: changed }
}

export function createIncubatorProjectFromIdea(idea, requestedTitle = '') {
  const cleanIdea = String(idea || '').trim()
  if (cleanIdea.length < 8) {
    return { ok: false, status: 400, error: 'project idea is too short' }
  }
  const title = normalizedIncubatorTitle(requestedTitle) || suggestedIncubatorTitle(cleanIdea)
  const slug = uniqueIncubatorSlug(title)
  const incubatorRole = inferIncubatorRole({ id: slug, displayName: title, current_focus: cleanIdea })
  const repo = join(INCUBATOR_REPO_ROOT, slug)
  const labProjectDir = join(PROJECTS_DIR, slug)
  const promptDir = join(repo, 'prompts')
  const reportsDir = join(repo, 'reports')
  const feedbackPath = join(reportsDir, 'USER_FEEDBACK.md')
  const runLog = join(reportsDir, 'RUN_LOG.md')
  const recentRuns = join(reportsDir, 'RECENT_RUNS.md')

  fs.mkdirSync(promptDir, { recursive: true })
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.mkdirSync(labProjectDir, { recursive: true })

  writeFileIfMissing(join(repo, 'README.md'), `# ${title}

Seed idea:

${cleanIdea}

This project was created from the Pi Pulse Add Incubator idea box.
`)
  writeFileIfMissing(join(promptDir, 'create.md'), promptForIncubatorRunType('this incubator project', 'create', cleanIdea, incubatorRole))
  writeFileIfMissing(join(promptDir, 'mutate.md'), promptForIncubatorRunType('this incubator project', 'mutate', cleanIdea, incubatorRole))
  writeFileIfMissing(join(promptDir, 'research.md'), promptForIncubatorRunType('this incubator project', 'research', cleanIdea, incubatorRole))
  writeFileIfMissing(runLog, `# Run Log\n\n`)
  writeFileIfMissing(recentRuns, `# Recent Runs\n\n*(no runs yet)*\n`)
  writeFileIfMissing(feedbackPath, `# User Feedback / Steering Notes

These notes are written from the Pi Pulse UI and injected into future incubator runs.

## Seed

${cleanIdea}
`)

  const status = {
    project: slug,
    displayName: title,
    incubatorTitle: title,
    incubatorRole,
    status: 'seeded',
    phase: 'idea-seed',
    runner: 'codex',
    repo,
    runLog,
    recentRuns,
    runScript: INCUBATOR_RUNNER_SCRIPT,
    claudeRunScript: GENERIC_CLAUDE_INCUBATOR_SCRIPT,
    promptDir,
    feedbackPath,
    runTypes: ['create', 'mutate', 'research', 'mutate'],
    runCount: 0,
    lastRun: null,
    lastRunType: null,
    current_focus: cleanIdea.slice(0, 260),
    next_run_goal: 'Run CREATE to turn this idea into the first usable local prototype.',
    notes: 'Created from Pi Pulse Add Incubator idea box.',
    codexBypass: false,
    claudeBypass: false,
    claudeModel: null,
  }
  const statusPath = join(labProjectDir, 'status.json')
  status.launcher = writeIncubatorLauncher({ slug, statusPath }).path
  status.runScript = status.launcher
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n')
  return { ok: true, slug, statusPath, status }
}

export function feedbackPathsForIncubator(cfg) {
  if (cfg.project === 'pi-pulse') {
    return {
      json: CORE_FEEDBACK_JSON,
      md: CORE_FEEDBACK_MD,
    }
  }
  const memoryDir = join(cfg.repo, 'memory')
  if (fs.existsSync(memoryDir)) {
    return {
      json: join(memoryDir, 'DRIFT_FEEDBACK.json'),
      md: join(memoryDir, 'DRIFT_FEEDBACK.md'),
    }
  }
  return {
    json: join(cfg.repo, 'reports', 'DRIFT_FEEDBACK.json'),
    md: join(cfg.repo, 'reports', 'DRIFT_FEEDBACK.md'),
  }
}
