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

// CPU usage calculation (requires two samples)
let prevCpuTimes = null

// Network I/O — requires two samples to compute bytes/sec rate
let prevNetSample = null

// Cached last stats payload — used by pushDaySnapshot to avoid double-sampling
let lastStatsPayload = null

// Active run tracking — cleared after process exits and status is read
let activeRun = null // { pid, startTime }

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
    const sections = content.split(/(?=^## Run \d)/m).filter(s => s.trimStart().startsWith('## Run'))
    const runCount = sections.length

    const lastSection = sections[sections.length - 1] ?? ''
    const headerMatch = lastSection.match(/^## Run (\d+) — (\d{4}-\d{2}-\d{2}) — (\w+)/m)

    let current = {}
    try { current = JSON.parse(fs.readFileSync(PROJECT_STATUS_PATH, 'utf8')) } catch {}

    const updated = {
      ...current,
      runCount,
      lastRun: headerMatch?.[2] ?? current.lastRun,
      lastRunType: headerMatch?.[3] ?? current.lastRunType,
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

app.use(express.json())

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

app.get('/api/runs', (req, res) => {
  try {
    const content = fs.readFileSync('/home/admin/lab/RUN_LOG.md', 'utf8')
    const byNum = new Map()

    // Parser 1 — formal ## Run N — DATE — TYPE sections
    const sections = content.split(/(?=^## Run \d)/m).filter(s => s.trimStart().startsWith('## Run'))
    for (const block of sections) {
      const lines = block.split('\n')
      const header = lines[0].replace('## Run ', '')
      const [num, date, type] = header.split(' — ').map(s => s.trim())
      const fields = {}
      for (const line of lines.slice(1)) {
        if (line.startsWith('<!--')) break
        const m = line.match(/^\*\*(.+?):\*\* (.+)/)
        if (m) fields[m[1]] = m[2]
      }
      const n = parseInt(num) || 0
      if (n) byNum.set(n, { num: n, date, type, ...fields })
    }

    // Parser 2 — stdout comment blocks: <!-- stdout from run N DATE -->
    const stdoutRe = /<!--\s*stdout from run (\d+)\s+(\d{4}-\d{2}-\d{2})[^>]*-->([\s\S]*?)(?=<!--\s*stdout from run \d|$)/g
    let m
    while ((m = stdoutRe.exec(content)) !== null) {
      const [, slotStr, date, body] = m
      // The bold **Run N — TYPE —** heading inside the body names the actual run
      const boldRun = body.match(/\*\*Run (\d+)\s*(?:—\s*([\w ]+?)\s*—|\s*—\s*done)/)
      const num = boldRun ? parseInt(boldRun[1]) : parseInt(slotStr) + 1
      if (!num || byNum.has(num)) continue
      const rawType = boldRun?.[2]?.trim().toUpperCase() || ''
      const type = ['MUTATE','RESEARCH','CREATE','RUN'].find(t => rawType.includes(t)) || rawType || 'RUN'
      // First meaningful non-bold line as summary
      const summary = body.split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('**Run') && !l.startsWith('---') && !l.startsWith('```') && !l.startsWith('['))
        || ''
      byNum.set(num, { num, date, type, 'What I changed': summary })
    }

    const runs = [...byNum.values()].sort((a, b) => a.num - b.num)
    res.json(runs.slice(-10))
  } catch {
    res.json([])
  }
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
  const script = '/home/admin/run-lab.sh'
  if (!fs.existsSync(script)) {
    return res.status(404).json({ ok: false, error: 'run-lab.sh not found' })
  }
  const child = spawn('bash', [script], {
    cwd: '/home/admin/lab',
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  activeRun = { pid: child.pid, startTime: Date.now() }
  res.json({ ok: true, pid: child.pid })
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

  res.json({ running: true, pid: activeRun.pid, elapsed, startTime })
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
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

let activeChildRun = null
const childRunClients = new Set()

// ─── Incubator auto-schedule ───────────────────────────────────────────────────

const SCHEDULE_PATH = '/home/admin/lab/projects/schedule.json'
let scheduleState = { enabled: false, intervalHours: 2, nextRunAt: null, lastScheduledRun: null }

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
  if (!fs.existsSync(CHILD_RUN_SCRIPT)) return
  console.log('[pi-pulse] schedule: firing child run')
  const child = spawn('bash', [CHILD_RUN_SCRIPT], { detached: true, stdio: 'ignore' })
  child.unref()
  activeChildRun = { pid: child.pid, startTime: Date.now() }
  scheduleState.lastScheduledRun = new Date().toISOString()
  scheduleState.nextRunAt = Date.now() + scheduleState.intervalHours * 60 * 60 * 1000
  saveSchedule()
}, 60 * 1000)

app.get('/api/child/config', (req, res) => {
  res.json({ project: mountedProject.name, dir: mountedProject.dir })
})

function parseChildRuns(content) {
  const sections = content.split(/(?=^## Run \d)/m).filter(s => s.trimStart().startsWith('## Run'))
  return sections.map(block => {
    const lines = block.split('\n')
    const header = lines[0].replace('## Run ', '').trim()
    const parts = header.split(' — ').map(s => s.trim())
    const num = parts[0], date = parts[1], type = parts[2]
    const fields = {}
    for (const line of lines.slice(1)) {
      if (line.startsWith('<!--')) break
      const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/)
      if (m) fields[m[1]] = m[2]
    }
    return { num: parseInt(num) || 0, date, type, ...fields }
  })
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
    res.json(parseChildRuns(content).slice(-10))
  } catch {
    res.json([])
  }
})

app.post('/api/child/run', (req, res) => {
  if (!fs.existsSync(CHILD_RUN_SCRIPT)) {
    return res.status(404).json({ ok: false, error: 'run script not found' })
  }
  const child = spawn('bash', [CHILD_RUN_SCRIPT], { detached: true, stdio: 'ignore' })
  child.unref()
  activeChildRun = { pid: child.pid, startTime: Date.now() }
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

try {
  fs.watch(CHILD_LOG_PATH, { persistent: false }, (eventType) => {
    if (eventType === 'change') {
      for (const client of childRunClients) {
        try { client.write('data: update\n\n') } catch { childRunClients.delete(client) }
      }
    }
  })
} catch { /* log may not exist yet */ }

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

// AI analysis via local hailo-ollama
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

    // Write parsed feedback to DRIFT_FEEDBACK.md so the lab agent reads it next run
    try {
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
      fs.writeFileSync('/home/admin/lab/DRIFT_FEEDBACK.md',
        `# Drift Feedback — ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync('/home/admin/lab/DRIFT_FEEDBACK.json',
        JSON.stringify({ ok: true, response: data.response, model: AI_MODEL, ts: Date.now() }))
    } catch { /* non-fatal */ }

    res.json({ ok: true, response: data.response, model: AI_MODEL })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/ai/latest', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync('/home/admin/lab/DRIFT_FEEDBACK.json', 'utf8'))
    res.json(data)
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
try {
  fs.watch(RUN_LOG_PATH, { persistent: false }, (eventType) => {
    if (eventType === 'change') {
      syncProjectStatus()
      for (const client of runClients) {
        try { client.write('data: update\n\n') } catch { runClients.delete(client) }
      }
    }
  })
} catch { /* file may not exist on first boot */ }

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
