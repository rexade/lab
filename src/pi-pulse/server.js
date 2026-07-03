import express from 'express'
import fs from 'fs'
import os from 'os'
import { spawn, execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = 8089
const RUN_LOG_PATH = '/home/admin/lab/RUN_LOG.md'

const AI_FIELD_KEYS = ['DIRECTION', 'STRONGEST', 'WEAKEST', 'DRIFT', 'NEXT']
const AI_FIELD_ALIASES = {
  'NEXT MOVE': 'NEXT',
  'NEXT ACTION': 'NEXT',
  'SUGGESTED NEXT MOVE': 'NEXT',
  'STRONGEST SIGNAL': 'STRONGEST',
  'WEAKEST SIGNAL': 'WEAKEST',
  'WEAKNESS': 'WEAKEST',
}

function parseAiFeedback(text = '') {
  const raw = String(text || '').trim()
  const fields = {}
  const cleaned = raw.replace(/\*\*/g, '').replace(/\r/g, '')
  const re = /([A-Z]{2,}[A-Z\s]*):\s*\n?([\s\S]*?)(?=\n[A-Z]{2,}[A-Z\s]*:|$)/g
  let m
  while ((m = re.exec(cleaned)) !== null) {
    const label = m[1].trim().toUpperCase()
    const key = AI_FIELD_ALIASES[label] || label
    const value = m[2].trim().replace(/\n+/g, ' ')
    if (value && AI_FIELD_KEYS.includes(key)) fields[key] = value
  }
  const missing = AI_FIELD_KEYS.filter(key => !fields[key])
  return { fields, missing, malformed: !!raw && missing.length > 0 }
}

function aiFeedbackPayload({ response, model, incubatorId = 'core', project = 'pi-pulse', ts = Date.now(), source = 'local-ollama-qwen' }) {
  return {
    ok: true,
    incubatorId,
    project,
    response,
    model,
    source,
    ts,
    ...parseAiFeedback(response),
  }
}

function hydrateAiFeedback(data, target = {}) {
  const response = data.response ?? data.raw ?? ''
  const parsed = parseAiFeedback(response)
  const fields = data.fields && typeof data.fields === 'object' ? data.fields : parsed.fields
  const missing = Array.isArray(data.missing) ? data.missing : AI_FIELD_KEYS.filter(key => !fields[key])
  return {
    ...data,
    response,
    incubatorId: data.incubatorId ?? target.id ?? 'core',
    project: data.project ?? target.project ?? 'pi-pulse',
    source: data.source ?? 'local-ollama-qwen',
    fields,
    missing,
    malformed: typeof data.malformed === 'boolean' ? data.malformed : (!!response && missing.length > 0),
  }
}

// CPU usage calculation (requires two samples)
let prevCpuTimes = null

// Network I/O — requires two samples to compute bytes/sec rate
let prevNetSample = null

// Cached last stats payload — used by pushDaySnapshot to avoid double-sampling
let lastStatsPayload = null

// Active run tracking — cleared after process exits and status is read
let activeRun = null // { pid, startTime }

const LAB_RUNNERS = {
  claude: {
    script: '/home/admin/run-lab.sh',
    args: [],
  },
  codex: {
    script: '/home/admin/lab/scripts/run-codex-incubator.sh',
    args: ['/home/admin/lab/projects/pi-pulse/status.json'],
  },
}
const LAB_SCHEDULE_PATH = '/home/admin/lab/projects/pi-pulse/schedule.json'
let labScheduleState = { enabled: false, intervalHours: 2, runner: 'claude', nextRunAt: null, lastScheduledRun: null, autoRunsSinceHuman: 0 }

try {
  const raw = fs.readFileSync(LAB_SCHEDULE_PATH, 'utf8')
  const loaded = JSON.parse(raw)
  labScheduleState = { ...labScheduleState, ...loaded }
  if (labScheduleState.enabled && labScheduleState.nextRunAt && labScheduleState.nextRunAt < Date.now()) {
    labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
  }
} catch { /* no host lab schedule yet */ }

function saveLabSchedule() {
  try { fs.writeFileSync(LAB_SCHEDULE_PATH, JSON.stringify(labScheduleState, null, 2) + '\n') } catch {}
}

function activeRunAlive() {
  if (!activeRun) return false
  try {
    process.kill(activeRun.pid, 0)
    return true
  } catch {
    activeRun = null
    return false
  }
}

function normalizeLabRunner(runner) {
  return Object.hasOwn(LAB_RUNNERS, runner) ? runner : 'claude'
}

function readinessCheck(id, label, ok, detail, path = null) {
  return { id, label, ok: !!ok, detail, ...(path ? { path } : {}) }
}

function checkPath(id, label, targetPath, kind = 'file') {
  if (!targetPath) return readinessCheck(id, label, false, 'missing path')
  try {
    const st = fs.statSync(targetPath)
    const typeOk = kind === 'dir' ? st.isDirectory() : st.isFile()
    return readinessCheck(id, label, typeOk, typeOk ? 'ok' : `not a ${kind}`, targetPath)
  } catch (err) {
    return readinessCheck(id, label, false, err.code === 'ENOENT' ? 'not found' : err.message, targetPath)
  }
}

function checkWritableLog(id, label, logPath) {
  if (!logPath) return readinessCheck(id, label, false, 'missing run log path')
  const parent = dirname(logPath)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
    return readinessCheck(id, label, true, fs.existsSync(logPath) ? 'ok' : 'will create on first write', logPath)
  } catch (err) {
    return readinessCheck(id, label, false, err.code === 'ENOENT' ? 'log directory not found' : err.message, logPath)
  }
}

