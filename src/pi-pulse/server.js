import express from 'express'
import fs from 'fs'
import os from 'os'
import { createHash } from 'crypto'
import { spawn, execFile, execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'path'
import {
  appendFailedPreflightEntry,
  appendFailedRunEntry,
  aiFeedbackPayload,
  capturedFailureDetail,
  checkClaudeCommand,
  checkClaudeModel,
  checkPath,
  firstRunnableClaudeModel,
  hydrateAiFeedback,
  parseRunsFromLog,
  qualityStateFromRun,
  preflightFailureDetail,
  preflightRunConfig,
  runsWithPinnedLatestFailure,
  SAFE_CLAUDE_MODEL,
  summarizeRun,
} from './server-core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const mountedPlayRoutes = new Set()
const PORT = Number(process.env.PORT || 8089)
const HOST = process.env.PI_PULSE_HOST || process.env.HOST || '127.0.0.1'
const SERVER_STARTED_AT = Date.now()
const SCHEDULES_ENABLED = process.env.PI_PULSE_DISABLE_SCHEDULES !== '1'
const WRITE_AUTH_TOKEN = process.env.PI_PULSE_ADMIN_TOKEN || ''
const TRUST_CLOUDFLARE_ACCESS = process.env.PI_PULSE_TRUST_CF_ACCESS === '1'
const PROXY_WRITE_HEADER_NAMES = ['cf-connecting-ip', 'x-forwarded-for', 'cf-ray']
const REQUIRE_WRITE_AUTH = process.env.PI_PULSE_REQUIRE_WRITE_AUTH === '1' || !!WRITE_AUTH_TOKEN || TRUST_CLOUDFLARE_ACCESS
const MIN_SCHEDULE_INTERVAL_HOURS = Number(process.env.PI_PULSE_MIN_SCHEDULE_INTERVAL_HOURS || 0.25)
const MAX_SCHEDULE_INTERVAL_HOURS = Number(process.env.PI_PULSE_MAX_SCHEDULE_INTERVAL_HOURS || 24)
const MAX_CONSECUTIVE_AUTONOMOUS_FAILS = Number(process.env.PI_PULSE_MAX_CONSECUTIVE_AUTONOMOUS_FAILS || 5)
const GENERATED_APP_CSP = "default-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
const LAB_ROOT = process.env.PI_PULSE_LAB_ROOT || '/home/admin/lab'
const INCUBATOR_REPO_ROOT = process.env.PI_PULSE_INCUBATOR_REPO_ROOT || '/home/admin'
const PROJECTS_DIR = process.env.PI_PULSE_PROJECTS_DIR || join(LAB_ROOT, 'projects')
const RUN_LOG_PATH = process.env.PI_PULSE_RUN_LOG_PATH || join(LAB_ROOT, 'RUN_LOG.md')
const PROJECT_STATUS_PATH = process.env.PI_PULSE_PROJECT_STATUS_PATH || join(PROJECTS_DIR, 'pi-pulse', 'status.json')
const LAB_SCHEDULE_PATH = process.env.PI_PULSE_LAB_SCHEDULE_PATH || join(PROJECTS_DIR, 'pi-pulse', 'schedule.json')
const RUN_CAPTURE_DIR = process.env.PI_PULSE_RUN_CAPTURE_DIR || join(PROJECTS_DIR, '.run-capture')
const RUN_LOCK_DIR = process.env.PI_PULSE_RUN_LOCK_DIR || join(PROJECTS_DIR, '.run-locks')
const DAILY_SEED_PATH = process.env.PI_PULSE_DAILY_SEED_PATH || join(LAB_ROOT, 'DAILY_SEED.md')
const CORE_SEED_PATH = process.env.PI_PULSE_CORE_SEED_PATH || join(PROJECTS_DIR, 'pi-pulse', 'seed.md')
const CORE_FEEDBACK_JSON = process.env.PI_PULSE_CORE_FEEDBACK_JSON || join(LAB_ROOT, 'DRIFT_FEEDBACK.json')
const CORE_FEEDBACK_MD = process.env.PI_PULSE_CORE_FEEDBACK_MD || join(LAB_ROOT, 'DRIFT_FEEDBACK.md')
const USER_FEEDBACK_PATH = process.env.PI_PULSE_USER_FEEDBACK_PATH || join(LAB_ROOT, 'USER_FEEDBACK.md')
const DEFAULT_LAB_RUNNER = 'codex'
const GENERIC_CLAUDE_INCUBATOR_SCRIPT = process.env.PI_PULSE_CLAUDE_INCUBATOR_SCRIPT || join(__dirname, 'scripts', 'run-claude-incubator.sh')
const DEFAULT_CLAUDE_MODEL = process.env.PI_PULSE_DEFAULT_CLAUDE_MODEL || SAFE_CLAUDE_MODEL
const SOURCE_HEALTH_FILES = [
  join(__dirname, 'server.js'),
  join(__dirname, 'server-core.js'),
  join(__dirname, 'scripts', 'run-claude-incubator.sh'),
  join(__dirname, 'scripts', 'app-evidence.mjs'),
  ...String(process.env.PI_PULSE_SOURCE_HEALTH_FILES || '').split(':').filter(Boolean),
]

function sourceSnapshot() {
  const hash = createHash('sha256')
  let latestMtimeMs = 0
  const files = SOURCE_HEALTH_FILES.map(filePath => {
    const label = filePath.startsWith(__dirname) ? filePath.slice(__dirname.length + 1) : filePath
    try {
      const st = fs.statSync(filePath)
      const content = fs.readFileSync(filePath)
      hash.update(label)
      hash.update('\0')
      hash.update(content)
      hash.update('\0')
      latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs)
      return { path: label, mtime: new Date(st.mtimeMs).toISOString(), bytes: st.size }
    } catch (err) {
      hash.update(label)
      hash.update(`\0missing:${err.code || err.message}\0`)
      return { path: label, error: err.code || err.message }
    }
  })
  return {
    fingerprint: hash.digest('hex').slice(0, 12),
    latestMtime: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
    files,
  }
}

const BOOT_SOURCE_SNAPSHOT = sourceSnapshot()

function serviceHealth() {
  const currentSource = sourceSnapshot()
  const changedSinceStart = currentSource.fingerprint !== BOOT_SOURCE_SNAPSHOT.fingerprint
  return {
    ok: true,
    ts: Date.now(),
    pid: process.pid,
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    source: {
      ...currentSource,
      bootFingerprint: BOOT_SOURCE_SNAPSHOT.fingerprint,
      bootLatestMtime: BOOT_SOURCE_SNAPSHOT.latestMtime,
      changedSinceStart,
    },
  }
}

function requireFreshSource(req, res, next) {
  const health = serviceHealth()
  if (!health.source.changedSinceStart) return next()
  return res.status(409).json({
    ok: false,
    code: 'STALE_SERVICE_SOURCE',
    error: 'service source changed since start; restart Pi Pulse before mutating runner state',
    startedAt: health.startedAt,
    source: health.source,
  })
}

function bearerToken(req) {
  const auth = String(req.get('authorization') || '')
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function hasCloudflareAccessIdentity(req) {
  return Boolean(req.get('cf-access-authenticated-user-email') || req.get('cf-access-jwt-assertion'))
}

function isProxiedWrite(req) {
  return PROXY_WRITE_HEADER_NAMES.some(name => req.get(name))
}

function hasTrustedWriteIdentity(req) {
  if (WRITE_AUTH_TOKEN) {
    const supplied = req.get('x-pi-pulse-admin-token') || bearerToken(req)
    if (supplied === WRITE_AUTH_TOKEN) return true
  }
  if (TRUST_CLOUDFLARE_ACCESS && hasCloudflareAccessIdentity(req)) return true
  if (TRUST_CLOUDFLARE_ACCESS) return false
  return !REQUIRE_WRITE_AUTH && !isProxiedWrite(req)
}

function requireTrustedWrite(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
  if (hasTrustedWriteIdentity(req)) return next()
  return res.status(401).json({
    ok: false,
    code: 'WRITE_AUTH_REQUIRED',
    error: 'write routes require Cloudflare Access identity or PI_PULSE_ADMIN_TOKEN',
  })
}

function clampScheduleInterval(value, fallback = 0.5) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(MAX_SCHEDULE_INTERVAL_HOURS, Math.max(MIN_SCHEDULE_INTERVAL_HOURS, numeric))
}

function pathInside(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false
  const target = resolve(String(targetPath))
  const root = resolve(String(rootPath))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathInsideAny(targetPath, roots = []) {
  return roots.some(root => pathInside(targetPath, root))
}

function safePathSegment(value, fallback = 'project') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}


function trustedIncubatorRepo(repoPath) {
  if (!pathInside(repoPath, INCUBATOR_REPO_ROOT)) return false
  if (resolve(INCUBATOR_REPO_ROOT) === resolve(LAB_ROOT)) return true
  return !pathInside(repoPath, LAB_ROOT)
}

function assertTrustedStatusPath(statusPath) {
  const resolved = resolve(String(statusPath || ''))
  if (!pathInside(resolved, PROJECTS_DIR)) throw new Error('status path outside trusted project root')
  const st = fs.lstatSync(resolved)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('status path is not a regular trusted file')
  return resolved
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

function generatedAppSecurityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', GENERATED_APP_CSP)
  res.setHeader('X-Pi-Pulse-App-Isolation', 'restricted-csp')
  next()
}

function requestPathFromHeader(value, req) {
  if (!value) return ''
  try {
    return new URL(String(value), `http://${req.get('host') || '127.0.0.1'}`).pathname
  } catch {
    return ''
  }
}

