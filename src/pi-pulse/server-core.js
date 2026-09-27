import fs from 'fs'
import { execSync } from 'child_process'
import { dirname, join, resolve, relative, isAbsolute } from 'path'

// Retired full model ids fail every run, so they are never pinned. Aliases
// (sonnet, opus, fable, ...) resolve inside the Claude CLI and stay user choices.
export const RETIRED_CLAUDE_MODELS = new Set(['claude-sonnet-4-20250514'])
export const SAFE_CLAUDE_MODEL = 'sonnet'
// `claude -p` starts in the prompting mode, and a headless run has nobody to
// answer, so edits and shell commands are denied unless a mode is named.
export const CLAUDE_PERMISSION_MODES = ['auto', 'acceptEdits', 'dontAsk', 'default', 'plan']
export const DEFAULT_CLAUDE_PERMISSION_MODE = 'auto'
export const AI_FIELD_KEYS = ['DIRECTION', 'STRONGEST', 'WEAKEST', 'DRIFT', 'NEXT']

const AI_FIELD_ALIASES = {
  'NEXT MOVE': 'NEXT',
  'NEXT ACTION': 'NEXT',
  'THE NEXT BEST ACTION': 'NEXT',
  'SUGGESTED NEXT MOVE': 'NEXT',
  'STRONGEST SIGNAL': 'STRONGEST',
  'WEAKEST SIGNAL': 'WEAKEST',
  'WEAKNESS': 'WEAKEST',
}

