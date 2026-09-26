// Host telemetry sampled from /proc and /sys, plus a persisted 24h rolling
// buffer of 5-minute snapshots for the day chart.
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import { DAY_BUFFER_PATH } from './config.js'

let prevCpuTimes = null
let prevNetSample = null
let lastNetRate = { rx: 0, tx: 0, iface: 'unknown' }
let diskInfoCache = { ts: 0, value: null }

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
      const rx = fields[0]
      const tx = fields[8]
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

// CPU and network rates are deltas between samples. One sampler owns them, so an
// extra consumer (a second tab, /api/stats, the day buffer) cannot shorten the
// window and report a random 0% or spike.
const SAMPLE_INTERVAL_MS = 2000
let latestCpu = 0
let latestNet = { rx: 0, tx: 0, iface: 'unknown' }
let cpuWindow = { sum: 0, count: 0 }

function takeSample() {
  latestCpu = getCpuUsage()
  latestNet = getNetworkRate()
  cpuWindow = { sum: cpuWindow.sum + latestCpu, count: cpuWindow.count + 1 }
}

export function startStatsSampler() {
  prevCpuTimes = readCpuTimes()
  getNetworkRate()
  setInterval(takeSample, SAMPLE_INTERVAL_MS).unref?.()
}

export function buildStatsPayload() {
  const mem = getMemInfo()
  const temp = getTemperature()
  const uptimeSecs = getUptime()
  const load = getLoadAvg()
  const cpu = latestCpu
  const disk = getDiskInfo()
  const net = latestNet
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

const DAY_BUFFER_MAX = 288  // 24h × 12 per hour
let dayBuffer = []

function loadDayBuffer() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DAY_BUFFER_PATH, 'utf8'))
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    dayBuffer = loaded.filter(e => e.ts > cutoff).slice(-DAY_BUFFER_MAX)
  } catch { /* file doesn't exist yet — start fresh */ }
}

function pushDaySnapshot() {
  const p = buildStatsPayload()
  // Each 5-minute point is the mean of its window, not one 2-second sample.
  const cpu = cpuWindow.count ? Math.round(cpuWindow.sum / cpuWindow.count) : p.cpu
  cpuWindow = { sum: 0, count: 0 }
  dayBuffer.push({ ts: Date.now(), cpu: cpu ?? 0, temp: p.temperature ?? null, mem: p.memory?.percent ?? 0, rx: p.net?.rx ?? 0, tx: p.net?.tx ?? 0 })
  if (dayBuffer.length > DAY_BUFFER_MAX) dayBuffer.shift()
  const tmp = `${DAY_BUFFER_PATH}.${process.pid}.tmp`
  fs.writeFile(tmp, JSON.stringify(dayBuffer), err => {
    if (!err) fs.rename(tmp, DAY_BUFFER_PATH, () => {})
  })
}

export function startDayBuffer() {
  loadDayBuffer()
  setTimeout(pushDaySnapshot, 3000).unref?.()
  setInterval(pushDaySnapshot, 5 * 60 * 1000).unref?.()
}

export function dayBufferEntries() {
  return dayBuffer
}