function requestFromMountedAppRoute(req) {
  const refPath = requestPathFromHeader(req.get('referer'), req)
  if (!refPath) return false
  for (const route of mountedPlayRoutes) {
    if (refPath === route || refPath.startsWith(`${route}/`)) return true
  }
  for (const slot of readIncubators().slots || []) {
    try {
      const cfg = readStatusAt(slot.statusPath)
      const route = `/${cfg.project.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
      if ((refPath === route || refPath.startsWith(`${route}/`)) && fs.existsSync(join(cfg.repo, 'index.html'))) return true
    } catch {
      // Keep checking other incubators; auth still applies after this guard.
    }
  }
  return false
}

function rejectGeneratedAppControlWrite(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
  if (!requestFromMountedAppRoute(req)) return next()
  return res.status(403).json({
    ok: false,
    code: 'APP_CONTROL_API_FORBIDDEN',
    error: 'generated app routes cannot call Pi Pulse control-plane writes',
  })
}

// CPU usage calculation (requires two samples)
let prevCpuTimes = null

// Network I/O — requires two samples to compute bytes/sec rate
let prevNetSample = null
let lastNetRate = { rx: 0, tx: 0, iface: 'unknown' }

// Cached last stats payload — used for SSE fanout.
let lastStatsPayload = null

let diskInfoCache = { ts: 0, value: null }

// Active run tracking — cleared after process exits and status is read
let activeRun = null // { pid, startTime }

const LAB_RUNNERS = {
  claude: {
    script: join(LAB_ROOT, 'run-lab.sh'),
    args: [],
  },
  codex: {
    script: '/home/admin/lab/scripts/run-codex-incubator.sh',
    args: [PROJECT_STATUS_PATH],
  },
}
let labScheduleState = { enabled: false, intervalHours: 2, runner: DEFAULT_LAB_RUNNER, nextRunAt: null, lastScheduledRun: null, autoRunsSinceHuman: 0 }

try {
  const raw = fs.readFileSync(LAB_SCHEDULE_PATH, 'utf8')
  const loaded = JSON.parse(raw)
  labScheduleState = { ...labScheduleState, ...loaded }
  labScheduleState.intervalHours = clampScheduleInterval(labScheduleState.intervalHours, 2)
  labScheduleState.runner = normalizeLabRunner(labScheduleState.runner)
  if (labScheduleState.enabled && labScheduleState.nextRunAt && labScheduleState.nextRunAt < Date.now()) {
    labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
  }
} catch { /* no host lab schedule yet */ }

function saveLabSchedule() {
  try { fs.writeFileSync(LAB_SCHEDULE_PATH, JSON.stringify(labScheduleState, null, 2) + '\n') } catch {}
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function activeRunAlive() {
  if (!activeRun) return false
  if (pidAlive(activeRun.pid)) return true
  activeRun = null
  return false
}

function runLockPath() {
  return join(RUN_LOCK_DIR, 'global')
}

function readRunLock() {
  try { return JSON.parse(fs.readFileSync(join(runLockPath(), 'owner.json'), 'utf8')) } catch { return null }
}

function clearRunLock() {
  try { fs.rmSync(runLockPath(), { recursive: true, force: true }) } catch {}
}

function currentRunLock() {
  const lock = readRunLock()
  if (!lock?.pid) { clearRunLock(); return null }
  if (pidAlive(lock.pid)) return lock
  clearRunLock()
  return null
}

function acquireRunLock(owner = {}) {
  fs.mkdirSync(RUN_LOCK_DIR, { recursive: true })
  const lockDir = runLockPath()
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    fs.mkdirSync(lockDir)
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const existing = currentRunLock()
      if (existing) return { ok: false, code: 'GLOBAL_RUN_LOCK_ACTIVE', ...existing }
      fs.mkdirSync(lockDir)
    } else {
      throw err
    }
  }
  const lock = { ok: true, token, pid: null, startedAt: new Date().toISOString(), ...owner }
  writeJsonAtomic(join(lockDir, 'owner.json'), lock)
  return lock
}

function activateRunLock(lock, pid) {
  if (!lock?.ok) return
  writeJsonAtomic(join(runLockPath(), 'owner.json'), { ...lock, pid })
}

function releaseRunLock(lock) {
  if (!lock?.ok) return
  const current = readRunLock()
  if (!current || current.token === lock.token) clearRunLock()
}

function globalRunBusy() {
  return currentRunLock()
}

function normalizeLabRunner(runner) {
  return Object.hasOwn(LAB_RUNNERS, runner) ? runner : DEFAULT_LAB_RUNNER
}

function preflightLabRun(runner = labScheduleState.runner) {
  const selected = normalizeLabRunner(runner)
  const cfg = LAB_RUNNERS[selected]
  let status = {}
  try { status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}
  const claudeModel = selected === 'claude'
    ? firstRunnableClaudeModel(
        status.claudeModel,
        process.env.CLAUDE_MODEL,
        process.env.DEFAULT_CLAUDE_MODEL,
        DEFAULT_CLAUDE_MODEL,
        SAFE_CLAUDE_MODEL
      )
    : status.claudeModel
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

function preflightIncubatorRun(slot, runType = null) {
  const { status: cfg } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)
  const selected = cfg.runner ?? 'script'
  const claudeModel = selected === 'claude'
    ? firstRunnableClaudeModel(
        cfg.claudeModel,
        process.env.CLAUDE_MODEL,
        process.env.DEFAULT_CLAUDE_MODEL,
        DEFAULT_CLAUDE_MODEL,
        SAFE_CLAUDE_MODEL
      )
    : cfg.claudeModel
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

function nextCoreRunNum() {
  try { return (JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')).runCount ?? 0) + 1 } catch { return 1 }
}

function nextIncubatorRunNum(slot) {
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

function markIncubatorProcessFailure({ statusPath, capturePath, code, signal, num }) {
  if (!statusPath || !num) return
  try {
    const status = readStatusAt(statusPath)
    const today = new Date().toISOString().slice(0, 10)
    const reason = signal ? `signal ${signal}` : `exit ${code}`
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

function appendIncubatorPreflightFailure({ slot, runLogPath, preflight, source, label }) {
  const num = nextIncubatorRunNum(slot)
  appendFailedPreflightEntry({ runLogPath, preflight, num, source, label })
  markIncubatorPreflightAttempt({ statusPath: slot.statusPath, preflight, num, label })
  return num
}

function appendManualPreflightFailure({ slot = null, runLogPath, preflight, num = null }) {
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

function appendRunnerSwitchPreflightFailure({ slot, runLogPath, preflight }) {
  return appendIncubatorPreflightFailure({
    slot,
    runLogPath,
    preflight,
    source: 'runner-switch-preflight',
    label: 'runner switch preflight',
  })
}

// Runner spawns used stdio:'ignore', so a preflight failure (exit 127, bad
// script) died before its first RUN_LOG write and left no trace in history.
// spawnTrackedRun keeps the child detached but routes its output to a capture
// file; on non-zero exit it appends a FAILED stdout block — with the actual
// command error — to the target run log so the parser surfaces it.
function spawnTrackedRun({ script, args = [], cwd, captureName, runLogPath, nextRunNum, onExit, env = {}, lock = null }) {
  let stdio = 'ignore'
  const capturePath = join(RUN_CAPTURE_DIR, `${captureName}.log`)
  try {
    fs.mkdirSync(RUN_CAPTURE_DIR, { recursive: true })
    const fd = fs.openSync(capturePath, 'w')
    stdio = ['ignore', fd, fd]
  } catch { /* capture unavailable — run blind as before */ }
  const child = spawn('bash', [script, ...args], { cwd, detached: true, stdio, env: { ...process.env, ...env } })
  activateRunLock(lock, child.pid)
  if (Array.isArray(stdio)) { try { fs.closeSync(stdio[1]) } catch {} }
  child.unref()
  child.on('exit', (code, signal) => {
    releaseRunLock(lock)
    if (code || signal) {
      const failedRunNum = nextRunNum?.() ?? 0
      appendFailedRunEntry({ runLogPath, capturePath, code, signal, num: failedRunNum })
      onExit?.(code, signal, { capturePath, failedRunNum })
      return
    }
    onExit?.(code, signal, { capturePath, failedRunNum: null })
  })
  return child
}

function startLabRun(runner = labScheduleState.runner, options = {}) {
  const selected = normalizeLabRunner(runner)
  const preflight = preflightLabRun(selected)
  if (!preflight.ok) return null
  const existing = globalRunBusy()
  if (existing) return null
  const lock = acquireRunLock({ kind: 'core', id: 'pi-pulse', runner: selected })
  if (!lock.ok) return null
  const cfg = LAB_RUNNERS[selected]
  const runEnv = options.scheduled ? { PI_PULSE_SCHEDULED_RUN: '1' } : {}
  if (selected === 'claude') {
    let status = {}
    try { status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}
    const model = firstRunnableClaudeModel(status.claudeModel, process.env.CLAUDE_MODEL, process.env.DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_MODEL, SAFE_CLAUDE_MODEL)
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

function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8')
    const line = stat.split('\n')[0]
    const parts = line.replace('cpu  ', '').trim().split(/\s+/).map(Number)
    const [user, nice, system, idle, iowait, irq, softirq, steal] = parts
    const total = user + nice + system + idle + (iowait || 0) + (irq || 0) + (softirq || 0) + (steal || 0)
    return { total, idle: idle + (iowait || 0) }
  } catch {
    return null
  }
}

function getCpuUsage() {
  const curr = readCpuTimes()
  if (!curr || !prevCpuTimes) {
    prevCpuTimes = curr
    return 0
  }
  const totalDiff = curr.total - prevCpuTimes.total
  const idleDiff = curr.idle - prevCpuTimes.idle
  prevCpuTimes = curr
  if (totalDiff === 0) return 0
  return Math.round(((totalDiff - idleDiff) / totalDiff) * 100)
}

function getMemInfo() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8')
    const parse = (key) => {
      const match = mem.match(new RegExp(key + ':\\s+(\\d+)'))
      return match ? parseInt(match[1]) * 1024 : 0
    }
    const total = parse('MemTotal')
    const available = parse('MemAvailable')
    if (total > 0 && available > 0) {
      const used = total - available
      return {
        total,
        used,
        free: available,
        percent: Math.round((used / total) * 100),
      }
    }
    const free = parse('MemFree')
    const buffers = parse('Buffers')
    const cached = parse('Cached')
    const reclaimable = parse('SReclaimable')
    const used = total - free - buffers - cached - reclaimable
    return {
      total,
      used,
      free: total - used,
      percent: Math.round((used / total) * 100),
    }
  } catch {
    const total = os.totalmem()
    const free = os.freemem()
    return { total, used: total - free, free, percent: Math.round(((total - free) / total) * 100) }
  }
}

function getTemperature() {
  const paths = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/class/hwmon/hwmon0/temp1_input',
  ]
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim()
      const temp = parseInt(raw)
      return temp > 1000 ? temp / 1000 : temp
    } catch { /* continue */ }
  }
  return null
}

function getUptime() {
  try {
    const raw = fs.readFileSync('/proc/uptime', 'utf8')
    return Math.floor(parseFloat(raw.split(' ')[0]))
  } catch {
    return os.uptime()
  }
}

function getLoadAvg() {
  try {
    const raw = fs.readFileSync('/proc/loadavg', 'utf8')
    const parts = raw.trim().split(' ')
    return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])]
  } catch {
    return os.loadavg()
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getDiskInfo() {
  const now = Date.now()
  if (now - diskInfoCache.ts < 30_000) return diskInfoCache.value

  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync('/')
      const bsize = Number(stats.bsize)
      const total = Number(stats.blocks) * bsize
      const free = Number(stats.bfree) * bsize
      const available = Number(stats.bavail) * bsize
      const used = Math.max(0, total - free)
      const percent = used + available > 0 ? Math.round((used / (used + available)) * 100) : 0
      diskInfoCache = {
        ts: now,
        value: {
          totalGB: (total / 1e9).toFixed(1),
          usedGB: (used / 1e9).toFixed(1),
          percent,
        },
      }
      return diskInfoCache.value
    }
  } catch { /* fall back to df below */ }

  try {
    const out = execSync('df -B1 /', { timeout: 3000 }).toString().trim()
    const lines = out.split('\n')
    if (lines.length < 2) return null
    const parts = lines[1].trim().split(/\s+/)
    const total = parseInt(parts[1])
    const used = parseInt(parts[2])
    const pct = parseInt(parts[4])
    diskInfoCache = {
      ts: now,
      value: {
        totalGB: (total / 1e9).toFixed(1),
        usedGB: (used / 1e9).toFixed(1),
        percent: isNaN(pct) ? 0 : pct,
      },
    }
    return diskInfoCache.value
  } catch {
    return null
  }
}


const parsedRunLogCache = new Map()

function stdoutRootsForLog(filePath) {
  return [join(dirname(filePath), 'stdout'), RUN_CAPTURE_DIR]
}

function parsedRunsForLog(filePath) {
  const stat = fs.statSync(filePath)
  const cached = parsedRunLogCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.runs
  const content = fs.readFileSync(filePath, 'utf8')
  const runs = parseRunsFromLog(content, { stdoutRoots: stdoutRootsForLog(filePath) })
  parsedRunLogCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, runs })
  return runs
}

function readLogContent(filePath, { maxBytes = 512 * 1024, full = false } = {}) {
  const stat = fs.statSync(filePath)
  if (full || stat.size <= maxBytes) {
    return { content: fs.readFileSync(filePath, 'utf8'), truncated: false, bytes: stat.size }
  }
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes)
    return { content: buffer.toString('utf8'), truncated: true, bytes: stat.size, tailBytes: maxBytes }
  } finally {
    fs.closeSync(fd)
  }
}

function getNetworkRate() {
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8')
    const lines = raw.trim().split('\n').slice(2)
    const SKIP = /^(lo|docker|veth|br-|vmnet|virbr)/
    let best = null
    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx < 0) continue
      const iface = line.slice(0, colonIdx).trim()
      if (SKIP.test(iface)) continue
      const fields = line.slice(colonIdx + 1).trim().split(/\s+/).map(Number)
      const rx = fields[0]  // receive bytes
      const tx = fields[8]  // transmit bytes
      if (!best || rx > best.rx) best = { iface, rx, tx, ts: Date.now() }
    }
    if (!best) {
      lastNetRate = { rx: 0, tx: 0, iface: 'unknown' }
      return lastNetRate
    }
    if (!prevNetSample || best.iface !== prevNetSample.iface) {
      prevNetSample = best
      lastNetRate = { rx: 0, tx: 0, iface: best.iface }
      return lastNetRate
    }
    const dt = (best.ts - prevNetSample.ts) / 1000
    if (dt < 1) return { ...lastNetRate, iface: best.iface }
    const rx = dt > 0 ? Math.max(0, Math.round((best.rx - prevNetSample.rx) / dt)) : 0
    const tx = dt > 0 ? Math.max(0, Math.round((best.tx - prevNetSample.tx) / dt)) : 0
    prevNetSample = best
    lastNetRate = { rx, tx, iface: best.iface }
    return lastNetRate
  } catch {
    return { rx: 0, tx: 0, iface: 'unknown' }
  }
}

// ─── Project status sync ──────────────────────────────────────────────────────

function syncProjectStatus() {
  try {
    const runs = parsedRunsForLog(RUN_LOG_PATH)
    const latest = runs[runs.length - 1] ?? null

    let current = {}
    try { current = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}

    const qualityState = latest ? qualityStateFromRun(latest, latest.type !== 'FAILED') : {}
    const updated = {
      ...current,
      runCount: latest?.num ?? current.runCount ?? 0,
      lastRun: latest?.date ?? current.lastRun,
      lastRunType: latest?.type ?? current.lastRunType,
      ...qualityState,
      syncedAt: new Date().toISOString(),
    }

    fs.writeFileSync(PROJECT_STATUS_PATH, JSON.stringify(updated, null, 2) + '\n')

    // Keep project-level seed.md in sync with the daily seed
    try {
      const seedContent = fs.readFileSync(DAILY_SEED_PATH, 'utf8')
      fs.writeFileSync(CORE_SEED_PATH, seedContent)
    } catch { /* non-fatal */ }
  } catch (err) {
    console.warn('[pi-pulse] status sync error:', err.message)
  }
}

// Prime the CPU baseline
readCpuTimes()

// Sync project status on startup
syncProjectStatus()

app.use(express.json({ limit: '1mb' }))
app.use('/api', rejectGeneratedAppControlWrite, requireTrustedWrite)

// Serve built frontend in production
app.use(express.static(join(__dirname, 'dist')))

function buildStatsPayload() {
  const mem = getMemInfo()
  const temp = getTemperature()
  const uptimeSecs = getUptime()
  const load = getLoadAvg()
  const cpu = getCpuUsage()
  const disk = getDiskInfo()
  const net = getNetworkRate()
  return {
    cpu,
    memory: {
      ...mem,
      totalMB: Math.round(mem.total / 1024 / 1024),
      usedMB: Math.round(mem.used / 1024 / 1024),
    },
    temperature: temp,
    uptime: uptimeSecs,
    uptimeFormatted: formatUptime(uptimeSecs),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    loadAvg: load,
    disk,
    net,
    timestamp: Date.now(),
  }
}

// ─── Day buffer — 24h rolling snapshot of system state (5-min intervals) ──────
const DAY_BUFFER_PATH = join(__dirname, 'day-buffer.json')
const DAY_BUFFER_MAX = 288  // 24h × 12 per hour

// Load persisted buffer from disk (survives restarts)
let dayBuffer = []
try {
  const raw = fs.readFileSync(DAY_BUFFER_PATH, 'utf8')
  const loaded = JSON.parse(raw)
  // Drop entries older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  dayBuffer = loaded.filter(e => e.ts > cutoff).slice(-DAY_BUFFER_MAX)
} catch { /* file doesn't exist yet — start fresh */ }

function pushDaySnapshot() {
  const p = buildStatsPayload()
  dayBuffer.push({ ts: Date.now(), cpu: p.cpu ?? 0, temp: p.temperature ?? null, mem: p.memory?.percent ?? 0, rx: p.net?.rx ?? 0, tx: p.net?.tx ?? 0 })
  if (dayBuffer.length > DAY_BUFFER_MAX) dayBuffer.shift()
  // Persist async — don't block the event loop
  fs.writeFile(DAY_BUFFER_PATH, JSON.stringify(dayBuffer), () => {})
}

// Seed immediately after startup, then every 5 minutes
setTimeout(pushDaySnapshot, 3000)
setInterval(pushDaySnapshot, 5 * 60 * 1000)

// SSE — push stats to all connected clients every 2s
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
    lastStatsPayload = buildStatsPayload()
    const json = JSON.stringify(lastStatsPayload)
    for (const client of statsClients) {
      try { client.write(`data: ${json}\n\n`) } catch { statsClients.delete(client) }
    }
  }, 2000)
}

app.get('/api/stats/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  statsClients.add(res)
  startStatsPush()
  // Push immediately so the client gets data right away
  try {
    lastStatsPayload = buildStatsPayload()
    res.write(`data: ${JSON.stringify(lastStatsPayload)}\n\n`)
  } catch {}
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)
  req.on('close', () => {
    statsClients.delete(res)
    clearInterval(heartbeat)
  })
})

app.get('/api/stats', (req, res) => {
  res.json(buildStatsPayload())
})

app.get('/api/runs', (req, res) => {
  try {
    const runs = parsedRunsForLog(RUN_LOG_PATH)
    res.json(runsWithPinnedLatestFailure(runs, 10))
  } catch {
    res.json([])
  }
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
  if (activeRunAlive()) {
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
  if (!activeRun) return res.json({ running: false, pid: null, elapsed: 0, startTime: null })

  let alive = false
  try {
    process.kill(activeRun.pid, 0) // signal 0 = existence check only, no-op
    alive = true
  } catch { /* ESRCH — process no longer exists */ }

  const elapsed = Math.floor((Date.now() - activeRun.startTime) / 1000)
  const startTime = activeRun.startTime

  if (!alive) {
    activeRun = null
    return res.json({ running: false, pid: null, elapsed, startTime })
  }

  res.json({ running: true, pid: activeRun.pid, elapsed, startTime, runner: activeRun.runner ?? null })
})

// Check every 60s - fire the host Pi Pulse lab loop if its schedule is due.
if (SCHEDULES_ENABLED) {
  setInterval(() => {
    if (!labScheduleState.enabled || !labScheduleState.nextRunAt) return
    if (Date.now() < labScheduleState.nextRunAt) return
    if (activeRunAlive() || globalRunBusy()) return
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
      labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
      saveLabSchedule()
      return
    }
    console.log(`[pi-pulse] schedule: firing host lab run via ${runner}`)
    labScheduleState.runner = runner
    labScheduleState.lastScheduledRun = new Date().toISOString()
    labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
    labScheduleState.autoRunsSinceHuman = (labScheduleState.autoRunsSinceHuman || 0) + 1
    saveLabSchedule()
  }, 60 * 1000)
}

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
      labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
    }
  } else {
    labScheduleState.nextRunAt = null
  }
  labScheduleState.autoRunsSinceHuman = 0
  saveLabSchedule()
  res.json({ ok: true, availableRunners: Object.keys(LAB_RUNNERS), ...labScheduleState })
})

app.get('/api/health', (req, res) => {
  res.json(serviceHealth())
})

app.post('/api/lab/feedback', requireFreshSource, (req, res) => {
  const feedback = String(req.body?.feedback || '').trim()
  if (feedback.length < 3) return res.status(400).json({ ok: false, error: 'feedback is too short' })
  try {
    let status = {}
    try { status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}
    const filePath = status.feedbackPath || USER_FEEDBACK_PATH
    const stamp = new Date().toISOString()
    fs.mkdirSync(dirname(filePath), { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '# User Feedback / Steering Notes\n\nThese notes are written from the Pi Pulse UI and injected into future host incubator runs.\n')
    }
    fs.appendFileSync(filePath, `\n## ${stamp}\n\n${feedback}\n`)
    fs.appendFileSync(RUN_LOG_PATH, `\n## User Feedback - ${stamp}\n\n**Steering:** ${feedback}\n`)
    status = {
      ...status,
      feedbackPath: filePath,
      latestUserFeedback: feedback.slice(0, 2000),
      feedbackUpdatedAt: stamp,
      next_run_goal: `Use latest user feedback: ${feedback.slice(0, 180)}`,
    }
    fs.writeFileSync(PROJECT_STATUS_PATH, JSON.stringify(status, null, 2) + '\n')
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

// ─── Mounted project (config-driven) ──────────────────────────────────────────

const MOUNTED_CONFIG_PATH = process.env.PI_PULSE_MOUNTED_CONFIG_PATH || join(PROJECTS_DIR, 'mounted.json')

function loadMountedProject() {
  try {
    const mounted = JSON.parse(fs.readFileSync(MOUNTED_CONFIG_PATH, 'utf8'))
    const cfg = JSON.parse(fs.readFileSync(mounted.labStatus, 'utf8'))
    const repoStatusPath = join(cfg.repo, 'status.json')
    return {
      name:          cfg.project,
      dir:           cfg.repo,
      statusPath:    fs.existsSync(repoStatusPath) ? repoStatusPath : null,
      labStatusPath: mounted.labStatus,
      logPath:       cfg.runLog,
      runScript:     cfg.runScript,
    }
  } catch (err) {
    console.error('[incubator] mounted.json load failed, using race-whisperer fallback:', err.message)
    const dir = '/home/admin/race-whisperer-predict'
    return {
      name:          'race-whisperer-predict',
      dir,
      statusPath:    join(dir, 'status.json'),
      labStatusPath: '/home/admin/lab/projects/race-whisperer-predict/status.json',
      logPath:       join(dir, 'reports', 'RUN_LOG.md'),
      runScript:     '/home/admin/run-race-whisperer.sh',
    }
  }
}

const mountedProject        = loadMountedProject()
const CHILD_DIR             = mountedProject.dir
const CHILD_STATUS_PATH     = mountedProject.statusPath
const CHILD_LAB_STATUS_PATH = mountedProject.labStatusPath
const CHILD_LOG_PATH        = mountedProject.logPath
const CHILD_RUN_SCRIPT      = mountedProject.runScript
const CHILD_PLAY_ROUTE      = `/${mountedProject.name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`

if (fs.existsSync(join(CHILD_DIR, 'index.html'))) {
  app.use(CHILD_PLAY_ROUTE, generatedAppSecurityHeaders, express.static(CHILD_DIR))
  mountedPlayRoutes.add(CHILD_PLAY_ROUTE)
}

let activeChildRun = null
const childRunClients = new Set()
const incubatorRunClients = new Set()

function startChildRun(options = {}) {
  if (!fs.existsSync(CHILD_RUN_SCRIPT)) return null
  const existing = globalRunBusy()
  if (existing) return null
  const lock = acquireRunLock({ kind: 'child', id: mountedProject.name, runner: 'script' })
  if (!lock.ok) return null
  const child = spawnTrackedRun({
    script: CHILD_RUN_SCRIPT,
    captureName: `child-${mountedProject.name}`,
    runLogPath: CHILD_LOG_PATH,
    nextRunNum: () => {
      try { return (JSON.parse(fs.readFileSync(CHILD_LAB_STATUS_PATH, 'utf8')).runCount ?? 0) + 1 } catch { return 1 }
    },
    env: options.scheduled ? { PI_PULSE_SCHEDULED_RUN: '1' } : {},
    lock,
  })
  activeChildRun = { pid: child.pid, startTime: Date.now() }
  return child
}

// ─── Multi incubator slots ────────────────────────────────────────────────────

const INCUBATORS_PATH = process.env.PI_PULSE_INCUBATORS_PATH || join(PROJECTS_DIR, 'incubators.json')
const activeIncubatorRuns = new Map()

function defaultIncubators() {
  return {
    slots: [
      {
        id: 'rat-deposit',
        type: 'project',
        statusPath: '/home/admin/lab/projects/rat-deposit/status.json',
        enabled: false,
        intervalHours: 0.5,
        nextRunAt: Date.now() + 30 * 60 * 1000,
        lastScheduledRun: null,
        autoRunsSinceHuman: 0,
        charges: null,
      },
    ],
  }
}

function readIncubators() {
  try {
    const data = JSON.parse(fs.readFileSync(INCUBATORS_PATH, 'utf8'))
    if (Array.isArray(data.slots)) return reconcileIncubatorScheduleState(data)
  } catch {}
  const data = reconcileIncubatorScheduleState(defaultIncubators())
  writeIncubators(data)
  return data
}

function writeIncubators(data) {
  try { writeJsonAtomic(INCUBATORS_PATH, data) } catch {}
}

function pauseIncubatorSchedule(slot, reason, code) {
  const ts = new Date().toISOString()
  slot.enabled = false
  slot.nextRunAt = null
  slot.schedulePausedAt = ts
  slot.schedulePauseReason = reason
  slot.lastScheduleBlockedAt = ts
  slot.lastScheduleBlockedReason = reason
  slot.lastScheduleBlockedCode = code
}

function reconcileIncubatorScheduleState(data) {
  let changed = false
  const now = Date.now()
  for (const slot of data.slots || []) {
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
    if (slot.enabled && (!slot.nextRunAt || Number(slot.nextRunAt) < now)) {
      slot.nextRunAt = now + slot.intervalHours * 60 * 60 * 1000
      slot.lastScheduleBlockedAt = new Date().toISOString()
      slot.lastScheduleBlockedReason = 'stale schedule reconciled from service startup/read'
      slot.lastScheduleBlockedCode = 'STALE_SCHEDULE_RECONCILED'
      changed = true
    }
  }
  if (changed) writeIncubators(data)
  return data
}

function readStatusAt(statusPath) {
  const safeStatusPath = assertTrustedStatusPath(statusPath)
  return JSON.parse(fs.readFileSync(safeStatusPath, 'utf8'))
}


function incubatorFailureFuseDecision(slot) {
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

function applyIncubatorFailureFuse(slot, decision) {
  const ts = new Date().toISOString()
  slot.enabled = false
  slot.nextRunAt = null
  slot.schedulePausedAt = ts
  slot.schedulePauseReason = decision.reason
  slot.lastScheduleBlockedAt = ts
  slot.lastScheduleBlockedReason = decision.reason
  slot.lastScheduleBlockedCode = decision.code
}

function incubatorAutoStrategyDecision(slot) {
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

function applyIncubatorAutoStrategy(slot, decision) {
  const ts = new Date().toISOString()
  slot.lastAutonomyInterventionAt = ts
  slot.lastAutonomyInterventionReason = decision.reason
  slot.lastAutonomyInterventionCode = decision.code
}

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

function claudeRunnerSetupForStatus(cfg) {
  const expectedScript = expectedClaudeRunScriptForProject(cfg.project, cfg)
  const model = firstRunnableClaudeModel(
    cfg.claudeModel,
    process.env.CLAUDE_MODEL,
    process.env.DEFAULT_CLAUDE_MODEL,
    DEFAULT_CLAUDE_MODEL,
    SAFE_CLAUDE_MODEL
  )
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
    checks,
    error: ok ? null : checks.find(check => !check.ok)?.detail || 'Claude runner setup failed',
  }
}

function hydrateIncubator(slot) {
  const { status: cfg, repaired } = repairClaudeRunnerStatusIfNeeded(slot.statusPath)
  const repoStatusPath = join(cfg.repo, 'status.json')
  let repoStatus = {}
  try { repoStatus = JSON.parse(fs.readFileSync(repoStatusPath, 'utf8')) } catch {}
  const running = getIncubatorRun(slot.id)
  const playRoute = fs.existsSync(join(cfg.repo, 'index.html')) ? mountPlayRoute(cfg) : null
  const claudeSetup = claudeRunnerSetupForStatus(cfg)
  const claudeRelayScript = claudeSetup.script || claudeSetup.expectedScript || cfg.claudeRunScript || null
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

function getIncubatorRun(id) {
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

function shellQuote(value) {
  const raw = String(value ?? '')
  if (!raw) return "''"
  return /^[A-Za-z0-9_./:=+-]+$/.test(raw) ? raw : `'${raw.replace(/'/g, `'\\''`)}'`
}

function incubatorRunArgs(cfg, statusPath, runType = null) {
  const args = []
  if (
    cfg.runScript === cfg.launcher ||
    cfg.runner === 'codex' ||
    cfg.runScript?.includes('run-codex-incubator.sh')
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

function startIncubatorRun(slot, runType = null, options = {}) {
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
    cwd: cfg.repo || '/home/admin/lab',
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

function updateProjectRunner(statusPath, runner) {
  const normalized = normalizeIncubatorStatus(statusPath)
  const status = normalized.status
  if (runner === 'codex') {
    status.runner = 'codex'
    status.runScript = runnableLauncherForStatus(status) || '/home/admin/lab/scripts/run-codex-incubator.sh'
    status.promptDir = status.promptDir || join(status.repo, 'prompts')
    status.runTypes = status.runTypes || ['mutate', 'research', 'mutate']
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
    status.runTypes = status.runTypes || ['mutate', 'research', 'mutate']
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

function repairClaudeRunnerStatusIfNeeded(statusPath) {
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
    next.runTypes = ['mutate', 'research', 'mutate']
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

function slugifyProjectName(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
  return slug || 'incubator-' + new Date().toISOString().slice(0, 10)
}

const INCUBATOR_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'be', 'build', 'can', 'create', 'demo', 'for',
  'from', 'give', 'ha', 'i', 'in', 'install', 'it', 'make', 'me', 'my', 'of', 'one',
  'please', 'show', 'showcase', 'small', 'that', 'the', 'this', 'to', 'tool', 'u', 'use',
  'using', 'want', 'with', 'would',
])

function titleCaseWords(words) {
  return words
    .filter(Boolean)
    .map(word => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ')
}

function normalizedIncubatorTitle(value) {
  const words = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
  return words.length ? titleCaseWords(words) : null
}

function explicitIncubatorTitle(text) {
  const match = String(text || '').match(/\b(?:called|named|title(?:d)?|name it|kalla den|som heter)\s+["']?([a-z0-9][a-z0-9 _-]{1,48})/i)
  if (!match) return null
  return match[1].replace(/["'.:;!?].*$/, '').trim()
}

function suggestedIncubatorTitle(idea) {
  const text = String(idea || '').trim()
  const explicit = normalizedIncubatorTitle(explicitIncubatorTitle(text))
  if (explicit) return explicit

  const lower = text.toLowerCase()
  if (/\btaste\b|\bpreference\b|\bpicker\b/.test(lower)) return 'Taste Trainer'
  if (/\bpi[-\s]?pulse\b/.test(lower) && (/\breport\b|\binvestigat|\baudit\b/.test(lower))) return 'Pulse Audit'
  if (/\blauncher\b/.test(lower) && /\b(tv|android|nvidia|shield)\b/.test(lower)) return 'Shield Launcher'
  if (/\bcamera\b/.test(lower) && /\bwindow\b/.test(lower)) return 'Window Camera'
  if (/\bpoem\b|\bpoetry\b|\bdikt\b/.test(lower)) return 'Poem Machine'
  if (/\bartifact\b/.test(lower) && (/\binteractive\b|\bdigital\b/.test(lower))) return 'Interactive Artifact'

  const words = lower
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(?:i want to|i would like to|can you|could you|please|jag skulle vilja|kan du)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !INCUBATOR_TITLE_STOP_WORDS.has(word))

  const typeWord = words.find(word => ['game', 'launcher', 'report', 'audit', 'trainer', 'camera', 'dashboard', 'tracker', 'editor', 'generator', 'simulator'].includes(word))
  const subjectWords = words.filter(word => word !== typeWord).slice(0, typeWord ? 2 : 3)
  const titleWords = typeWord ? [...subjectWords, typeWord] : subjectWords
  return titleCaseWords(titleWords.length ? titleWords : ['New', 'Incubator'])
}

function inferIncubatorRole(value = {}) {
  const text = [
    value.id,
    value.project,
    value.displayName,
    value.incubatorTitle,
    value.phase,
    value.current_focus,
    value.notes,
  ].filter(Boolean).join(' ').toLowerCase()
  if (/\btaste\b|\bpreference\b|\bpicker\b|\btrain\b/.test(text)) return 'signal-feeder'
  if (/\baudit\b|\breport\b|\binvestigat/.test(text) && /\bpi[-\s]?pulse\b|\bincubator\b/.test(text)) return 'signal-feeder'
  if (/\bimpossible\b|\bbullshit\b|\bbenchmark\b|\bhard evidence\b|\bcompletion rate\b|\bcrashes\b|\bruntime\b|\bscheduler\b|\bpacking\b|\branking\b|\banomaly\b|\bcompression\b|\bocr\b|\bdatabase\b|\bquery engine\b/.test(text)) return 'signal-feeder'
  return 'product'
}

function incubatorRoleLabel(role = 'product') {
  return role === 'signal-feeder' ? 'Signal Incubator' : 'Project Incubator'
}

function uniqueIncubatorSlug(seed) {
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

function projectFeedbackPath(cfg) {
  const fallback = join(cfg.repo || '/home/admin/lab', 'reports', 'USER_FEEDBACK.md')
  return pathInside(cfg.feedbackPath, cfg.repo || '') ? cfg.feedbackPath : fallback
}

function readLatestProjectFeedback(filePath, maxChars = 900) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim()
    if (!text) return null
    return text.slice(-maxChars)
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

function incubatorQualityInstructions(seedIdea = '', incubatorRole = 'product') {
  const seed = seedIdea ? `
Seed idea:
${seedIdea}
` : ''
  const signalFeeder = incubatorRole === 'signal-feeder'
  const roleBlock = signalFeeder ? `
Incubator role: signal feeder for Pi Pulse.
- Treat the app as an instrument that should produce reusable learning for future incubators, not only as a standalone product.
- Keep the user-facing workflow small enough to generate clear signal.
- Prefer measurable outcomes, before/after comparisons, preference labels, or failure patterns over vague impressions.
- Every run must add these extra fields to reports/RUN_LOG.md when there is a lesson:
**Pi Pulse lesson:** [one portable lesson future incubators should reuse]
**Learning evidence:** [metric, user observation, screenshot, test, or app-evidence result]
**Applies to future apps:** yes/no - [scope]
` : `
Incubator role: product app.
- Optimize for a real user's first-screen clarity, main workflow, and durable product quality.
`
  return `${seed}${roleBlock}
Quality contract:
- Read reports/USER_FEEDBACK.md if present and convert the latest note into one acceptance check.
- Treat runner success as process health only; product quality needs its own gate.
- Verify with command/test output, file inspection, screenshot/browser/manual UI check, or an explicit not-applicable reason.
- For static, React, or web app projects, PASS requires app runtime evidence under reports/evidence/run-[number]/ or a clear not-applicable reason for non-UI work.
- For 4.5+ UI quality, register window.__PI_PULSE_APP__ with a visible primaryAction.selector, a machine-checkable expect success contract, and preferably reset/snapshot hooks.
- If app evidence is missing, blank, degraded, lacks a semantic success contract, or has runtime errors, write NEEDS-EVIDENCE or FAIL instead of PASS.
- If evidence is thin, write NEEDS-EVIDENCE. If steering is missed or the app/main flow breaks, write FAIL.
- Do not make manual/human validation the required next move unless the user explicitly asked for it. If a human-feel question remains, create a better automated proxy, A/B receipt, screenshot proof, replay, benchmark slice, or semantic contract in the next autonomous run.
- Research runs must infer a defensible north star themselves from the current artifact, prior steering, market/common product taste, and evidence. Do not ask the user to define the north star; state it, explain the tradeoff, and choose the next measurable bet.
- Every run must declare first-class strategy fields: North star, Strategy, Why this run type, Expected quality delta, Actual quality delta, and Plateau/regression verdict. These fields drive future loop policy, so do not bury them in prose.
- Negative feedback triggers recovery mode: if the latest user note says the app is ugly, confusing, broken, crashed, insufficient, degraded, not working, or worse than an existing alternative, do not add features. Fix the smallest user-visible failure in the first screen or main workflow, simplify/delete weak material, and do not write PASS unless the complaint path is verified.

Append these fields to reports/RUN_LOG.md every run:
**North star:** [the strongest inferred product/benchmark/taste target for this project]
**Strategy:** [one sentence: what this run is trying to prove or improve]
**Why this run type:** [why CREATE/MUTATE/RESEARCH/HARVEST is the right move now]
**Expected quality delta:** [what should improve, with metric/observable if possible]
**Actual quality delta:** [what actually moved, or "none measured"]
**Plateau/regression verdict:** IMPROVED | PLATEAU | REGRESSION | UNCLEAR - [short reason]
**Recovery mode:** yes/no - [complaint addressed, or "not triggered"]
**Acceptance check:** [one concrete criterion]
**Evidence:** [commands, files, screenshots/manual checks, or explicit not-applicable reason]
**App evidence:** [reports/evidence/run-[number]/summary.md, or not applicable]
**Quality gate:** PASS | NEEDS-EVIDENCE | FAIL
**Quality rating:** [0-5]/5
**Evidence confidence:** [0-5]/5
**Risk / regression:** [what got worse, is unverified, or could break]
**Next move:** [one small follow-up]
`
}

function promptForIncubatorRunType(project, runType, seedIdea = '', incubatorRole = 'product') {
  const normalized = String(runType || 'mutate').toLowerCase()
  const quality = incubatorQualityInstructions(seedIdea, incubatorRole)
  if (normalized === 'create') {
    return `Create the first tiny local prototype for ${project}.

Rules:
- Build the smallest usable version first.
- Keep it local and simple.
- Prefer plain files and clear state over backend complexity unless the idea truly needs it.
- Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
  }
  if (normalized === 'research') {
    return `Research the next best move for ${project}.

Use the repo, reports/RUN_LOG.md, reports/RECENT_RUNS.md, and reports/USER_FEEDBACK.md if present. Identify what is unclear, what should be tested next, and what would make the project more useful. Do not modify source files. Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
  }
  return `Improve ${project} by one focused step.

Before changing anything, read reports/USER_FEEDBACK.md if it exists and treat the latest notes as steering input.

Choose one useful mutation that makes the project more real, testable, or personally aligned. Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
}

function safeRunTypeName(runType) {
  return String(runType || 'mutate').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mutate'
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
  const content = `#!/usr/bin/env bash
set -euo pipefail

STATUS_PATH="\${1:-${statusPath}}"
RUN_TYPE="\${2:-}"
RUNNER=$(node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(o.runner || 'codex')" "$STATUS_PATH")

if [ "$RUNNER" = "claude" ]; then
  exec ${GENERIC_CLAUDE_INCUBATOR_SCRIPT} "$STATUS_PATH" "$RUN_TYPE"
fi

exec /home/admin/lab/scripts/run-codex-incubator.sh "$STATUS_PATH" "$RUN_TYPE"
`
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

function normalizeIncubatorStatus(statusPath) {
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
    next.runTypes = ['mutate', 'research', 'mutate']
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
    '/home/admin/lab/scripts/run-codex-incubator.sh',
    GENERIC_CLAUDE_INCUBATOR_SCRIPT,
  ])
  const allowedRunScriptRoots = [PROJECTS_DIR, join(LAB_ROOT, 'scripts'), join(__dirname, 'scripts')]
  if (!next.runScript || genericEntrypoints.has(next.runScript) || !pathInsideAny(next.runScript, allowedRunScriptRoots)) {
    next.runScript = next.launcher
    changed = true
  }

  ensureIncubatorProjectScaffold(next)

  if (changed) writeJsonAtomic(safeStatusPath, next)
  return { status: next, repaired: changed }
}

function createIncubatorProjectFromIdea(idea, requestedTitle = '') {
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
    runScript: '/home/admin/lab/scripts/run-codex-incubator.sh',
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
function notifyIncubatorClients() {
  for (const client of incubatorRunClients) {
    try { client.write('data: update\n\n') } catch { incubatorRunClients.delete(client) }
  }
}

function mountPlayRoute(cfg) {
  const route = `/${cfg.project.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
  if (mountedPlayRoutes.has(route)) return route
  if (!fs.existsSync(join(cfg.repo, 'index.html'))) return null
  app.use(route, generatedAppSecurityHeaders, express.static(cfg.repo))
  mountedPlayRoutes.add(route)
  return route
}

for (const slot of readIncubators().slots) {
  try {
    mountPlayRoute(readStatusAt(slot.statusPath))
  } catch { /* skip malformed incubator slots */ }
}

function incubatorPlayFileForRequest(requestPath) {
  const match = String(requestPath || '').match(/^\/([a-z0-9_-]+)(?:\/(.*))?$/i)
  if (!match) return null
  const slug = match[1].toLowerCase()
  const requestFile = match[2] && match[2] !== '' ? match[2] : 'index.html'

  for (const slot of readIncubators().slots) {
    try {
      const cfg = readStatusAt(slot.statusPath)
      const routeSlug = cfg.project.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
      if (routeSlug !== slug || !fs.existsSync(join(cfg.repo, 'index.html'))) continue

      const repoRoot = resolve(cfg.repo)
      const candidate = resolve(repoRoot, requestFile)
      if (candidate !== repoRoot && !candidate.startsWith(repoRoot + '/')) return null

      const stat = fs.statSync(candidate)
      if (stat.isDirectory()) {
        const indexPath = join(candidate, 'index.html')
        return fs.existsSync(indexPath) ? indexPath : null
      }
      return stat.isFile() ? candidate : null
    } catch {
      // Keep scanning other slots; malformed slot state should not break SPA fallback.
    }
  }
  return null
}

// ─── Incubator auto-schedule ───────────────────────────────────────────────────

const SCHEDULE_PATH = process.env.PI_PULSE_CHILD_SCHEDULE_PATH || join(PROJECTS_DIR, 'schedule.json')
let scheduleState = { enabled: false, intervalHours: 2, nextRunAt: null, lastScheduledRun: null, autoRunsSinceHuman: 0 }

try {
  const raw = fs.readFileSync(SCHEDULE_PATH, 'utf8')
  const loaded = JSON.parse(raw)
  scheduleState = { ...scheduleState, ...loaded }
  scheduleState.intervalHours = clampScheduleInterval(scheduleState.intervalHours, 2)
  // If nextRunAt is in the past after a restart, reschedule from now
  if (scheduleState.enabled && scheduleState.nextRunAt && scheduleState.nextRunAt < Date.now()) {
    scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
  }
} catch { /* no schedule file yet — defaults apply */ }

function saveSchedule() {
  try { fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleState, null, 2)) } catch {}
}

// Check every 60s — fire the mounted project's run script if the schedule is due
if (SCHEDULES_ENABLED) {
  setInterval(() => {
    if (!scheduleState.enabled || !scheduleState.nextRunAt) return
    if (Date.now() < scheduleState.nextRunAt) return
    if (activeChildRun) {
      try { process.kill(activeChildRun.pid, 0); return } catch { activeChildRun = null }
    }
    if (globalRunBusy()) return
    if (!startChildRun({ scheduled: true })) return
    console.log('[pi-pulse] schedule: firing child run')
    scheduleState.lastScheduledRun = new Date().toISOString()
    scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
    scheduleState.autoRunsSinceHuman = (scheduleState.autoRunsSinceHuman || 0) + 1
    saveSchedule()
  }, 60 * 1000)
}

app.get('/api/child/config', (req, res) => {
  res.json({
    project: mountedProject.name,
    dir: mountedProject.dir,
    playUrl: fs.existsSync(join(CHILD_DIR, 'index.html')) ? `${CHILD_PLAY_ROUTE}/` : null,
  })
})

function parseChildRuns(content, filePath = null) {
  return filePath ? parsedRunsForLog(filePath) : parseRunsFromLog(content)
}

// Multi-project incubators. The legacy /api/child/* endpoints below continue
// to represent the mounted project, while these endpoints drive the slot deck.
app.get('/api/incubators', (req, res) => {
  const data = readIncubators()
  const slots = data.slots.map(slot => {
    try { return hydrateIncubator(slot) } catch { return { ...slot, error: 'invalid slot' } }
  })
  res.json({ ok: true, slots })
})

app.get('/api/incubators/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  incubatorRunClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)
  req.on('close', () => { incubatorRunClients.delete(res); clearInterval(heartbeat) })
})

app.get('/api/incubators/:id/runs', (req, res) => {
  const slot = readIncubators().slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    const { status: cfg } = normalizeIncubatorStatus(slot.statusPath)
    const runs = parseChildRuns('', cfg.runLog)
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
  slot.lastScheduleBlockedAt = null
  slot.lastScheduleBlockedReason = null
  slot.lastScheduleBlockedCode = null
  slot.schedulePausedAt = null
  slot.schedulePauseReason = null
  slot.lastAutonomyInterventionAt = null
  slot.lastAutonomyInterventionReason = null
  slot.lastAutonomyInterventionCode = null
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, ...result })
})

app.post('/api/incubators/:id/schedule', requireFreshSource, (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const { enabled, intervalHours, runner } = req.body ?? {}
  if (typeof enabled === 'boolean') slot.enabled = enabled
  if (intervalHours != null) slot.intervalHours = clampScheduleInterval(intervalHours, slot.intervalHours || 0.5)
  if (typeof runner === 'string') slot.runner = runner
  if (slot.enabled) {
    if (!slot.nextRunAt || slot.nextRunAt < Date.now()) {
      slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
    }
    slot.lastScheduleBlockedAt = null
    slot.lastScheduleBlockedReason = null
    slot.lastScheduleBlockedCode = null
    slot.schedulePausedAt = null
    slot.schedulePauseReason = null
    slot.lastAutonomyInterventionAt = null
    slot.lastAutonomyInterventionReason = null
    slot.lastAutonomyInterventionCode = null
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
  slot.runner = runner
  writeIncubators(data)
  notifyIncubatorClients()
  const preflight = preflightIncubatorRun(slot)
  const launchBlocked = runner === 'claude' && preflight && !preflight.ok
  let historyRecorded = false
  if (launchBlocked) {
    appendRunnerSwitchPreflightFailure({
      slot,
      runLogPath: result.status?.runLog,
      preflight,
    })
    historyRecorded = true
    notifyIncubatorClients()
  }
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
    historyRecorded,
  })
})

app.post('/api/incubators/create', requireFreshSource, (req, res) => {
  const result = createIncubatorProjectFromIdea(req.body?.idea, req.body?.title)
  if (!result.ok) return res.status(result.status || 400).json(result)
  const data = readIncubators()
  const slot = {
    id: result.slug,
    type: 'project',
    statusPath: result.statusPath,
    enabled: false,
    intervalHours: clampScheduleInterval(0.5),
    nextRunAt: null,
    lastScheduledRun: null,
    autoRunsSinceHuman: 0,
    charges: null,
  }
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
    const stamp = new Date().toISOString()
    fs.mkdirSync(dirname(filePath), { recursive: true })
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '# User Feedback / Steering Notes\n\nThese notes are written from the Pi Pulse UI and injected into future incubator runs.\n')
    }
    fs.appendFileSync(filePath, `\n## ${stamp}\n\n${feedback}\n`)
    if (cfg.runLog) {
      fs.mkdirSync(dirname(cfg.runLog), { recursive: true })
      fs.appendFileSync(cfg.runLog, `\n## User Feedback - ${stamp}\n\n**Steering:** ${feedback}\n`)
    }
    cfg.feedbackPath = filePath
    cfg.latestUserFeedback = feedback.slice(0, 2000)
    cfg.feedbackUpdatedAt = stamp
    cfg.next_run_goal = `Use latest user feedback: ${feedback.slice(0, 180)}`
    slot.autoRunsSinceHuman = 0
    slot.lastScheduleBlockedAt = null
    slot.lastScheduleBlockedReason = null
    slot.lastScheduleBlockedCode = null
    slot.schedulePausedAt = null
    slot.schedulePauseReason = null
    slot.lastAutonomyInterventionAt = null
    slot.lastAutonomyInterventionReason = null
    slot.lastAutonomyInterventionCode = null
    if (slot.enabled && (!slot.nextRunAt || slot.nextRunAt < Date.now())) {
      slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
    }
    writeJsonAtomic(slot.statusPath, cfg)
    writeIncubators(data)
    notifyIncubatorClients()
    res.json({ ok: true, slot: hydrateIncubator(slot) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
app.post('/api/incubators', requireFreshSource, (req, res) => {
  const { project, intervalHours = 0.5, enabled = false } = req.body ?? {}
  if (!project || typeof project !== 'string' || project.includes('..') || project === 'pi-pulse') {
    return res.status(400).json({ ok: false, error: 'invalid project' })
  }
  const statusPath = join(PROJECTS_DIR, project, 'status.json')
  if (!fs.existsSync(statusPath)) return res.status(404).json({ ok: false, error: 'project status not found' })
  const data = readIncubators()
  if (data.slots.some(s => s.id === project)) return res.status(409).json({ ok: false, error: 'incubator already exists' })
  const slot = {
    id: project,
    type: 'project',
    statusPath,
    enabled: !!enabled,
    intervalHours: clampScheduleInterval(intervalHours),
    nextRunAt: enabled ? Date.now() + clampScheduleInterval(intervalHours) * 60 * 60 * 1000 : null,
    lastScheduledRun: null,
    autoRunsSinceHuman: 0,
    charges: null,
  }
  data.slots.push(slot)
  writeIncubators(data)
  // Mount the play route now — previously the response claimed `restarting: true`
  // but never restarted, so a fresh slot's playUrl served the pi-pulse SPA.
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
  const running = activeIncubatorRuns.get(req.params.id)
  let stoppedPid = null
  if (running?.pid && Number(running.pid) > 1) {
    stoppedPid = running.pid
    try { process.kill(-running.pid, 'SIGTERM') } catch {
      try { process.kill(running.pid, 'SIGTERM') } catch {}
    }
  }
  activeIncubatorRuns.delete(req.params.id)
  notifyIncubatorClients()
  res.json({ ok: true, removed: req.params.id, stoppedPid })
})

if (SCHEDULES_ENABLED) {
  setInterval(() => {
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
          slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
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
        slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
        changed = true
        continue
      }
      console.log(`[pi-pulse] incubator: firing ${slot.id}`)
      slot.lastScheduledRun = new Date().toISOString()
      slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
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
  }, 60 * 1000)
}

app.get('/api/child/status', (req, res) => {
  let projectStatus = {}
  if (CHILD_STATUS_PATH) {
    try { projectStatus = JSON.parse(fs.readFileSync(CHILD_STATUS_PATH, 'utf8')) } catch {}
  }
  let labStatus = {}
  try { labStatus = JSON.parse(fs.readFileSync(CHILD_LAB_STATUS_PATH, 'utf8')) } catch {}
  res.json({ project: mountedProject.name, runCount: 0, ...projectStatus, ...labStatus })
})

app.get('/api/child/runs', (req, res) => {
  try {
    const content = fs.readFileSync(CHILD_LOG_PATH, 'utf8')
    res.json(runsWithPinnedLatestFailure(parseChildRuns(content), 10))
  } catch {
    res.json([])
  }
})

app.post('/api/child/run', requireFreshSource, (req, res) => {
  const busy = globalRunBusy()
  if (busy) return res.status(409).json({ ok: false, code: 'GLOBAL_RUN_LOCK_ACTIVE', error: 'another run is already active', owner: busy })
  const child = startChildRun()
  if (!child) {
    return res.status(404).json({ ok: false, error: 'run script not found' })
  }
  scheduleState.autoRunsSinceHuman = 0
  saveSchedule()
  res.json({ ok: true, pid: child.pid })
})

app.get('/api/child/run/status', (req, res) => {
  if (!activeChildRun) return res.json({ running: false, pid: null, elapsed: 0, startTime: null })
  let alive = false
  try { process.kill(activeChildRun.pid, 0); alive = true } catch {}
  const elapsed = Math.floor((Date.now() - activeChildRun.startTime) / 1000)
  const startTime = activeChildRun.startTime
  if (!alive) { activeChildRun = null; return res.json({ running: false, pid: null, elapsed, startTime }) }
  res.json({ running: true, pid: activeChildRun.pid, elapsed, startTime })
})

app.get('/api/child/schedule', (req, res) => {
  res.json({ ok: true, ...scheduleState })
})

app.post('/api/child/schedule', requireFreshSource, (req, res) => {
  const { enabled, intervalHours } = req.body ?? {}
  if (typeof enabled === 'boolean') scheduleState.enabled = enabled
  if (intervalHours != null) scheduleState.intervalHours = clampScheduleInterval(intervalHours, scheduleState.intervalHours)
  if (scheduleState.enabled) {
    if (!scheduleState.nextRunAt || scheduleState.nextRunAt < Date.now()) {
      scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
    }
  } else {
    scheduleState.nextRunAt = null
  }
  scheduleState.autoRunsSinceHuman = 0
  saveSchedule()
  res.json({ ok: true, ...scheduleState })
})

app.get('/api/child/runs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  childRunClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)
  req.on('close', () => { childRunClients.delete(res); clearInterval(heartbeat) })
})

// Watch the parent directory, not the file: a file watch silently dies when a
// tool replaces the file via rename (new inode), and never fires if the log
// doesn't exist yet. Directory watch survives both.
try {
  const childLogName = CHILD_LOG_PATH.split('/').pop()
  fs.watch(dirname(CHILD_LOG_PATH), { persistent: false }, (eventType, filename) => {
    if (filename && filename !== childLogName) return
    for (const client of childRunClients) {
      try { client.write('data: update\n\n') } catch { childRunClients.delete(client) }
    }
  })
} catch { /* parent dir may not exist yet */ }

// AI analysis for mounted child project
const CHILD_FEEDBACK_JSON = join(CHILD_DIR, 'memory', 'DRIFT_FEEDBACK.json')
const CHILD_FEEDBACK_MD   = join(CHILD_DIR, 'memory', 'DRIFT_FEEDBACK.md')

app.post('/api/child/ai/analyze', requireFreshSource, async (req, res) => {
  if (!LOCAL_LLM_ENABLED) return res.status(503).json(localLlmDisabledPayload('child'))
  try {
    // Use MemPalace semantic search for compact context
    const palaceCtx = await queryMemPalace(`${mountedProject.name} seed direction active threads`, { wing: 'lab', results: 3, maxChars: 600 })
    let recentLog = ''
    try { recentLog = fs.readFileSync(CHILD_LOG_PATH, 'utf8').slice(-400) } catch {}

    const prompt = `You are an AI critic analyzing an evolving software project.

CONTEXT (from memory palace):
${palaceCtx || '(unavailable)'}

RECENT RUN LOG (tail):
${recentLog}

Respond in this exact format (5 lines, no extra text):
DIRECTION: <one sentence on where the project is heading>
STRONGEST: <what is working best right now>
WEAKEST: <what is hurting the project most>
DRIFT: <yes/no — is it drifting from the seed? why>
NEXT: <the single most useful next action>`

    const r = await fetch(`${HAILO_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok) return res.status(502).json({ ok: false, error: await r.text() })

    const data = await r.json()
    const payload = aiFeedbackPayload({
      response: data.response,
      model: AI_MODEL,
      incubatorId: mountedProject.name,
      project: mountedProject.name,
    })
    try {
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
      fs.mkdirSync(dirname(CHILD_FEEDBACK_JSON), { recursive: true })
      fs.writeFileSync(CHILD_FEEDBACK_MD, `# Local Ollama/Qwen Feedback - ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync(CHILD_FEEDBACK_JSON, JSON.stringify(payload, null, 2) + '\n')
    } catch { /* non-fatal */ }

    res.json(payload)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/child/ai/latest', (req, res) => {
  try {
    res.json(readCachedAiFeedback({
      id: mountedProject.name,
      project: mountedProject.name,
      paths: { json: CHILD_FEEDBACK_JSON, md: CHILD_FEEDBACK_MD },
    }))
  } catch {
    res.json({ ok: false })
  }
})


app.get('/api/child/ai/status', async (req, res) => {
  if (!LOCAL_LLM_ENABLED) return res.json(localLlmStatusPayload())
  try {
    const r = await fetch(`${HAILO_URL}/api/tags`)
    const data = await r.json()
    const loaded = data.models?.some(m => m.name?.includes('qwen2.5-instruct'))
    res.json({ available: true, modelLoaded: loaded, models: data.models })
  } catch {
    res.json({ available: false, modelLoaded: false })
  }
})

function feedbackPathsForIncubator(cfg) {
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

function aiTargetForIncubator(id) {
  if (id === 'core') {
    return {
      id: 'core',
      project: 'pi-pulse',
      runLog: RUN_LOG_PATH,
      paths: feedbackPathsForIncubator({ project: 'pi-pulse' }),
      query: 'pi-pulse incubator host seed direction active threads',
    }
  }

  const slot = readIncubators().slots.find(s => s.id === id)
  if (!slot) return null
  let cfg
  try { cfg = readStatusAt(slot.statusPath) } catch { return null }
  return {
    id: slot.id,
    project: cfg.project,
    runLog: cfg.runLog,
    paths: feedbackPathsForIncubator(cfg),
    query: `${cfg.project} seed direction active threads`,
  }
}

function readCachedAiFeedback(target) {
  const data = JSON.parse(fs.readFileSync(target.paths.json, 'utf8'))
  return hydrateAiFeedback(data, target)
}

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
  if (!LOCAL_LLM_ENABLED) return res.status(503).json(localLlmDisabledPayload('incubator'))
  try {
    const palaceCtx = await queryMemPalace(target.query, { wing: 'lab', results: 3, maxChars: 600 })
    let recentLog = ''
    try { recentLog = fs.readFileSync(target.runLog, 'utf8').slice(-400) } catch {}

    const prompt = `You are a local Ollama/Qwen critic analyzing an evolving software incubator.

CONTEXT (from memory palace):
${palaceCtx || '(unavailable)'}

RECENT RUN LOG (tail):
${recentLog}

Respond in this exact format (5 lines, no extra text):
DIRECTION: <one sentence on where the project is heading>
STRONGEST: <what is working best right now>
WEAKEST: <what is hurting the project most>
DRIFT: <yes/no - is it drifting from the seed? why>
NEXT: <the single most useful next action>`

    const r = await fetch(`${HAILO_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok) return res.status(502).json({ ok: false, error: await r.text() })

    const data = await r.json()
    const payload = aiFeedbackPayload({
      incubatorId: target.id,
      project: target.project,
      response: data.response,
      model: AI_MODEL,
    })
    try {
      fs.mkdirSync(dirname(target.paths.json), { recursive: true })
      const ts = new Date(payload.ts).toISOString().slice(0, 16).replace('T', ' ')
      fs.writeFileSync(target.paths.md, `# Local Ollama/Qwen Feedback - ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync(target.paths.json, JSON.stringify(payload, null, 2) + '\n')
    } catch { /* non-fatal */ }

    res.json(payload)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// AI analysis via local Ollama/Qwen. Disabled by default because CPU fallback
// saturates the Pi; opt in only for deliberate local inference sessions.
const LOCAL_LLM_ENABLED = process.env.PI_PULSE_ENABLE_LOCAL_LLM === '1'
const HAILO_URL = 'http://localhost:11434'
const AI_MODEL = 'qwen2.5-instruct:1.5b'

function localLlmDisabledPayload(scope = 'core') {
  return {
    ok: false,
    available: false,
    disabled: true,
    scope,
    code: 'LOCAL_LLM_DISABLED',
    error: 'Local Ollama/Qwen inference is disabled on this Pi. Set PI_PULSE_ENABLE_LOCAL_LLM=1 to enable it for a deliberate session.',
  }
}

function localLlmStatusPayload() {
  return {
    available: false,
    modelLoaded: false,
    disabled: true,
    models: [],
    code: 'LOCAL_LLM_DISABLED',
  }
}

// MemPalace semantic search — returns relevant context snippets (~100-600 chars)
// instead of dumping raw files into every prompt. Keep it async and argument-array
// based so project text cannot become shell syntax, and so a slow palace query
// does not block the whole Pi Pulse event loop.
function execFileText(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: 'utf8', ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        reject(err)
        return
      }
      resolvePromise(stdout)
    })
  })
}

async function queryMemPalace(query, { wing = '', results = 3, maxChars = 600 } = {}) {
  try {
    const count = Math.max(1, Math.min(10, Number(results) || 3))
    const args = ['search', String(query || ''), '--results', String(count)]
    if (wing) args.push('--wing', String(wing))
    const raw = await execFileText('/home/admin/.local/bin/mempalace', args, {
      timeout: 10000,
      env: { ...process.env, HOME: '/home/admin' },
    })
    // Strip ANSI codes and extract only content lines (skip headers/metadata/separators)
    const clean = raw.replace(/\x1b\[[0-9;]*[mGKH]/g, '')
    const out = []
    let afterMatch = false
    for (const line of clean.split('\n')) {
      const t = line.trim()
      if (/^={5,}/.test(t) || /^-{5,}/.test(t)) { afterMatch = false; continue }
      if (!t || /^Results for:/.test(t)) continue
      if (/^\[\d+\]\s+\w/.test(t) || /^Source:/.test(t)) { afterMatch = false; continue }
      if (/^Match:/.test(t)) { afterMatch = true; continue }
      if (afterMatch) out.push(line)
    }
    return out.join('\n').trim().slice(0, maxChars)
  } catch (err) {
    return `[memory unavailable: ${String(err.message || err).slice(0, 160)}]`
  }
}

app.get('/api/ai/status', async (req, res) => {
  if (!LOCAL_LLM_ENABLED) return res.json(localLlmStatusPayload())
  try {
    const r = await fetch(`${HAILO_URL}/api/tags`)
    const data = await r.json()
    const loaded = data.models?.some(m => m.name?.includes('qwen2.5-instruct'))
    res.json({ available: true, modelLoaded: loaded, models: data.models })
  } catch {
    res.json({ available: false, modelLoaded: false })
  }
})

app.post('/api/ai/analyze', requireFreshSource, async (req, res) => {
  if (!LOCAL_LLM_ENABLED) return res.status(503).json(localLlmDisabledPayload('core'))
  try {
    // Use MemPalace semantic search for compact context instead of raw file dumps
    const palaceCtx = await queryMemPalace('pi-pulse seed direction current state active threads', { wing: 'lab', results: 3, maxChars: 600 })
    let recentLog = ''
    try { recentLog = fs.readFileSync(RUN_LOG_PATH, 'utf8').slice(-400) } catch {}

    const prompt = `You are an AI critic analyzing an evolving creative/design project.

CONTEXT (from memory palace):
${palaceCtx || '(unavailable)'}

RECENT RUN LOG (tail):
${recentLog}

Respond in this exact format (5 lines, no extra text):
DIRECTION: <one sentence on where the project is heading>
STRONGEST: <what is working best right now>
WEAKEST: <what is hurting coherence most>
DRIFT: <yes/no — is it drifting from the seed? why>
NEXT: <the single most useful next mutation>`

    const r = await fetch(`${HAILO_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    })

    if (!r.ok) {
      const text = await r.text()
      return res.status(502).json({ ok: false, error: text })
    }

    const data = await r.json()
    const payload = aiFeedbackPayload({
      response: data.response,
      model: AI_MODEL,
    })

    // Write parsed feedback to DRIFT_FEEDBACK.md so the lab agent reads it next run
    try {
      const ts = new Date(payload.ts).toISOString().slice(0, 16).replace('T', ' ')
      fs.writeFileSync(CORE_FEEDBACK_MD,
        `# Drift Feedback — ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync(CORE_FEEDBACK_JSON,
        JSON.stringify(payload, null, 2) + '\n')
    } catch { /* non-fatal */ }

    res.json(payload)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
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

// Day history — 24h rolling buffer of 5-min system snapshots
app.get('/api/history/day', (req, res) => {
  res.json({ ok: true, entries: dayBuffer })
})

// Narrator — proxy latest narration so remote browsers don't need localhost:3031
const NARRATIONS_PATH = '/home/admin/lab/src/narrator/narrations.jsonl'

app.get('/api/narration', (req, res) => {
  try {
    const lines = fs.readFileSync(NARRATIONS_PATH, 'utf8').trim().split('\n').filter(Boolean)
    if (!lines.length) return res.json({ ok: false })
    const latest = JSON.parse(lines[lines.length - 1])
    if (latest.text) latest.text = latest.text.split('\n')[0].trim().slice(0, 100)
    res.json({ ok: true, ...latest })
  } catch {
    res.json({ ok: false })
  }
})

// Narrator — all narrations (newest first) for the archive modal
app.get('/api/narrations', (req, res) => {
  try {
    const lines = fs.readFileSync(NARRATIONS_PATH, 'utf8').trim().split('\n').filter(Boolean)
    if (!lines.length) return res.json({ ok: true, entries: [] })
    const entries = lines.map(l => {
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
const GHOST_DIARY_PATH = '/home/admin/lab/src/ghost/diary.jsonl'

app.get('/api/ghost/diary', (req, res) => {
  try {
    if (!fs.existsSync(GHOST_DIARY_PATH)) return res.json({ ok: true, entries: [] })
    const lines = fs.readFileSync(GHOST_DIARY_PATH, 'utf8').trim().split('\n').filter(Boolean)
    if (!lines.length) return res.json({ ok: true, entries: [] })
    const entries = lines.map(l => {
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

// ─── Incubator project management ─────────────────────────────────────────────

// List all available projects (any subdirectory with a status.json)
// pi-pulse is the host/incubator — excluded from its own switcher
app.get('/api/projects/list', (req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'pi-pulse') continue // host — not a mountable project
      const statusPath = join(PROJECTS_DIR, entry.name, 'status.json')
      if (!fs.existsSync(statusPath)) continue
      try {
        const cfg = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
        projects.push({
          name:     cfg.displayName ?? cfg.incubatorTitle ?? cfg.project ?? entry.name,
          dir:      entry.name,
          phase:    cfg.phase ?? null,
          runCount: cfg.runCount ?? 0,
          lastRun:  cfg.lastRun ?? null,
          mounted:  mountedProject.name === (cfg.project ?? entry.name),
        })
      } catch { /* skip malformed status */ }
    }
    res.json({ ok: true, projects })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Switch mounted project — writes mounted.json then restarts via process.exit(0)
// Systemd Restart=on-failure / Restart=always picks it back up in ~1s
app.post('/api/projects/mount', express.json(), requireFreshSource, (req, res) => {
  const { dir } = req.body ?? {}
  if (!dir || typeof dir !== 'string' || dir.includes('..')) {
    return res.status(400).json({ ok: false, error: 'invalid dir' })
  }
  if (dir === 'pi-pulse') {
    return res.status(400).json({ ok: false, error: 'cannot mount the host as a project' })
  }
  const statusPath = join(PROJECTS_DIR, dir, 'status.json')
  if (!fs.existsSync(statusPath)) {
    return res.status(404).json({ ok: false, error: 'project not found' })
  }
  try {
    fs.writeFileSync(
      MOUNTED_CONFIG_PATH,
      JSON.stringify({ project: dir, labStatus: statusPath }, null, 2)
    )
    res.json({ ok: true, dir, restarting: true })
    // Delay so the HTTP response flushes before the process exits
    setTimeout(() => process.exit(0), 500)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Reboot — 1.5s delay so the HTTP response can complete first
app.post('/api/reboot', (req, res) => {
  res.json({ ok: true })
  setTimeout(() => {
    spawn('sudo', ['reboot'], { detached: true, stdio: 'ignore' }).unref()
  }, 1500)
})

// Restart only Pi Pulse so stale-source write gates can be cleared without a full host reboot.
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, restarting: true })
  setTimeout(() => process.exit(0), 500)
})

// SSE — push 'update' to all connected clients whenever RUN_LOG.md changes
const runClients = new Set()
let runLogWatchTimer = null
function notifyRunLogChanged() {
  syncProjectStatus()
  for (const client of runClients) {
    try { client.write('data: update\n\n') } catch { runClients.delete(client) }
  }
}
// Directory watch instead of file watch — survives rename-replace (new inode)
// and a log that doesn't exist yet. Filter to RUN_LOG.md so the rest of the
// lab dir's churn (MEMORY_BRIEF.md, ACTIVE_THREADS.md, ...) doesn't spam clients.
try {
  fs.watch(dirname(RUN_LOG_PATH), { persistent: false }, (eventType, filename) => {
    if (filename && filename !== 'RUN_LOG.md') return
    clearTimeout(runLogWatchTimer)
    runLogWatchTimer = setTimeout(notifyRunLogChanged, 500)
  })
} catch { /* lab dir missing would be fatal elsewhere anyway */ }

app.get('/api/runs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  runClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)
  req.on('close', () => {
    runClients.delete(res)
    clearInterval(heartbeat)
  })
})


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
  const incubatorFile = incubatorPlayFileForRequest(req.path)
  if (incubatorFile) {
    generatedAppSecurityHeaders(req, res, () => {})
    res.sendFile(incubatorFile)
    return
  }

  const indexPath = join(__dirname, 'dist', 'index.html')
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
