import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

export const SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 2 * 1024 * 1024
export const hash = value => createHash('sha256').update(value).digest('hex')
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

export function redact(text) {
  let value = String(text ?? '')
  if (process.env.TYPESAFE_API_KEY) value = value.split(process.env.TYPESAFE_API_KEY).join('[REDACTED]')
  return value.replace(/\bapikey_[a-z0-9_]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

export function writeOnce(dir, name, value) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const data = Buffer.isBuffer(value) ? value : typeof value === 'string' ? redact(value) : JSON.stringify(sanitize(value), null, 2) + '\n'
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
}

function sanitize(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
  return value
}

function readFile(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(file)
  } catch { return null }
}

function document(repo, name) {
  return readFile(path.join(repo, name))?.toString('utf8') ?? null
}

function captureChecks(dir, phase, repo, checks) {
  writeOnce(dir, `${phase}/checks.json`, checks)
  const source = checks?.app?.evidence
  const validSource = typeof source === 'string' && /^run-[a-z0-9-]+$/i.test(source)
  const sourceDir = validSource ? path.join(repo, 'reports', 'evidence', source) : null
  const shots = []
  const missing = []
  for (const name of checks?.app?.shots || []) {
    if (!['desktop.png', 'mobile.png', 'after-action.png'].includes(name)) { missing.push(name); continue }
    const data = sourceDir && readFile(path.join(sourceDir, name), 10 * MAX_FILE_BYTES)
    if (!data) { missing.push(name); continue }
    const ref = `${phase}/screenshots/${name}`
    writeOnce(dir, ref, data)
    shots.push(ref)
  }
  let metrics = null
  const runtime = {}
  for (const name of ['summary.json', 'console.json', 'page-errors.json']) {
    const data = sourceDir && readFile(path.join(sourceDir, name))
    if (!data) continue
    try {
      const parsed = JSON.parse(data.toString('utf8'))
      if (name === 'summary.json') metrics = parsed
      else runtime[name] = parsed
    } catch { missing.push(name) }
  }
  writeOnce(dir, `${phase}/metrics.json`, { available: Boolean(metrics), metrics, screenshots: shots, missing })
  writeOnce(dir, `${phase}/runtime.log`, JSON.stringify({ available: Object.keys(runtime).length > 0, ...runtime }, null, 2))
}

function git(repo, args, env = {}, input) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd: repo, env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * MAX_FILE_BYTES,
  })
  if (result.status !== 0) throw new Error('candidate diff unavailable')
  return result.stdout
}

function candidateDiff(repo, baseline) {
  if (!baseline) return { patch: '', complete: false, reason: 'No Git baseline.' }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pulse-shadow-index-'))
  try {
    // An isolated index includes untracked files without touching the builder's index.
    const env = { GIT_INDEX_FILE: path.join(temp, 'index') }
    const excluded = ['reports', '.env', '.env.*', '**/.env', '**/.env.*', '*.pem', '**/*.pem', '*.key', '**/*.key']
    const paths = ['--', '.', ...excluded.map(name => `:(exclude,glob)${name}`)]
    git(repo, ['read-tree', baseline], env)
    const secretPath = name => /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$/i.test(name)
    const files = [...new Set(git(repo, ['ls-files', '-co', '--exclude-standard', '-z'], env).split('\0'))]
      .filter(name => name && name !== 'reports' && !name.startsWith('reports/') && !secretPath(name))
    if (files.length) git(repo, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], env, files.join('\0') + '\0')
    const patch = git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', baseline, ...paths], env)
    const omitted = git(repo, ['diff', '--name-only', '-z', baseline]).split('\0').filter(secretPath)
    const redacted = redact(patch) !== patch
    return { patch, complete: !omitted.length && !redacted, excluded, omitted, redacted }
  } catch { return { patch: '', complete: false, reason: 'Git could not capture the candidate within its size/time limit.' } }
  finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

function filesUnder(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Evidence must not contain symlinks')
    return entry.isDirectory() ? filesUnder(dir, name) : [name]
  }).sort()
}

export function seal(dir, manifestName) {
  const files = Object.fromEntries(filesUnder(dir).map(name => [name, hash(fs.readFileSync(path.join(dir, name)))]))
  const manifest = { schemaVersion: SCHEMA_VERSION, sealedAt: new Date().toISOString(), files }
  writeOnce(dir, manifestName, manifest)
  return hash(fs.readFileSync(path.join(dir, manifestName)))
}

