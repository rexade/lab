// Local critic: a small Ollama/Qwen model that reads MemPalace context plus the
// tail of a run log and writes DRIFT_FEEDBACK.{md,json} next to the project.
// Commentary, not verdict. Disabled unless PI_PULSE_ENABLE_LOCAL_LLM=1.
import fs from 'fs'
import { execFile } from 'child_process'
import { dirname } from 'path'
import { aiFeedbackPayload, hydrateAiFeedback } from '../server-core.js'
import { AI_MODEL, HAILO_URL, LOCAL_LLM_ENABLED, MEMPALACE_BIN, MEMPALACE_HOME, RUN_LOG_PATH } from './config.js'
import { feedbackPathsForIncubator, findIncubatorSlot, readStatusAt } from './incubator-store.js'

export function localLlmDisabledPayload(scope = 'core') {
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

export async function localLlmStatus() {
  if (!LOCAL_LLM_ENABLED) return localLlmStatusPayload()
  try {
    const r = await fetch(`${HAILO_URL}/api/tags`)
    const data = await r.json()
    const loaded = data.models?.some(m => m.name?.includes('qwen2.5-instruct'))
    return { available: true, modelLoaded: loaded, models: data.models }
  } catch {
    return { available: false, modelLoaded: false }
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
    const raw = await execFileText(MEMPALACE_BIN, args, {
      timeout: 10000,
      env: { ...process.env, HOME: MEMPALACE_HOME },
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

// 'core' is the host lab loop; any other id is an incubator slot.
export function aiTargetForIncubator(id) {
  if (id === 'core') {
    return {
      id: 'core',
      project: 'pi-pulse',
      runLog: RUN_LOG_PATH,
      paths: feedbackPathsForIncubator({ project: 'pi-pulse' }),
      query: 'pi-pulse incubator host seed direction active threads',
    }
  }

  const slot = findIncubatorSlot(id)
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

export function readCachedAiFeedback(target) {
  const data = JSON.parse(fs.readFileSync(target.paths.json, 'utf8'))
  return hydrateAiFeedback(data, target)
}

// Returns { status, body } so routes stay one-liners.
export async function analyzeAiTarget(target, scope = 'incubator') {
  if (!LOCAL_LLM_ENABLED) return { status: 503, body: localLlmDisabledPayload(scope) }
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
    if (!r.ok) return { status: 502, body: { ok: false, error: await r.text() } }

    const data = await r.json()
    const payload = aiFeedbackPayload({
      incubatorId: target.id,
      project: target.project,
      response: data.response,
      model: AI_MODEL,
    })
    // Persist so the next run (and the UI) can read it without regenerating.
    try {
      fs.mkdirSync(dirname(target.paths.json), { recursive: true })
      const ts = new Date(payload.ts).toISOString().slice(0, 16).replace('T', ' ')
      fs.writeFileSync(target.paths.md, `# Local Ollama/Qwen Feedback - ${ts}\n\n${data.response.trim()}\n`)
      fs.writeFileSync(target.paths.json, JSON.stringify(payload, null, 2) + '\n')
    } catch { /* non-fatal */ }

    return { status: 200, body: payload }
  } catch (err) {
    return { status: 500, body: { ok: false, error: err.message } }
  }
}
