import fs from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { MAX_SCHEDULE_INTERVAL_HOURS, MIN_SCHEDULE_INTERVAL_HOURS } from './config.js'

export function pathInside(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false
  const target = resolve(String(targetPath))
  const root = resolve(String(rootPath))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function pathInsideAny(targetPath, roots = []) {
  return roots.some(root => pathInside(targetPath, root))
}

export function safePathSegment(value, fallback = 'project') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

export function routeSlugForProject(project) {
  return String(project || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

export function readJsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return fallback }
}

export function clampScheduleInterval(value, fallback = 0.5) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(MAX_SCHEDULE_INTERVAL_HOURS, Math.max(MIN_SCHEDULE_INTERVAL_HOURS, numeric))
}

export function hoursFromNow(hours) {
  return Date.now() + hours * 60 * 60 * 1000
}

export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 1) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

export function shellQuote(value) {
  const raw = String(value ?? '')
  if (!raw) return "''"
  return /^[A-Za-z0-9_./:=+-]+$/.test(raw) ? raw : `'${raw.replace(/'/g, `'\\''`)}'`
}

export function openSseStream(req, res, clients) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  clients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n') } catch { clearInterval(heartbeat) }
  }, 25000)
  req.on('close', () => {
    clients.delete(res)
    clearInterval(heartbeat)
  })
}

export function broadcastSse(clients, data = 'update') {
  for (const client of clients) {
    try { client.write(`data: ${data}\n\n`) } catch { clients.delete(client) }
  }
}
