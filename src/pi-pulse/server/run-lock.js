// Global run lock + tracked runner spawning.
// Only one autonomous run (core or any incubator) may be active at a time; the
// lock lives on disk so it survives a Pi Pulse restart while a runner continues.
import fs from 'fs'
import { spawn } from 'child_process'
import { join } from 'path'
import { appendFailedRunEntry } from '../server-core.js'
import { LAB_ROOT, RUN_CAPTURE_DIR, RUN_LOCK_DIR } from './config.js'
import { pidAlive, writeJsonAtomic } from './util.js'

function runLockPath() {
  return join(RUN_LOCK_DIR, 'global')
}

function readRunLock() {
  try { return JSON.parse(fs.readFileSync(join(runLockPath(), 'owner.json'), 'utf8')) } catch { return null }
}

function clearRunLock() {
  try { fs.rmSync(runLockPath(), { recursive: true, force: true }) } catch {}
}

export function currentRunLock() {
  const lock = readRunLock()
  if (!lock?.pid) { clearRunLock(); return null }
  if (pidAlive(lock.pid)) return lock
  clearRunLock()
  return null
}

export function acquireRunLock(owner = {}) {
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

export function globalRunBusy() {
  return currentRunLock()
}

// Runner spawns used stdio:'ignore', so a preflight failure (exit 127, bad
// script) died before its first RUN_LOG write and left no trace in history.
// spawnTrackedRun keeps the child detached but routes its output to a capture
// file; on non-zero exit it appends a FAILED stdout block — with the actual
// command error — to the target run log so the parser surfaces it.
export function spawnTrackedRun({ script, args = [], cwd, captureName, runLogPath, nextRunNum, onExit, env = {}, lock = null }) {
  let stdio = 'ignore'
  const capturePath = join(RUN_CAPTURE_DIR, `${captureName}.log`)
  try {
    fs.mkdirSync(RUN_CAPTURE_DIR, { recursive: true })
    const fd = fs.openSync(capturePath, 'w')
    stdio = ['ignore', fd, fd]
  } catch { /* capture unavailable — run blind as before */ }
  const child = spawn('bash', [script, ...args], { cwd, detached: true, stdio, env: { ...process.env, LAB_DIR: LAB_ROOT, ...env } })
  activateRunLock(lock, child.pid)
  if (Array.isArray(stdio)) { try { fs.closeSync(stdio[1]) } catch {} }
  child.unref()
  // A spawn failure (e.g. the repo vanished after preflight) emits 'error'
  // instead of 'exit'; unhandled, it would crash Pi Pulse with the lock held.
  let settled = false
  const settle = (code, signal, error = null) => {
    if (settled) return
    settled = true
    releaseRunLock(lock)
    if (error || code || signal) {
      const failedRunNum = nextRunNum?.() ?? 0
      const reason = error ? `spawn failed: ${error.code || error.message}` : null
      appendFailedRunEntry({ runLogPath, capturePath, code, signal, num: failedRunNum, reason })
      onExit?.(code ?? 1, signal, { capturePath, failedRunNum, error })
      return
    }
    onExit?.(code, signal, { capturePath, failedRunNum: null })
  }
  child.on('error', error => settle(null, null, error))
  child.on('exit', (code, signal) => settle(code, signal))
  return child
}