function checkCommand(id, command, fallbackPath = null) {
  if (fallbackPath) {
    try {
      fs.accessSync(fallbackPath, fs.constants.X_OK)
      return readinessCheck(id, `${command} binary`, true, fallbackPath, fallbackPath)
    } catch { /* fall back to PATH check */ }
  }
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore', shell: '/bin/bash', timeout: 3000 })
    return readinessCheck(id, `${command} binary`, true, 'ok')
  } catch {
    const detail = fallbackPath
      ? `${command} not found in PATH and fallback is not executable: ${fallbackPath}`
      : `${command} not found in PATH`
    return readinessCheck(id, `${command} binary`, false, detail, fallbackPath)
  }
}

function checkClaudeModel(model) {
  if (!model || model === 'fable') {
    return readinessCheck('model', 'Claude model', false, model ? `${model} is not a runnable Claude model` : 'missing Claude model')
  }
  return readinessCheck('model', 'Claude model', true, model)
}

function preflightRunConfig({ id, project, runner, runScript, repo, runLog, statusPath, promptDir, runTypes, runType, claudeModel }) {
  const selectedRunner = runner || 'script'
  const checks = [
    checkPath('status', 'status file', statusPath),
    checkPath('script', 'run script', runScript),
    checkPath('repo', 'repo directory', repo || '/home/admin/lab', 'dir'),
    checkWritableLog('log', 'run log', runLog),
  ]

  if (selectedRunner === 'codex' || runScript?.includes('run-codex-incubator.sh')) {
    const selectedRunType = runType || runTypes?.[0] || 'mutate'
    checks.push(checkCommand('binary', 'codex', process.env.CODEX_BIN || '/home/admin/.npm-global/bin/codex'))
    checks.push(checkPath('promptDir', 'prompt directory', promptDir, 'dir'))
    checks.push(checkPath('prompt', `${selectedRunType} prompt`, promptDir ? join(promptDir, `${selectedRunType}.md`) : null))
  } else if (selectedRunner === 'claude') {
    checks.push(checkCommand('binary', 'claude'))
    checks.push(checkClaudeModel(claudeModel))
  }

  const ok = checks.every(c => c.ok)
  return {
    ok,
    id,
    project,
    runner: selectedRunner,
    checks,
    error: ok ? null : checks.find(c => !c.ok)?.detail || 'runner preflight failed',
  }
}

function preflightLabRun(runner = labScheduleState.runner) {
  const selected = normalizeLabRunner(runner)
  const cfg = LAB_RUNNERS[selected]
  let status = {}
  try { status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}
  return preflightRunConfig({
    id: 'core',
    project: status.project || 'pi-pulse',
    runner: selected,
    runScript: cfg.script,
    repo: '/home/admin/lab',
    runLog: RUN_LOG_PATH,
    statusPath: PROJECT_STATUS_PATH,
    promptDir: status.promptDir,
    runTypes: status.runTypes,
    claudeModel: status.claudeModel,
  })
}

function preflightIncubatorRun(slot, runType = null) {
  const cfg = readStatusAt(slot.statusPath)
  return preflightRunConfig({
    id: slot.id,
    project: cfg.project,
    runner: cfg.runner ?? 'script',
    runScript: cfg.runScript,
    repo: cfg.repo,
    runLog: cfg.runLog,
    statusPath: slot.statusPath,
    promptDir: cfg.promptDir,
    runTypes: cfg.runTypes,
    runType,
    claudeModel: cfg.claudeModel,
  })
}

// Runner spawns used stdio:'ignore', so a preflight failure (exit 127, bad
// script) died before its first RUN_LOG write and left no trace in history.
// spawnTrackedRun keeps the child detached but routes its output to a capture
// file; on non-zero exit it appends a FAILED stdout block — with the actual
// command error — to the target run log so the parser surfaces it.
const RUN_CAPTURE_DIR = '/home/admin/lab/projects/.run-capture'