export function parseAiFeedback(text = '') {
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

export function aiFeedbackPayload({ response, model, incubatorId = 'core', project = 'pi-pulse', ts = Date.now(), source = 'local-ollama-qwen' }) {
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

export function hydrateAiFeedback(data, target = {}) {
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

export function readinessCheck(id, label, ok, detail, path = null) {
  return { id, label, ok: !!ok, detail, ...(path ? { path } : {}) }
}

export function checkPath(id, label, targetPath, kind = 'file') {
  if (!targetPath) return readinessCheck(id, label, false, 'missing path')
  try {
    const st = fs.statSync(targetPath)
    const typeOk = kind === 'dir' ? st.isDirectory() : st.isFile()
    return readinessCheck(id, label, typeOk, typeOk ? 'ok' : `not a ${kind}`, targetPath)
  } catch (err) {
    return readinessCheck(id, label, false, err.code === 'ENOENT' ? 'not found' : err.message, targetPath)
  }
}

export function checkWritableLog(id, label, logPath) {
  if (!logPath) return readinessCheck(id, label, false, 'missing run log path')
  const parent = dirname(logPath)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
    return readinessCheck(id, label, true, fs.existsSync(logPath) ? 'ok' : 'will create on first write', logPath)
  } catch (err) {
    return readinessCheck(id, label, false, err.code === 'ENOENT' ? 'log directory not found' : err.message, logPath)
  }
}

export function checkCommand(id, command, fallbackPath = null) {
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

export function checkClaudeCommand(id = 'binary') {
  return checkCommand(id, 'claude', process.env.CLAUDE_BIN || '/home/admin/.npm-global/bin/claude')
}

export function isRunnableClaudeModel(model) {
  return !!model && !RETIRED_CLAUDE_MODELS.has(model)
}

export function firstRunnableClaudeModel(...candidates) {
  return candidates.find(model => isRunnableClaudeModel(model)) || null
}

export function resolveCodexReasoningEffort(saved, env = process.env) {
  const value = saved || env.PI_PULSE_CODEX_REASONING_EFFORT || 'high'
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : 'high'
}

export function resolveClaudeModel(saved, env = process.env) {
  return firstRunnableClaudeModel(saved, env.CLAUDE_MODEL, env.DEFAULT_CLAUDE_MODEL, env.PI_PULSE_DEFAULT_CLAUDE_MODEL, SAFE_CLAUDE_MODEL)
}

export function resolveClaudePermissionMode(saved, env = process.env) {
  return [saved, env.CLAUDE_PERMISSION_MODE].find(mode => CLAUDE_PERMISSION_MODES.includes(mode)) || DEFAULT_CLAUDE_PERMISSION_MODE
}

// The UI appends each steering note as a `## <ISO timestamp>` section; `## Seed`
// holds the original idea, not feedback. Other `## ` lines belong to a note's
// own markdown. Returns the newest note's body, or '' when there is none.
export function latestSteeringNote(text = '') {
  let latest = ''
  for (const chunk of String(text).split(/^(?=## (?:Seed\s*$|\d{4}-\d{2}-\d{2}))/im)) {
    const match = chunk.match(/^## (.*)\n([\s\S]*)$/)
    if (match && !/^seed$/i.test(match[1].trim()) && match[2].trim()) latest = match[2].trim()
  }
  return latest
}

export function checkClaudeModel(model, allowCliDefault = false) {
  if (!model && allowCliDefault) {
    return readinessCheck('model', 'Claude model', true, 'Claude CLI default')
  }
  if (!isRunnableClaudeModel(model)) {
    return readinessCheck('model', 'Claude model', false, model ? `${model} is not a runnable Claude model` : 'missing Claude model')
  }
  return readinessCheck('model', 'Claude model', true, model)
}

// `sessionRun`: incubator sessions build their prompt in code, so prompt files
// are only required by the core lab loop (run-lab.sh).
export function preflightRunConfig({ id, project, runner, runScript, relayScript = null, launcher = null, repo, runLog, statusPath, promptDir, runTypes, runType, claudeModel, allowClaudeDefaultModel = false, sessionRun = false }) {
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
    if (!sessionRun) {
      checks.push(checkPath('promptDir', 'prompt directory', promptDir, 'dir'))
      checks.push(checkPath('prompt', `${selectedRunType} prompt`, promptDir ? join(promptDir, `${selectedRunType}.md`) : null))
    }
  } else if (selectedRunner === 'claude') {
    const selectedRunType = runType || runTypes?.[0] || 'mutate'
    if (relayScript && relayScript !== runScript) {
      checks.push(checkPath('relayScript', 'Claude relay script', relayScript))
    }
    checks.push(checkClaudeCommand())
    checks.push(checkClaudeModel(claudeModel, allowClaudeDefaultModel))
    if (!sessionRun && (promptDir || runScript?.includes('run-claude-incubator.sh'))) {
      checks.push(checkPath('promptDir', 'prompt directory', promptDir, 'dir'))
      checks.push(checkPath('prompt', `${selectedRunType} prompt`, promptDir ? join(promptDir, `${selectedRunType}.md`) : null))
    }
  }

  const ok = checks.every(c => c.ok)
  return {
    ok,
    id,
    project,
    runner: selectedRunner,
    launcher,
    relayScript,
    checks,
    error: ok ? null : checks.find(c => !c.ok)?.detail || 'runner preflight failed',
  }
}

// Picks the most telling line from output that is already known to be a failure.
const FAILURE_SIGNAL_RE = /api error|command not found|not found|enoent|permission denied|exit status|exit \d+|exited \d+|(?:^|[\s:[({-])(?:error|failed|failure)(?:$|[\s:\])},.!-])/i

function firstFailureSignalLine(lines) {
  return lines.find(line => FAILURE_SIGNAL_RE.test(line)) || ''
}

// Classifying output as a failure needs evidence, not vocabulary: a CLI that
// dies prints its error first, while a successful transcript that discusses
// error handling (or quotes a seed about failed runs) must stay a success.
const CLI_ERROR_RE = /^(?:api error\b|error:|fatal:|npm err!|traceback \(most recent call last\)|there's an issue with the selected model)|command not found|\benoent\b|permission denied|exit status [1-9]\d*|\bexited (?:with )?(?:code )?[1-9]\d*/i
const LEADING_LINE_LIMIT = 3

export function leadingFailureLine(lines = []) {
  return lines.slice(0, LEADING_LINE_LIMIT).find(line => CLI_ERROR_RE.test(line)) || ''
}

export function capturedFailureDetail(capturePath, maxChars = 1200) {
  try {
    const lines = fs.readFileSync(capturePath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    const commandError = firstFailureSignalLine(lines)
    const tail = lines.slice(-8).join('\n')
    return [
      commandError && !tail.includes(commandError) ? commandError : '',
      tail,
    ].filter(Boolean).join('\n').slice(0, maxChars)
  } catch {
    return ''
  }
}

export function appendFailedRunEntry({ runLogPath, capturePath, code, signal, num, reason: explicitReason = null }) {
  if (!runLogPath || !num) return
  const detail = capturedFailureDetail(capturePath, 420).replace(/\n+/g, ' | ')
  const date = new Date().toISOString().slice(0, 10)
  const reason = explicitReason || (signal ? `signal ${signal}` : `exit ${code}`)
  const block = [
    '',
    `<!-- stdout from run ${num} ${date} server-captured -->`,
    `[run failed - ${reason}] ${detail || 'no output before exit'}`,
    `**Run ${num} - FAILED - server capture**`,
    '',
  ].join('\n')
  try { fs.appendFileSync(runLogPath, block) } catch { /* log dir may not exist */ }
}

export function preflightFailureDetail(preflight) {
  const failedChecks = preflight?.checks
    ?.filter(c => !c.ok)
    .map(c => `${c.label}: ${c.detail}${c.path ? ` (${c.path})` : ''}`)
    ?? []
  return [preflight?.error, ...failedChecks]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200)
}

export function appendFailedPreflightEntry({ runLogPath, preflight, num, source = 'scheduled-preflight', label = 'scheduled preflight' }) {
  if (!runLogPath || !num) return
  const date = new Date().toISOString().slice(0, 10)
  const detail = preflightFailureDetail(preflight) || 'runner preflight failed'
  const command = preflight?.command ? `Launch command: ${preflight.command}` : ''
  const lines = [
    '',
    `<!-- stdout from run ${num} ${date} ${source} -->`,
    `[run failed - ${label}]`,
    ...(command ? [command] : []),
    detail,
    `**Run ${num} - FAILED - ${label}**`,
    '',
  ]
  const block = lines.join('\n')
  try { fs.appendFileSync(runLogPath, block) } catch { /* log dir may not exist */ }
}

function isStdoutPathOnly(value = '') {
  return /^Full stdout saved to\s+\S+\s*$/i.test(String(value || '').trim())
}

export function summarizeRun(run) {
  const syntheticDone = /^(Claude|Codex) completed but did not append a run summary\.$/.test(run.Done || '')
  if (syntheticDone && run['Output excerpt'] && !isStdoutPathOnly(run['Output excerpt'])) {
    return run['Output excerpt']
  }
  const done = syntheticDone ? '' : run.Done
  return run['Failure'] || run['Error'] || run['Goal'] || done ||
    run['What I investigated'] || run['Investigated'] || run['What I built'] ||
    run['What I changed'] || run['What changed'] || run['What improved'] || run['What I found'] ||
    run['Finding'] || run['Key finding'] || (!isStdoutPathOnly(run['Output excerpt']) ? run['Output excerpt'] : '') || run['Stdout tail'] ||
    (!isStdoutPathOnly(run.Output) ? run.Output : '') || run['Suggested next move'] || run['Next move'] || run.Done || ''
}

export function normalizeQualityGate(value = '') {
  const raw = String(value || '').trim().toUpperCase().replace(/[_.\s]+/g, '-')
  if (!raw) return null
  if (raw.startsWith('PASS')) return 'PASS'
  if (raw.startsWith('FAIL')) return 'FAIL'
  if (raw.includes('NEEDS-EVIDENCE') || raw.includes('NEED-EVIDENCE') || raw.includes('INSUFFICIENT-EVIDENCE')) return 'NEEDS-EVIDENCE'
  return null
}

export function parseQualityScore(value = '') {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/)
  if (!match) return null
  const score = Number(match[1])
  return Number.isFinite(score) ? Math.max(0, Math.min(5, score)) : null
}

export function qualityStateFromRun(run = {}, runnerOk = true) {
  const failed = !runnerOk || run?.type === 'FAILED'
  const explicitGate = normalizeQualityGate(run['Quality gate'] || run['Quality Gate'] || run.Gate)
  const gate = failed ? 'FAIL' : explicitGate || 'NEEDS-EVIDENCE'
  const qualityRating = parseQualityScore(run['Quality rating'] || run['State rating'] || run.Rating)
  const evidenceConfidence = parseQualityScore(run['Evidence confidence'] || run['Evidence Confidence'] || run.Confidence)
  const summary = run['Evidence'] || run['Acceptance check'] || run['Risk / regression'] || summarizeRun(run) || (explicitGate ? '' : 'Latest run did not report a quality gate.')
  const lastRunStatus = failed
    ? 'failed'
    : gate === 'PASS'
      ? 'ok'
      : gate === 'FAIL'
        ? 'quality-failed'
        : 'needs-evidence'

  return {
    lastRunnerStatus: runnerOk ? 'ok' : 'failed',
    lastRunStatus,
    lastQualityGate: gate,
    lastQualityRating: qualityRating,
    lastEvidenceConfidence: evidenceConfidence,
    lastQualitySummary: summary ? String(summary).slice(0, 360) : null,
  }
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

function isStdoutInventoryLine(line) {
  return /^\.?\/?node_modules\/\S+$/.test(line)
}

function meaningfulStdoutLines(body) {
  return body.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !isStdoutInventoryLine(l))
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

function stdoutFailureSignal(lines) {
  const detailLines = lines.filter(l =>
    !l.startsWith('[run failed') &&
    !l.startsWith('**Run') &&
    !l.startsWith('---') &&
    !l.startsWith('```')
  )
  return firstFailureSignalLine(detailLines)
    || detailLines[0]
    || ''
}

function plainFormalSummary(lines) {
  const paragraphs = []
  let current = []
  const flush = () => {
    if (current.length) {
      paragraphs.push(current.join(' '))
      current = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('<!--')) break
    if (!line) {
      flush()
      continue
    }
    if (
      line === '---' ||
      line.startsWith('```') ||
      /^#{1,6}\s+/.test(line) ||
      /^\*\*(.+?):\*\*/.test(line)
    ) {
      flush()
      continue
    }
    current.push(line.replace(/^[-*]\s+/, ''))
  }
  flush()

  return paragraphs.find(Boolean)?.slice(0, 520) || ''
}

function parseRunHeader(line = '') {
  const header = String(line).replace(/^##\s+/, '').trim()
  let m = header.match(/^Run\s+(\d+)\s+[\u2014-]\s+(\d{4}-\d{2}-\d{2})(?:\s+[\u2014-]\s+(.+))?$/i)
  if (m) {
    return {
      num: parseInt(m[1]) || 0,
      date: m[2],
      type: normalizeRunType(m[3]),
    }
  }

  m = header.match(/^(\d{4}-\d{2}-\d{2})\s+[\u2014-]\s+Run\s+(\d+)(?:\s+(.+))?$/i)
  if (m) {
    return {
      num: parseInt(m[2]) || 0,
      date: m[1],
      type: normalizeRunType(m[3]),
    }
  }

  return null
}

function isNoSummarySyntheticRun(run = {}) {
  return /^(Claude|Codex) completed but did not append a run summary\.$/.test(run.Done || '')
}

function formalFailureDetail(fields) {
  const detailKeys = ['Failure', 'Error', 'Output excerpt', 'Output', 'Stdout tail', 'Next move']
  return detailKeys
    .filter(key => fields[key])
    .map(key => `${key}: ${fields[key]}`)
    .join('\n')
    .slice(0, 1200)
}

function stdoutPathFromOutputField(value = '') {
  const match = String(value).match(/Full stdout saved to\s+(\S+)/i)
  if (!match) return null
  const filePath = match[1].trim().replace(/[.)\]]+$/, '')
  return filePath.startsWith('/') ? filePath : null
}

function pathInside(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false
  const target = resolve(String(targetPath))
  const root = resolve(String(rootPath))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeStdoutRoots(roots = []) {
  const out = []
  for (const root of roots || []) {
    if (!root) continue
    try { out.push(fs.realpathSync(root)) } catch { out.push(resolve(String(root))) }
  }
  return out
}

function readTrustedStdoutTail(stdoutPath, { stdoutRoots = [], stdoutMaxBytes = 64 * 1024 } = {}) {
  const roots = safeStdoutRoots(stdoutRoots)
  if (!roots.length) return null
  const lstat = fs.lstatSync(stdoutPath)
  if (!lstat.isFile() || lstat.isSymbolicLink()) return null
  const realPath = fs.realpathSync(stdoutPath)
  if (!roots.some(root => pathInside(realPath, root))) return null
  const stat = fs.statSync(realPath)
  if (!stat.isFile()) return null
  const maxBytes = Math.max(1024, Math.min(256 * 1024, Number(stdoutMaxBytes) || 64 * 1024))
  if (stat.size <= maxBytes) return fs.readFileSync(realPath, 'utf8')
  const fd = fs.openSync(realPath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function hydrateFormalStdoutFields(fields, options = {}) {
  const stdoutPath = [
    fields.Output,
    fields['Output excerpt'],
    fields['Stdout tail'],
    fields.detail,
  ].map(stdoutPathFromOutputField).find(Boolean)
  if (!stdoutPath) return fields

  try {
    const stdoutText = readTrustedStdoutTail(stdoutPath, options)
    if (!stdoutText) return fields
    const lines = meaningfulStdoutLines(stdoutText)
    if (!lines.length) return fields

    const failureSignal = leadingFailureLine(lines)
    const excerpt = (failureSignal || lines.slice(0, 6).join(' ')).slice(0, 420)
    const tail = lines.slice(-10).join('\n').slice(0, 1200)
    const excerptIsOnlyPath = stdoutPathFromOutputField(fields['Output excerpt'])
    if ((!fields['Output excerpt'] || fields['Output excerpt'] === 'no stdout captured' || excerptIsOnlyPath) && excerpt) {
      fields['Output excerpt'] = excerpt
    }
    if (tail) fields['Stdout tail'] = tail
    if (failureSignal && !fields.Failure) fields.Failure = failureSignal
  } catch {
    // The stdout file may have been rotated or copied from another machine.
  }

  return fields
}

function summaryFieldForType(type = '') {
  const normalized = String(type).toUpperCase()
  if (normalized.includes('RESEARCH')) return 'What I found'
  if (normalized.includes('CREATE')) return 'What I built'
  if (normalized.includes('FAILED')) return 'Failure'
  if (normalized.includes('RUN')) return 'Done'
  return 'What I changed'
}

function normalizeRunType(type = '') {
  const rawType = String(type || '').trim().toUpperCase()
  return ['MUTATE', 'RESEARCH', 'CREATE', 'RUN', 'FAILED'].find(t => rawType.includes(t)) || rawType || 'RUN'
}

function parseStdoutRunBlocks(content, runs, { legacyOffset = false } = {}) {
  const stdoutRe = /^\s*<!--\s*stdout from (codex\s+)?run (\d+)\s+(\d{4}-\d{2}-\d{2})[^>]*-->([\s\S]*?)(?=^\s*<!--\s*stdout from (?:codex\s+)?run \d|^\s*## Run \d|$(?![\s\S]))/gm
  let m
  while ((m = stdoutRe.exec(content)) !== null) {
    const [, codexMarker, slotStr, date, body] = m
    const lines = meaningfulStdoutLines(body)
    // Runners and the server write the marker as the first line; a later
    // `[run failed` is a successful transcript quoting an older failure.
    const explicitFailureLine = lines[0]?.startsWith('[run failed') ? lines[0] : null
    const explicitSuccess = lines[0]?.startsWith('[run completed')
    const boldRun = body.match(/\*\*Run (\d+)\s*(?:[\u2014-]\s*([\w ]+?)\s*[\u2014-]|\s*[\u2014-]\s*done)/)
    const boldType = normalizeRunType(boldRun?.[2])
    const implicitFailureLine = explicitFailureLine || explicitSuccess ? null : leadingFailureLine(lines)
    const failureLine = explicitFailureLine || implicitFailureLine
    const failed = Boolean(failureLine) || boldType === 'FAILED'
    const num = boldRun ? parseInt(boldRun[1]) : parseInt(slotStr) + (!codexMarker && legacyOffset ? 1 : 0)
    if (!num) continue

    const type = failed ? 'FAILED' : boldType
    const detailLine = failed ? stdoutFailureSignal(lines) : lines.find(l =>
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

function parseFormalRunBlocks(content, options = {}) {
  const runs = []
  const formalContent = content.replace(
    /^\s*<!--\s*stdout from [^>]*-->[\s\S]*?(?=^\s*<!--\s*stdout from |^\s*## Run \d|$(?![\s\S]))/gm,
    block => block.replace(/[^\n]/g, ' ')
  )
  const sections = formalContent
    .split(/(?=^##\s+(?:Run\s+\d+|\d{4}-\d{2}-\d{2}\s+[\u2014-]\s+Run\s+\d+))/m)
    .filter(s => /^##\s+(?:Run\s+\d+|\d{4}-\d{2}-\d{2}\s+[\u2014-]\s+Run\s+\d+)/m.test(s.trimStart()))
  let searchFrom = 0
  for (const block of sections) {
    const order = formalContent.indexOf(block, searchFrom)
    if (order >= 0) searchFrom = order + block.length
    const lines = block.split('\n')
    const header = parseRunHeader(lines[0])
    if (!header?.num) continue
    const { num: n, date, type } = header
    const fields = {}
    for (const line of lines.slice(1)) {
      if (line.startsWith('<!--')) break
      const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/)
      if (m) fields[m[1]] = m[2]
    }
    hydrateFormalStdoutFields(fields, options)
    const failureSignal = type === 'FAILED'
      ? ''
      : firstFailureSignalLine([fields['Failure']].filter(Boolean)) ||
        leadingFailureLine([fields['Error'], fields['Output excerpt']].filter(Boolean))
    const finalType = failureSignal ? 'FAILED' : type
    if (failureSignal && !fields.Failure) fields.Failure = failureSignal
    const plainSummary = summarizeRun(fields) ? '' : plainFormalSummary(lines.slice(1))
    if (plainSummary) fields[summaryFieldForType(type)] = plainSummary
    if (finalType === 'FAILED' && !fields.detail) fields.detail = formalFailureDetail(fields)
    const run = { num: n, date, type: finalType, ...fields, _order: order >= 0 ? order : runs.length, _source: 'formal' }
    run.signature = runSignature(run)
    runs.push(run)
  }
  return runs
}

function dropSyntheticNoSummaryDuplicates(runs) {
  const meaningful = new Set()
  for (const run of runs) {
    if (isNoSummarySyntheticRun(run)) continue
    if (!summarizeRun(run)) continue
    meaningful.add(`${run.num ?? ''}|${run.date ?? ''}`)
  }

  return runs.filter(run => {
    if (!isNoSummarySyntheticRun(run)) return true
    return !meaningful.has(`${run.num ?? ''}|${run.date ?? ''}`)
  })
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

export function parseRunsFromLog(content, options = {}) {
  const runs = parseFormalRunBlocks(content, options)
  parseStdoutRunBlocks(content, runs, options)
  const sortedRuns = runs.sort((a, b) => (a._order ?? 0) - (b._order ?? 0))
  return annotateRunAttempts(dedupeCopiedRuns(dropSyntheticNoSummaryDuplicates(sortedRuns))).map(publicRun)
}

function isRecoveredAfterFailure(run) {
  if (!run || run.type === 'FAILED') return false
  const gate = String(run['Quality gate'] || '').toUpperCase()
  return gate === 'PASS' || ['CREATE', 'MUTATE', 'RESEARCH', 'HARVEST', 'SHAPE', 'DEVELOP', 'BUILD', 'POLISH'].includes(run.type)
}

function shouldPinFailure(runs = [], failure, recent) {
  if (!failure || recent.includes(failure)) return false
  const failureIndex = runs.indexOf(failure)
  if (failureIndex < 0) return false
  return !runs.slice(failureIndex + 1).some(isRecoveredAfterFailure)
}

export function runsWithPinnedLatestFailure(runs = [], limit = 10) {
  const recent = runs.slice(-limit)
  const latestFailure = [...runs].reverse().find(run => run?.type === 'FAILED')
  if (!shouldPinFailure(runs, latestFailure, recent)) return recent
  return [latestFailure, ...recent]
}
