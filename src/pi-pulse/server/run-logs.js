// Parsed RUN_LOG.md access. The core log is several MB and every change fans
// out to SSE clients, so parsing is cached on (mtime, size).
import fs from 'fs'
import { dirname, join } from 'path'
import { parseRunsFromLog } from '../server-core.js'
import { RUN_CAPTURE_DIR } from './config.js'

const parsedRunLogCache = new Map()

function stdoutRootsForLog(filePath) {
  return [join(dirname(filePath), 'stdout'), RUN_CAPTURE_DIR]
}

export function parsedRunsForLog(filePath) {
  const stat = fs.statSync(filePath)
  const cached = parsedRunLogCache.get(filePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.runs
  const content = fs.readFileSync(filePath, 'utf8')
  const runs = parseRunsFromLog(content, { stdoutRoots: stdoutRootsForLog(filePath) })
  parsedRunLogCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, runs })
  return runs
}

export function readLogContent(filePath, { maxBytes = 512 * 1024, full = false } = {}) {
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

export function appendSteeringNote({ feedbackPath, runLogPath, feedback, header }) {
  const stamp = new Date().toISOString()
  fs.mkdirSync(dirname(feedbackPath), { recursive: true })
  if (!fs.existsSync(feedbackPath)) fs.writeFileSync(feedbackPath, header)
  fs.appendFileSync(feedbackPath, `\n## ${stamp}\n\n${feedback}\n`)
  if (runLogPath) {
    fs.mkdirSync(dirname(runLogPath), { recursive: true })
    fs.appendFileSync(runLogPath, `\n## User Feedback - ${stamp}\n\n**Steering:** ${feedback}\n`)
  }
  return stamp
}