function appendFailedRunEntry({ runLogPath, capturePath, code, signal, num }) {
  if (!runLogPath || !num) return
  let detail = ''
  try {
    const lines = fs.readFileSync(capturePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    detail = lines.slice(-3).join(' · ').slice(0, 280)
  } catch { /* capture file missing — still record the exit */ }
  const date = new Date().toISOString().slice(0, 10)
  const reason = signal ? `signal ${signal}` : `exit ${code}`
  // The **Run N — FAILED —** line pins the run number for the parser, so the
  // marker slot number is never shifted by legacyOffset on the host log.
  const block = [
    '',
    `<!-- stdout from run ${num} ${date} server-captured -->`,
    `[run failed — ${reason}] ${detail || 'no output before exit'}`,
    `**Run ${num} — FAILED — server capture**`,
    '',
  ].join('\n')
  try { fs.appendFileSync(runLogPath, block) } catch { /* log dir may not exist */ }
}

function spawnTrackedRun({ script, args = [], cwd, captureName, runLogPath, nextRunNum, onExit }) {
  let stdio = 'ignore'
  const capturePath = join(RUN_CAPTURE_DIR, `${captureName}.log`)
  try {
    fs.mkdirSync(RUN_CAPTURE_DIR, { recursive: true })
    const fd = fs.openSync(capturePath, 'w')
    stdio = ['ignore', fd, fd]
  } catch { /* capture unavailable — run blind as before */ }
  const child = spawn('bash', [script, ...args], { cwd, detached: true, stdio })
  if (Array.isArray(stdio)) { try { fs.closeSync(stdio[1]) } catch {} }
  child.unref()
  child.on('exit', (code, signal) => {
    if (code || signal) {
      appendFailedRunEntry({ runLogPath, capturePath, code, signal, num: nextRunNum?.() ?? 0 })
    }
    onExit?.(code, signal)
  })
  return child
}

function startLabRun(runner = labScheduleState.runner) {
  const selected = normalizeLabRunner(runner)
  const preflight = preflightLabRun(selected)
  if (!preflight.ok) return null
  const cfg = LAB_RUNNERS[selected]
  const child = spawnTrackedRun({
    script: cfg.script,
    args: cfg.args,
    cwd: '/home/admin/lab',
    captureName: `core-${selected}`,
    runLogPath: RUN_LOG_PATH,
    nextRunNum: () => {
      try { return (JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')).runCount ?? 0) + 1 } catch { return 1 }
    },
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
      const match = mem.match(new RegExp(`${key}:\\s+(\\d+)`))
      return match ? parseInt(match[1]) * 1024 : 0
    }
    const total = parse('MemTotal')
    const free = parse('MemFree')
    const buffers = parse('Buffers')
    const cached = parse('Cached')
    const used = total - free - buffers - cached
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
  try {
    const out = execSync('df -B1 / 2>/dev/null', { timeout: 3000 }).toString().trim()
    const lines = out.split('\n')
    if (lines.length < 2) return null
    const parts = lines[1].trim().split(/\s+/)
    const total = parseInt(parts[1])
    const used = parseInt(parts[2])
    const pct = parseInt(parts[4])
    return {
      totalGB: (total / 1e9).toFixed(1),
      usedGB: (used / 1e9).toFixed(1),
      percent: isNaN(pct) ? 0 : pct,
    }
  } catch {
    return null
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
    if (!best) return { rx: 0, tx: 0, iface: 'unknown' }
    if (!prevNetSample || best.iface !== prevNetSample.iface) {
      prevNetSample = best
      return { rx: 0, tx: 0, iface: best.iface }
    }
    const dt = (best.ts - prevNetSample.ts) / 1000
    const rx = dt > 0 ? Math.max(0, Math.round((best.rx - prevNetSample.rx) / dt)) : 0
    const tx = dt > 0 ? Math.max(0, Math.round((best.tx - prevNetSample.tx) / dt)) : 0
    prevNetSample = best
    return { rx, tx, iface: best.iface }
  } catch {
    return { rx: 0, tx: 0, iface: 'unknown' }
  }
}

// ─── Project status sync ──────────────────────────────────────────────────────

const PROJECT_STATUS_PATH = '/home/admin/lab/projects/pi-pulse/status.json'

function syncProjectStatus() {
  try {
    const content = fs.readFileSync(RUN_LOG_PATH, 'utf8')
    const runs = parseRunsFromLog(content)
    const latest = runs[runs.length - 1] ?? null

    let current = {}
    try { current = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}

    const updated = {
      ...current,
      runCount: latest?.num ?? current.runCount ?? 0,
      lastRun: latest?.date ?? current.lastRun,
      lastRunType: latest?.type ?? current.lastRunType,
      syncedAt: new Date().toISOString(),
    }

    fs.writeFileSync(PROJECT_STATUS_PATH, JSON.stringify(updated, null, 2) + '\n')

    // Keep project-level seed.md in sync with the daily seed
    try {
      const seedContent = fs.readFileSync('/home/admin/lab/DAILY_SEED.md', 'utf8')
      fs.writeFileSync('/home/admin/lab/projects/pi-pulse/seed.md', seedContent)
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
  const p = lastStatsPayload || buildStatsPayload()
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
  try { res.write(`data: ${JSON.stringify(buildStatsPayload())}\n\n`) } catch {}
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

function summarizeRun(run) {
  return run['Failure'] || run['Error'] || run['Goal'] || run['Done'] ||
    run['What I investigated'] || run['Investigated'] || run['What I built'] ||
    run['What I changed'] || run['What changed'] || run['What improved'] || run['What I found'] ||
    run['Finding'] || run['Key finding'] || run['Suggested next move'] || ''
}

function publicRun(run) {
  const { _order, _source, _attemptKey, ...rest } = run
  return rest
}

function runSignature(run) {
  return [
    run._source ?? 'run',
    run._order ?? 0,
    run.num ?? '',
    run.date ?? '',
    run.type ?? '',
    summarizeRun(run),
  ].join('|')
}

function meaningfulStdoutLines(body) {
  return body.split('\n').map(l => l.trim()).filter(Boolean)
}

function stdoutFailureDetail(lines) {
  return lines
    .filter(l =>
      !l.startsWith('**Run') &&
      !l.startsWith('---') &&
      !l.startsWith('```')
    )
    .slice(-8)
    .join('\n')
    .slice(0, 1200)
}

function parseStdoutRunBlocks(content, runs, { legacyOffset = false } = {}) {
  const stdoutRe = /^\s*<!--\s*stdout from (codex\s+)?run (\d+)\s+(\d{4}-\d{2}-\d{2})[^>]*-->([\s\S]*?)(?=^\s*<!--\s*stdout from (?:codex\s+)?run \d|^\s*## Run \d|$(?![\s\S]))/gm
  let m
  while ((m = stdoutRe.exec(content)) !== null) {
    const [, codexMarker, slotStr, date, body] = m
    const lines = meaningfulStdoutLines(body)
    const failureLine = lines[0]?.startsWith('[run failed') ? lines[0] : null
    const failed = Boolean(failureLine)
    const boldRun = body.match(/\*\*Run (\d+)\s*(?:[—-]\s*([\w ]+?)\s*[—-]|\s*[—-]\s*done)/)
    const num = boldRun ? parseInt(boldRun[1]) : parseInt(slotStr) + (!codexMarker && legacyOffset ? 1 : 0)
    if (!num) continue

    const rawType = boldRun?.[2]?.trim().toUpperCase() || ''
    const type = failed ? 'FAILED' : ['MUTATE','RESEARCH','CREATE','RUN'].find(t => rawType.includes(t)) || rawType || 'RUN'
    const detailLine = lines.find(l =>
      !l.startsWith('[run failed') &&
      !l.startsWith('**Run') &&
      !l.startsWith('---') &&
      !l.startsWith('```')
    )
    const detail = failed ? stdoutFailureDetail(lines) : ''
    const summary = failed
      ? [failureLine, detailLine].filter(Boolean).join(' ')
      : detailLine || ''

    const formal = runs.find(r => r.num === num && r._source === 'formal')
    if (formal && !failed) continue

    const run = {
      num,
      date,
      type,
      ...(failed ? { Failure: summary || detail || 'stdout run failed with no captured output', detail } : {}),
      'What I changed': summary || 'stdout captured with no summary',
      _order: m.index,
      _source: 'stdout',
    }
    run.signature = runSignature(run)
    runs.push(run)
  }
}

function parseFormalRunBlocks(content) {
  const runs = []
  const formalContent = content.replace(
    /^\s*<!--\s*stdout from [^>]*-->[\s\S]*?(?=^\s*<!--\s*stdout from |^\s*## Run \d|$(?![\s\S]))/gm,
    block => block.replace(/[^\n]/g, ' ')
  )
  const sections = formalContent.split(/(?=^## Run \d)/m).filter(s => s.trimStart().startsWith('## Run'))
  let searchFrom = 0
  for (const block of sections) {
    const order = formalContent.indexOf(block, searchFrom)
    if (order >= 0) searchFrom = order + block.length
    const lines = block.split('\n')
    const header = lines[0].replace('## Run ', '').trim()
    const parts = header.split(/\s+[—-]\s+/).map(s => s.trim())
    const [num, date, type] = parts
    const fields = {}
    for (const line of lines.slice(1)) {
      if (line.startsWith('<!--')) break
      const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/)
      if (m) fields[m[1]] = m[2]
    }
    const n = parseInt(num) || 0
    if (n) {
      const run = { num: n, date, type, ...fields, _order: order >= 0 ? order : runs.length, _source: 'formal' }
      run.signature = runSignature(run)
      runs.push(run)
    }
  }
  return runs
}

function annotateRunAttempts(runs) {
  const totals = new Map()
  for (const run of runs) {
    const key = `${run.num ?? ''}|${run.date ?? ''}`
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }

  const seen = new Map()
  return runs.map(run => {
    const key = `${run.num ?? ''}|${run.date ?? ''}`
    const attemptTotal = totals.get(key) ?? 1
    if (attemptTotal <= 1) return run

    const attempt = (seen.get(key) ?? 0) + 1
    seen.set(key, attempt)
    run._attemptKey = key
    run.attempt = attempt
    run.attemptTotal = attemptTotal
    run.signature = `${run.signature}|attempt:${attempt}/${attemptTotal}`
    return run
  })
}

function dedupeCopiedRuns(runs) {
  const seen = new Set()
  return runs.filter(run => {
    const key = [
      run._source ?? '',
      run.num ?? '',
      run.date ?? '',
      run.type ?? '',
      summarizeRun(run),
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseRunsFromLog(content, options = {}) {
  const runs = parseFormalRunBlocks(content)
  parseStdoutRunBlocks(content, runs, options)
  const sortedRuns = runs.sort((a, b) => (a._order ?? 0) - (b._order ?? 0))
  return annotateRunAttempts(dedupeCopiedRuns(sortedRuns)).map(publicRun)
}

app.get('/api/runs', (req, res) => {
  try {
    const content = fs.readFileSync('/home/admin/lab/RUN_LOG.md', 'utf8')
    res.json(parseRunsFromLog(content).slice(-10))
  } catch {
    res.json([])
  }
})

app.get('/api/run/preflight', (req, res) => {
  res.json(preflightLabRun(req.query.runner || labScheduleState.runner))
})

app.get('/api/logs', (req, res) => {
  try {
    const content = fs.readFileSync('/home/admin/lab/RUN_LOG.md', 'utf8')
    res.json({ content })
  } catch {
    res.json({ content: '*(no log file found)*' })
  }
})

app.post('/api/run', (req, res) => {
  if (activeRunAlive()) {
    return res.status(409).json({ ok: false, error: 'lab run already active', pid: activeRun.pid, runner: activeRun.runner })
  }
  const runner = normalizeLabRunner(req.body?.runner || labScheduleState.runner)
  const preflight = preflightLabRun(runner)
  if (!preflight.ok) {
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
setInterval(() => {
  if (!labScheduleState.enabled || !labScheduleState.nextRunAt) return
  if (Date.now() < labScheduleState.nextRunAt) return
  if (activeRunAlive()) return
  const runner = normalizeLabRunner(labScheduleState.runner)
  const child = startLabRun(runner)
  if (!child) return
  console.log(`[pi-pulse] schedule: firing host lab run via ${runner}`)
  labScheduleState.runner = runner
  labScheduleState.lastScheduledRun = new Date().toISOString()
  labScheduleState.nextRunAt = Date.now() + labScheduleState.intervalHours * 60 * 60 * 1000
  labScheduleState.autoRunsSinceHuman = (labScheduleState.autoRunsSinceHuman || 0) + 1
  saveLabSchedule()
}, 60 * 1000)

app.get('/api/lab/schedule', (req, res) => {
  res.json({ ok: true, availableRunners: Object.keys(LAB_RUNNERS), ...labScheduleState })
})

app.post('/api/lab/schedule', (req, res) => {
  const { enabled, intervalHours, runner } = req.body ?? {}
  if (typeof enabled === 'boolean') labScheduleState.enabled = enabled
  if (typeof intervalHours === 'number' && intervalHours > 0) labScheduleState.intervalHours = intervalHours
  if (typeof runner === 'string') labScheduleState.runner = normalizeLabRunner(runner)
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
  res.json({ ok: true, ts: Date.now() })
})

app.post('/api/lab/feedback', (req, res) => {
  const feedback = String(req.body?.feedback || '').trim()
  if (feedback.length < 3) return res.status(400).json({ ok: false, error: 'feedback is too short' })
  try {
    let status = {}
    try { status = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}
    const filePath = status.feedbackPath || '/home/admin/lab/USER_FEEDBACK.md'
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

const MOUNTED_CONFIG_PATH = '/home/admin/lab/projects/mounted.json'

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
  app.use(CHILD_PLAY_ROUTE, express.static(CHILD_DIR))
}

let activeChildRun = null
const childRunClients = new Set()
const incubatorRunClients = new Set()

function startChildRun() {
  if (!fs.existsSync(CHILD_RUN_SCRIPT)) return null
  const child = spawnTrackedRun({
    script: CHILD_RUN_SCRIPT,
    captureName: `child-${mountedProject.name}`,
    runLogPath: CHILD_LOG_PATH,
    nextRunNum: () => {
      try { return (JSON.parse(fs.readFileSync(CHILD_LAB_STATUS_PATH, 'utf8')).runCount ?? 0) + 1 } catch { return 1 }
    },
  })
  activeChildRun = { pid: child.pid, startTime: Date.now() }
  return child
}

// ─── Multi incubator slots ────────────────────────────────────────────────────

const INCUBATORS_PATH = '/home/admin/lab/projects/incubators.json'
const activeIncubatorRuns = new Map()

function defaultIncubators() {
  return {
    slots: [
      {
        id: 'rat-deposit',
        type: 'project',
        statusPath: '/home/admin/lab/projects/rat-deposit/status.json',
        enabled: true,
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
    if (Array.isArray(data.slots)) return data
  } catch {}
  const data = defaultIncubators()
  writeIncubators(data)
  return data
}

function writeIncubators(data) {
  try { fs.writeFileSync(INCUBATORS_PATH, JSON.stringify(data, null, 2) + '\n') } catch {}
}

function readStatusAt(statusPath) {
  return JSON.parse(fs.readFileSync(statusPath, 'utf8'))
}

function hydrateIncubator(slot) {
  const cfg = readStatusAt(slot.statusPath)
  const repoStatusPath = join(cfg.repo, 'status.json')
  let repoStatus = {}
  try { repoStatus = JSON.parse(fs.readFileSync(repoStatusPath, 'utf8')) } catch {}
  const running = getIncubatorRun(slot.id)
  return {
    ...slot,
    project: cfg.project,
    phase: cfg.phase ?? repoStatus.phase ?? null,
    runner: cfg.runner ?? 'script',
    repo: cfg.repo,
    runLog: cfg.runLog,
    playUrl: fs.existsSync(join(cfg.repo, 'index.html'))
      ? `/${cfg.project.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}/`
      : null,
    runCount: cfg.runCount ?? repoStatus.runCount ?? 0,
    lastRun: cfg.lastRun ?? repoStatus.lastRun ?? null,
    lastRunType: cfg.lastRunType ?? repoStatus.lastRunType ?? null,
    availableRunners: [
      'codex',
      ...(claudeRunScriptForProject(cfg.project) ? ['claude'] : []),
    ],
    claudeModel: cfg.claudeModel ?? null,
    codexModel: cfg.codexModel ?? null,
    current_focus: cfg.current_focus ?? repoStatus.current_focus ?? null,
    next_run_goal: cfg.next_run_goal ?? repoStatus.next_run_goal ?? null,
    notes: cfg.notes ?? repoStatus.notes ?? null,
    feedbackPath: projectFeedbackPath(cfg),
    latestUserFeedback: cfg.latestUserFeedback ?? readLatestProjectFeedback(projectFeedbackPath(cfg)),
    feedbackUpdatedAt: cfg.feedbackUpdatedAt ?? null,
    running,
  }
}

function getIncubatorRun(id) {
  const run = activeIncubatorRuns.get(id)
  if (!run) return { running: false, pid: null, elapsed: 0, startTime: null }
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

function startIncubatorRun(slot, runType = null) {
  const alive = getIncubatorRun(slot.id)
  if (alive.running) return { alreadyRunning: true, ...alive }
  const cfg = readStatusAt(slot.statusPath)
  const preflight = preflightIncubatorRun(slot, runType)
  if (!preflight.ok) return { ok: false, error: 'runner preflight failed', preflight }
  const args = []
  if (cfg.runner === 'codex' || cfg.runScript.includes('run-codex-incubator.sh')) {
    args.push(slot.statusPath)
    if (runType) args.push(runType)
  }
  const child = spawnTrackedRun({
    script: cfg.runScript,
    args,
    cwd: cfg.repo || '/home/admin/lab',
    captureName: `incubator-${slot.id}`,
    runLogPath: cfg.runLog,
    nextRunNum: () => {
      try { return (readStatusAt(slot.statusPath).runCount ?? 0) + 1 } catch { return 1 }
    },
    onExit: (code, signal) => {
      if (!code && !signal) return
      activeIncubatorRuns.delete(slot.id)
      notifyIncubatorClients()
    },
  })
  const run = { pid: child.pid, startTime: Date.now(), runner: cfg.runner ?? 'script' }
  activeIncubatorRuns.set(slot.id, run)
  return { ok: true, pid: child.pid, runner: run.runner, startTime: run.startTime }
}

function claudeRunScriptForProject(project) {
  const known = {
    'race-whisperer-predict': '/home/admin/run-race-whisperer.sh',
    'pi-pulse': '/home/admin/run-lab.sh',
  }
  if (known[project]) return known[project]
  const candidate = `/home/admin/run-${project}.sh`
  return fs.existsSync(candidate) ? candidate : null
}

function updateProjectRunner(statusPath, runner) {
  const status = readStatusAt(statusPath)
  if (runner === 'codex') {
    status.runner = 'codex'
    status.runScript = '/home/admin/lab/scripts/run-codex-incubator.sh'
    status.promptDir = status.promptDir || join(status.repo, 'prompts')
    status.runTypes = status.runTypes || ['mutate', 'research', 'mutate']
    status.codexBypass = status.codexBypass ?? true
  } else if (runner === 'claude') {
    const script = claudeRunScriptForProject(status.project)
    if (!script) {
      return { ok: false, error: `no Claude runner script found for ${status.project}` }
    }
    status.runner = 'claude'
    status.runScript = script
    status.claudeModel = status.claudeModel || 'fable'
  } else {
    return { ok: false, error: 'unsupported runner' }
  }
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n')
  return { ok: true, status }
}

function slugifyProjectName(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
  return slug || 'incubator-' + new Date().toISOString().slice(0, 10)
}

function uniqueIncubatorSlug(seed) {
  const base = slugifyProjectName(seed)
  const data = readIncubators()
  const used = new Set(data.slots.map(slot => slot.id))
  for (let i = 0; i < 50; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`
    if (used.has(slug)) continue
    if (fs.existsSync(join('/home/admin', slug))) continue
    if (fs.existsSync(join('/home/admin/lab/projects', slug))) continue
    return slug
  }
  return `${base}-${Date.now().toString(36)}`
}

function projectFeedbackPath(cfg) {
  return cfg.feedbackPath || join(cfg.repo, 'reports', 'USER_FEEDBACK.md')
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

function createIncubatorProjectFromIdea(idea) {
  const cleanIdea = String(idea || '').trim()
  if (cleanIdea.length < 8) {
    return { ok: false, status: 400, error: 'project idea is too short' }
  }
  const slug = uniqueIncubatorSlug(cleanIdea)
  const repo = join('/home/admin', slug)
  const labProjectDir = join('/home/admin/lab/projects', slug)
  const promptDir = join(repo, 'prompts')
  const reportsDir = join(repo, 'reports')
  const feedbackPath = join(reportsDir, 'USER_FEEDBACK.md')
  const runLog = join(reportsDir, 'RUN_LOG.md')
  const recentRuns = join(reportsDir, 'RECENT_RUNS.md')

  fs.mkdirSync(promptDir, { recursive: true })
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.mkdirSync(labProjectDir, { recursive: true })

  const title = slug.split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ')
  writeFileIfMissing(join(repo, 'README.md'), `# ${title}

Seed idea:

${cleanIdea}

This project was created from the Pi Pulse Add Incubator idea box.
`)
  writeFileIfMissing(join(promptDir, 'create.md'), `Create the first tiny local prototype for this incubator project.

Seed idea:
${cleanIdea}

Rules:
- Build the smallest usable version first.
- Keep it local and simple.
- Prefer plain files and clear state over backend complexity unless the idea truly needs it.
- Append a concise summary to reports/RUN_LOG.md.
- Preserve and use USER_FEEDBACK.md when present.
`)
  writeFileIfMissing(join(promptDir, 'mutate.md'), `Improve this incubator project by one focused step.

Seed idea:
${cleanIdea}

Before changing anything, read reports/USER_FEEDBACK.md if it exists and treat the latest notes as steering input.

Choose one useful mutation that makes the project more real, testable, or personally aligned. Append a concise summary to reports/RUN_LOG.md.
`)
  writeFileIfMissing(join(promptDir, 'research.md'), `Research the next best move for this incubator project.

Seed idea:
${cleanIdea}

Use the repo, reports/RUN_LOG.md, reports/RECENT_RUNS.md, and reports/USER_FEEDBACK.md if present. Identify what is unclear, what should be tested next, and what would make the project more useful. Append a concise summary to reports/RUN_LOG.md.
`)
  writeFileIfMissing(runLog, `# Run Log\n\n`)
  writeFileIfMissing(recentRuns, `# Recent Runs\n\n*(no runs yet)*\n`)
  writeFileIfMissing(feedbackPath, `# User Feedback / Steering Notes

These notes are written from the Pi Pulse UI and injected into future incubator runs.

## Seed

${cleanIdea}
`)

  const status = {
    project: slug,
    status: 'seeded',
    phase: 'idea-seed',
    runner: 'codex',
    repo,
    runLog,
    recentRuns,
    runScript: '/home/admin/lab/scripts/run-codex-incubator.sh',
    promptDir,
    feedbackPath,
    runTypes: ['create', 'mutate', 'research', 'mutate'],
    runCount: 0,
    lastRun: null,
    lastRunType: null,
    current_focus: cleanIdea.slice(0, 260),
    next_run_goal: 'Run CREATE to turn this idea into the first usable local prototype.',
    notes: 'Created from Pi Pulse Add Incubator idea box.',
    codexBypass: true,
  }
  const statusPath = join(labProjectDir, 'status.json')
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n')
  return { ok: true, slug, statusPath, status }
}
function notifyIncubatorClients() {
  for (const client of incubatorRunClients) {
    try { client.write('data: update\n\n') } catch { incubatorRunClients.delete(client) }
  }
}

const mountedPlayRoutes = new Set()

function mountPlayRoute(cfg) {
  const route = `/${cfg.project.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
  if (mountedPlayRoutes.has(route)) return route
  if (!fs.existsSync(join(cfg.repo, 'index.html'))) return null
  app.use(route, express.static(cfg.repo))
  mountedPlayRoutes.add(route)
  return route
}

for (const slot of readIncubators().slots) {
  try {
    mountPlayRoute(readStatusAt(slot.statusPath))
  } catch { /* skip malformed incubator slots */ }
}

// ─── Incubator auto-schedule ───────────────────────────────────────────────────

const SCHEDULE_PATH = '/home/admin/lab/projects/schedule.json'
let scheduleState = { enabled: false, intervalHours: 2, nextRunAt: null, lastScheduledRun: null, autoRunsSinceHuman: 0 }

try {
  const raw = fs.readFileSync(SCHEDULE_PATH, 'utf8')
  const loaded = JSON.parse(raw)
  scheduleState = { ...scheduleState, ...loaded }
  // If nextRunAt is in the past after a restart, reschedule from now
  if (scheduleState.enabled && scheduleState.nextRunAt && scheduleState.nextRunAt < Date.now()) {
    scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
  }
} catch { /* no schedule file yet — defaults apply */ }

function saveSchedule() {
  try { fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(scheduleState, null, 2)) } catch {}
}

// Check every 60s — fire the mounted project's run script if the schedule is due
setInterval(() => {
  if (!scheduleState.enabled || !scheduleState.nextRunAt) return
  if (Date.now() < scheduleState.nextRunAt) return
  if (activeChildRun) {
    try { process.kill(activeChildRun.pid, 0); return } catch { activeChildRun = null }
  }
  if (!startChildRun()) return
  console.log('[pi-pulse] schedule: firing child run')
  scheduleState.lastScheduledRun = new Date().toISOString()
  scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
  scheduleState.autoRunsSinceHuman = (scheduleState.autoRunsSinceHuman || 0) + 1
  saveSchedule()
}, 60 * 1000)

app.get('/api/child/config', (req, res) => {
  res.json({
    project: mountedProject.name,
    dir: mountedProject.dir,
    playUrl: fs.existsSync(join(CHILD_DIR, 'index.html')) ? `${CHILD_PLAY_ROUTE}/` : null,
  })
})

function parseChildRuns(content) {
  return parseRunsFromLog(content)
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
    const cfg = readStatusAt(slot.statusPath)
    const content = fs.readFileSync(cfg.runLog, 'utf8')
    res.json({ ok: true, runs: parseChildRuns(content).slice(-10) })
  } catch (err) {
    res.json({ ok: true, runs: [], error: err.message })
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

app.post('/api/incubators/:id/run', (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const result = startIncubatorRun(slot, req.body?.runType ?? null)
  if (!result) return res.status(404).json({ ok: false, error: 'run script not found' })
  if (result.ok === false) return res.status(422).json(result)
  slot.autoRunsSinceHuman = 0
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, ...result })
})

app.post('/api/incubators/:id/schedule', (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const { enabled, intervalHours, runner } = req.body ?? {}
  if (typeof enabled === 'boolean') slot.enabled = enabled
  if (typeof intervalHours === 'number' && intervalHours > 0) slot.intervalHours = intervalHours
  if (typeof runner === 'string') slot.runner = runner
  if (slot.enabled) {
    if (!slot.nextRunAt || slot.nextRunAt < Date.now()) {
      slot.nextRunAt = Date.now() + (slot.intervalHours || 0.5) * 60 * 60 * 1000
    }
  } else {
    slot.nextRunAt = null
  }
  slot.autoRunsSinceHuman = 0
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, slot: hydrateIncubator(slot) })
})

app.post('/api/incubators/:id/runner', (req, res) => {
  const data = readIncubators()
  const slot = data.slots.find(s => s.id === req.params.id)
  if (!slot) return res.status(404).json({ ok: false, error: 'incubator not found' })
  const { runner } = req.body ?? {}
  const result = updateProjectRunner(slot.statusPath, runner)
  if (!result.ok) return res.status(400).json(result)
  writeIncubators(data)
  notifyIncubatorClients()
  res.json({ ok: true, slot: hydrateIncubator(slot) })
})

app.post('/api/incubators/create', (req, res) => {
  const result = createIncubatorProjectFromIdea(req.body?.idea)
  if (!result.ok) return res.status(result.status || 400).json(result)
  const data = readIncubators()
  const slot = {
    id: result.slug,
    type: 'project',
    statusPath: result.statusPath,
    enabled: false,
    intervalHours: 0.5,
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

app.post('/api/incubators/:id/feedback', (req, res) => {
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
    fs.writeFileSync(slot.statusPath, JSON.stringify(cfg, null, 2) + '\n')
    writeIncubators(data)
    notifyIncubatorClients()
    res.json({ ok: true, slot: hydrateIncubator(slot) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
app.post('/api/incubators', (req, res) => {
  const { project, intervalHours = 0.5, enabled = false } = req.body ?? {}
  if (!project || typeof project !== 'string' || project.includes('..') || project === 'pi-pulse') {
    return res.status(400).json({ ok: false, error: 'invalid project' })
  }
  const statusPath = join('/home/admin/lab/projects', project, 'status.json')
  if (!fs.existsSync(statusPath)) return res.status(404).json({ ok: false, error: 'project status not found' })
  const data = readIncubators()
  if (data.slots.some(s => s.id === project)) return res.status(409).json({ ok: false, error: 'incubator already exists' })
  const slot = {
    id: project,
    type: 'project',
    statusPath,
    enabled: !!enabled,
    intervalHours,
    nextRunAt: enabled ? Date.now() + intervalHours * 60 * 60 * 1000 : null,
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

app.delete('/api/incubators/:id', (req, res) => {
  const data = readIncubators()
  const next = data.slots.filter(s => s.id !== req.params.id)
  if (next.length === data.slots.length) return res.status(404).json({ ok: false, error: 'incubator not found' })
  data.slots = next
  writeIncubators(data)
  activeIncubatorRuns.delete(req.params.id)
  notifyIncubatorClients()
  res.json({ ok: true })
})

setInterval(() => {
  const data = readIncubators()
  let changed = false
  for (const slot of data.slots) {
    if (!slot.enabled || !slot.nextRunAt || Date.now() < slot.nextRunAt) continue
    if (getIncubatorRun(slot.id).running) continue
    const result = startIncubatorRun(slot)
    if (!result) continue
    if (result.ok === false) {
      console.warn(`[pi-pulse] incubator: ${slot.id} preflight blocked run: ${result.preflight?.error || result.error}`)
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
    res.json(parseChildRuns(content).slice(-10))
  } catch {
    res.json([])
  }
})

app.post('/api/child/run', (req, res) => {
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

app.post('/api/child/schedule', (req, res) => {
  const { enabled, intervalHours } = req.body ?? {}
  if (typeof enabled === 'boolean') scheduleState.enabled = enabled
  if (typeof intervalHours === 'number' && intervalHours > 0) scheduleState.intervalHours = intervalHours
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

app.post('/api/child/ai/analyze', async (req, res) => {
  try {
    // Use MemPalace semantic search for compact context
    const palaceCtx = queryMemPalace(`${mountedProject.name} seed direction active threads`, { wing: 'lab', results: 3, maxChars: 600 })
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
    try {
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
      fs.writeFileSync(CHILD_FEEDBACK_MD, `# Drift Feedback — ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync(CHILD_FEEDBACK_JSON, JSON.stringify({ ok: true, response: data.response, model: AI_MODEL, ts: Date.now() }))
    } catch { /* non-fatal */ }

    res.json({ ok: true, response: data.response, model: AI_MODEL })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/child/ai/latest', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CHILD_FEEDBACK_JSON, 'utf8')))
  } catch {
    res.json({ ok: false })
  }
})


app.get('/api/child/ai/status', async (req, res) => {
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
      json: '/home/admin/lab/DRIFT_FEEDBACK.json',
      md: '/home/admin/lab/DRIFT_FEEDBACK.md',
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

app.get('/api/incubators/:id/ai/latest', (req, res) => {
  const target = aiTargetForIncubator(req.params.id)
  if (!target) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    const data = JSON.parse(fs.readFileSync(target.paths.json, 'utf8'))
    res.json(hydrateAiFeedback(data, target))
  } catch {
    res.json({ ok: false })
  }
})

app.post('/api/incubators/:id/ai/analyze', async (req, res) => {
  const target = aiTargetForIncubator(req.params.id)
  if (!target) return res.status(404).json({ ok: false, error: 'incubator not found' })
  try {
    const palaceCtx = queryMemPalace(target.query, { wing: 'lab', results: 3, maxChars: 600 })
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

// AI analysis via local Ollama/Qwen
const HAILO_URL = 'http://localhost:11434'
const AI_MODEL = 'qwen2.5-instruct:1.5b'

// MemPalace semantic search — returns relevant context snippets (~100-600 chars)
// instead of dumping raw files into every prompt
function queryMemPalace(query, { wing = '', results = 3, maxChars = 600 } = {}) {
  try {
    const wingFlag = wing ? `--wing ${wing}` : ''
    const raw = execSync(
      `/home/admin/.local/bin/mempalace search ${JSON.stringify(query)} --results ${results} ${wingFlag} 2>/dev/null`,
      { timeout: 10000, encoding: 'utf8', env: { ...process.env, HOME: '/home/admin' } }
    )
    // Strip ANSI codes and extract only content lines (skip headers/metadata/separators)
    const clean = raw.replace(/\x1b\[[0-9;]*[mGKH]/g, '')
    const out = []
    let afterMatch = false
    for (const line of clean.split('\n')) {
      const t = line.trim()
      if (/^={5,}/.test(t) || /^─{5,}/.test(t)) { afterMatch = false; continue }
      if (!t || /^Results for:/.test(t)) continue
      if (/^\[\d+\]\s+\w/.test(t) || /^Source:/.test(t)) { afterMatch = false; continue }
      if (/^Match:/.test(t)) { afterMatch = true; continue }
      if (afterMatch) out.push(line)
    }
    return out.join('\n').trim().slice(0, maxChars)
  } catch {
    return ''
  }
}

app.get('/api/ai/status', async (req, res) => {
  try {
    const r = await fetch(`${HAILO_URL}/api/tags`)
    const data = await r.json()
    const loaded = data.models?.some(m => m.name?.includes('qwen2.5-instruct'))
    res.json({ available: true, modelLoaded: loaded, models: data.models })
  } catch {
    res.json({ available: false, modelLoaded: false })
  }
})

app.post('/api/ai/analyze', async (req, res) => {
  try {
    // Use MemPalace semantic search for compact context instead of raw file dumps
    const palaceCtx = queryMemPalace('pi-pulse seed direction current state active threads', { wing: 'lab', results: 3, maxChars: 600 })
    let recentLog = ''
    try { recentLog = fs.readFileSync('/home/admin/lab/RUN_LOG.md', 'utf8').slice(-400) } catch {}

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
      fs.writeFileSync('/home/admin/lab/DRIFT_FEEDBACK.md',
        `# Drift Feedback — ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync('/home/admin/lab/DRIFT_FEEDBACK.json',
        JSON.stringify(payload, null, 2) + '\n')
    } catch { /* non-fatal */ }

    res.json(payload)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/ai/latest', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync('/home/admin/lab/DRIFT_FEEDBACK.json', 'utf8'))
    res.json(hydrateAiFeedback(data, { id: 'core', project: 'pi-pulse' }))
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

const PROJECTS_DIR = '/home/admin/lab/projects'

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
          name:     cfg.project ?? entry.name,
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
app.post('/api/projects/mount', express.json(), (req, res) => {
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

// SSE — push 'update' to all connected clients whenever RUN_LOG.md changes
const runClients = new Set()
// Directory watch instead of file watch — survives rename-replace (new inode)
// and a log that doesn't exist yet. Filter to RUN_LOG.md so the rest of the
// lab dir's churn (MEMORY_BRIEF.md, ACTIVE_THREADS.md, …) doesn't spam clients.
try {
  fs.watch(dirname(RUN_LOG_PATH), { persistent: false }, (eventType, filename) => {
    if (filename && filename !== 'RUN_LOG.md') return
    syncProjectStatus()
    for (const client of runClients) {
      try { client.write('data: update\n\n') } catch { runClients.delete(client) }
    }
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


app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'api route not found', path: req.originalUrl })
})

// SPA fallback
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'dist', 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.status(404).send('Build not found. Run: npm run build')
  }
})

function startServer(retries = 10) {
  const server = app.listen(PORT, () => {
    console.log(`Pi Pulse API → http://localhost:${PORT}/api/stats`)
  })
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`[pi-pulse] port ${PORT} busy, retrying in 1s... (${retries} left)`)
      setTimeout(() => startServer(retries - 1), 1000)
    } else {
      console.error('[pi-pulse] fatal listen error:', err.message)
      process.exit(1)
    }
  })
}
startServer()

// Watch dist/ for new builds and exit cleanly so the wrapper restarts us
let reloadDebounce = null
fs.watch(join(__dirname, 'dist'), () => {
  clearTimeout(reloadDebounce)
  reloadDebounce = setTimeout(() => {
    console.log('[pi-pulse] dist changed — reloading')
    process.exit(0)
  }, 800)
})