export function verify(dir, manifestName = 'manifest.json') {
  const manifest = readJson(path.join(dir, manifestName))
  if (manifest.schemaVersion !== SCHEMA_VERSION || !manifest.files || !Object.keys(manifest.files).length) throw new Error('Invalid evidence manifest')
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('Invalid evidence reference')
    const file = path.join(dir, name)
    if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== expected) throw new Error('Evidence integrity check failed')
  }
  return { ...manifest, hash: hash(fs.readFileSync(path.join(dir, manifestName))) }
}

export function beginEvidence({ statusPath, status, session, idea, feedback }) {
  const dir = path.join(path.dirname(statusPath), 'shadow', `session-${session.run}-${randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  writeOnce(dir, 'goal.json', {
    schemaVersion: SCHEMA_VERSION, sessionId: path.basename(dir), run: session.run, project: status.project,
    startedAt: session.startedAt, stage: session.stage, baseline: session.baseline,
    mission: idea, goal: session.milestoneBefore?.goal || null, scope: 'milestone-at-session-start',
    sessionGoal: null, sessionGoalNote: 'The builder chooses its session goal during the run; a later claim is not a pre-build commitment.',
  })
  writeOnce(dir, 'acceptance-criteria.json', { source: session.milestoneBefore?.source || null, outcomes: session.milestoneBefore?.outcomes || [] })
  writeOnce(dir, 'before/product.json', { brief: document(status.repo, 'BRIEF.md'), milestone: document(status.repo, 'MILESTONE.md'), hasUi: fs.existsSync(path.join(status.repo, 'index.html')) })
  writeOnce(dir, 'before/reviewer.json', status.lastReview || null)
  writeOnce(dir, 'steering.md', feedback || '')
  captureChecks(dir, 'before', status.repo, session.baselineChecks)
  seal(dir, 'baseline-manifest.json')
  return dir
}

export function captureCandidate({ dir, repo, session, checks, fields, agentExit }) {
  verify(dir, 'baseline-manifest.json')
  const diff = candidateDiff(repo, session.baseline)
  writeOnce(dir, 'diff.patch', diff.patch)
  writeOnce(dir, 'candidate.json', { capturedAt: new Date().toISOString(), agentExit: Number(agentExit), diff: { ...diff, patch: undefined }, builderClaims: fields })
  writeOnce(dir, 'after/product.json', { brief: document(repo, 'BRIEF.md'), milestone: document(repo, 'MILESTONE.md'), hasUi: fs.existsSync(path.join(repo, 'index.html')) })
  captureChecks(dir, 'after', repo, checks)
  seal(dir, 'candidate-manifest.json')
}

export function captureReview(dir, review) {
  verify(dir, 'candidate-manifest.json')
  writeOnce(dir, 'reviewer.json', review)
}

export function finalizeEvidence(dir, actual) {
  verify(dir, 'candidate-manifest.json')
  if (!fs.existsSync(path.join(dir, 'reviewer.json'))) writeOnce(dir, 'reviewer.json', { available: false, reason: 'The current runner did not produce a review for this candidate.' })
  writeOnce(dir, 'actual-incubator-outcome.json', actual)
  return seal(dir, 'manifest.json')
}

export function evidenceState(dir) {
  const manifest = verify(dir)
  const names = ['goal.json', 'acceptance-criteria.json', 'steering.md', 'before/product.json', 'before/checks.json', 'before/metrics.json', 'before/runtime.log', 'before/reviewer.json', 'after/product.json', 'after/checks.json', 'after/metrics.json', 'after/runtime.log', 'diff.patch', 'candidate.json', 'reviewer.json']
  const evidence = {}
  const truncated = []
  for (const name of names) {
    if (!Object.hasOwn(manifest.files, name)) throw new Error('Unsealed evidence')
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    const limit = name === 'diff.patch' ? 14000 : name.endsWith('product.json') ? 5000 : 3500
    if (Buffer.byteLength(text) > limit) {
      evidence[name] = { excerpt: Buffer.from(text).subarray(0, limit).toString('utf8'), truncated: true }
      truncated.push(name)
    } else evidence[name] = name.endsWith('.json') ? JSON.parse(text) : text
  }
  return { schemaVersion: SCHEMA_VERSION, bundleHash: manifest.hash, evidence, truncated }
}
