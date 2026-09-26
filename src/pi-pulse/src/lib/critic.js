// Local Ollama/Qwen critic: saved per incubator, read on selection, refreshed
// only on an explicit request or after a newly completed run.
export const AI_FIELD_META = [
  { key: 'DIRECTION', label: 'Direction', color: 'var(--accent)' },
  { key: 'STRONGEST', label: 'Strongest', color: '#34d399' },
  { key: 'WEAKEST', label: 'Weakest', color: '#fb923c' },
  { key: 'DRIFT', label: 'Drift', color: '#a78bfa' },
  { key: 'NEXT', label: 'Next', color: '#38bdf8' },
]

export const AI_FIELD_KEYS = AI_FIELD_META.map(field => field.key)
export const CRITIC_SOURCE_LABEL = 'Local Ollama/Qwen'

export function normalizeAnalysis(data = {}) {
  const raw = String(data.response || data.raw || '').trim()
  const fields = data.fields && typeof data.fields === 'object' ? data.fields : {}
  const missing = Array.isArray(data.missing) ? data.missing : AI_FIELD_KEYS.filter(key => !fields[key])
  return {
    fields,
    missing,
    raw,
    malformed: typeof data.malformed === 'boolean' ? data.malformed : (!!raw && missing.length > 0),
    model: data.model || 'qwen2.5-instruct:1.5b',
    source: data.source || 'local-ollama-qwen',
    incubatorId: data.incubatorId,
    project: data.project,
  }
}

export async function readAiJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('AI feedback API returned HTML, not JSON')
  }
}

export async function fetchSavedAiFeedback({ fetchImpl = fetch, slotId }) {
  if (!slotId) return null
  const data = await readAiJson(await fetchImpl(`/api/incubators/${slotId}/ai/latest`))
  if (!data.ok || !data.response) return null
  return {
    analysis: normalizeAnalysis(data),
    savedAt: data.ts ?? null,
  }
}

export async function requestAiFeedbackRefresh({ fetchImpl = fetch, slotId }) {
  const data = await readAiJson(await fetchImpl(`/api/incubators/${slotId}/ai/analyze`, { method: 'POST' }))
  if (!data.ok) {
    const err = new Error(data.error || 'local critic failed')
    err.disabled = data.code === 'LOCAL_LLM_DISABLED'
    throw err
  }
  return {
    analysis: normalizeAnalysis(data),
    savedAt: data.ts ?? Date.now(),
  }
}

export function rememberAiFeedbackForSlot(cache = {}, slotId, result) {
  if (!slotId || !result?.analysis) return cache
  return { ...cache, [slotId]: result }
}

export function cachedAiFeedbackForSlot(cache = {}, slotId) {
  return slotId ? cache[slotId] || null : null
}

export function shouldRefreshAiForTrigger(previousTrigger, autoTrigger) {
  return Number(autoTrigger || 0) > Number(previousTrigger ?? 0)
}
