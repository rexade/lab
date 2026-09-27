// Stale-source detection: if server code changes on disk while the service is
// running, runner-mutating writes are refused until Pi Pulse restarts, so the UI
// never drives runs with logic that no longer matches the files.
import fs from 'fs'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { PI_PULSE_ROOT, SOURCE_HEALTH_FILES } from './config.js'

const SERVER_STARTED_AT = Date.now()

function sourceSnapshot() {
  const hash = createHash('sha256')
  let latestMtimeMs = 0
  const files = SOURCE_HEALTH_FILES.map(filePath => {
    const label = filePath.startsWith(PI_PULSE_ROOT) ? filePath.slice(PI_PULSE_ROOT.length + 1) : filePath
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

export function serviceHealth() {
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

export function requireFreshSource(req, res, next) {
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

// ─── Loading new code without a person ────────────────────────────────────────
// A git pull or deploy leaves new server code on disk. Instead of waiting for
// someone to press Restart, an idle service restarts itself once the new
// source has stopped changing for a full check and parses/imports cleanly.

// Pure: decide from one health sample and the previous tick's state.
//   { action: 'none' }                      nothing new, or the lab is busy
//   { action: 'settle', fingerprint }       new source seen: wait one tick for it to stop changing
//   { action: 'restart', fingerprint }      unchanged since last tick and idle
export function staleSourceRestartPlan({ health, busy = false, pendingFingerprint = null, rejectedFingerprint = null }) {
  if (!health?.source?.changedSinceStart) return { action: 'none' }
  const fingerprint = health.source.fingerprint
  if (fingerprint === rejectedFingerprint) return { action: 'none', reason: 'this source failed validation' }
  if (fingerprint !== pendingFingerprint) return { action: 'settle', fingerprint }
  if (busy) return { action: 'none', reason: 'a run holds the lab lock', fingerprint }
  return { action: 'restart', fingerprint }
}

// Syntax-checks every watched file and imports the server modules in a child
// process, so a half-finished pull never restarts into a crash loop.
function errorLine(result, fallback) {
  const lines = String(result.stderr || result.error?.message || '').split('\n').map(line => line.trim()).filter(Boolean)
  return lines.find(line => /error/i.test(line)) || lines[0] || fallback
}

export function validateSourceForRestart(files = SOURCE_HEALTH_FILES) {
  for (const file of files) {
    const check = file.endsWith('.sh')
      ? spawnSync('bash', ['-n', file], { encoding: 'utf8', timeout: 15000 })
      : /\.(c|m)?js$/.test(file) ? spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 }) : null
    if (check && check.status !== 0) return { ok: false, file, error: errorLine(check, 'syntax check failed') }
  }
  const modules = files.filter(file => /\/server(-core)?[/.]/.test(file) && file.endsWith('.js') && !file.endsWith('/server.js'))
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const f of ${JSON.stringify(modules)}) await import(f); process.exit(0)`], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PI_PULSE_NO_LISTEN: '1', PI_PULSE_DISABLE_SCHEDULES: '1' },
  })
  if (probe.status !== 0) return { ok: false, file: 'server modules', error: errorLine(probe, 'import failed') }
  return { ok: true }
}
