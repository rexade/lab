import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AI_FIELD_META,
  cachedAiFeedbackForSlot,
  CRITIC_SOURCE_LABEL,
  fetchSavedAiFeedback,
  readAiJson,
  rememberAiFeedbackForSlot,
  requestAiFeedbackRefresh,
  shouldRefreshAiForTrigger,
} from '../lib/critic.js'
import { clip } from '../lib/format.js'
import { Eyebrow } from './ui.jsx'

let criticStatusPromise = null
function criticStatus(fetchImpl) {
  criticStatusPromise ??= fetchImpl('/api/ai/status').then(readAiJson).catch(() => ({}))
  return criticStatusPromise
}

// Saved feedback per slot; switching slots only reads. A refresh happens on an
// explicit click or when a newly completed run bumps `autoTrigger`.
export function useCritic(slotId, autoTrigger = 0, fetchImpl = fetch) {
  const [state, setState] = useState({ analysis: null, savedAt: null, loading: false, error: null })
  const [disabled, setDisabled] = useState(false)
  const cacheRef = useRef({})
  const activeRef = useRef(slotId)
  const triggerRef = useRef({})

  useEffect(() => {
    let cancelled = false
    criticStatus(fetchImpl).then(status => { if (!cancelled && status?.disabled) setDisabled(true) })
    return () => { cancelled = true }
  }, [fetchImpl])

  useEffect(() => {
    activeRef.current = slotId
    let cancelled = false
    const cached = cachedAiFeedbackForSlot(cacheRef.current, slotId)
    setState({ analysis: cached?.analysis ?? null, savedAt: cached?.savedAt ?? null, loading: false, error: null })
    if (!slotId || cached) return undefined
    fetchSavedAiFeedback({ fetchImpl, slotId })
      .then(result => {
        if (cancelled || !result) return
        cacheRef.current = rememberAiFeedbackForSlot(cacheRef.current, slotId, result)
        setState(prev => ({ ...prev, analysis: result.analysis, savedAt: result.savedAt }))
      })
      .catch(err => { if (!cancelled) setState(prev => ({ ...prev, error: err.message })) })
    return () => { cancelled = true }
  }, [slotId, fetchImpl])

  const refresh = async (target = slotId) => {
    if (!target) return
    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const result = await requestAiFeedbackRefresh({ fetchImpl, slotId: target })
      cacheRef.current = rememberAiFeedbackForSlot(cacheRef.current, target, result)
      if (activeRef.current === target) setState({ analysis: result.analysis, savedAt: result.savedAt, loading: false, error: null })
    } catch (err) {
      if (err.disabled) setDisabled(true)
      if (activeRef.current === target) setState(prev => ({ ...prev, loading: false, error: err.disabled ? null : err.message }))
    }
  }

  useEffect(() => {
    if (!slotId) return
    const previous = triggerRef.current[slotId]
    triggerRef.current[slotId] = autoTrigger
    if (previous != null && shouldRefreshAiForTrigger(previous, autoTrigger) && !disabled) refresh(slotId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId, autoTrigger])

  return { ...state, disabled, refresh: () => refresh(slotId) }
}

export function CriticView({ analysis, savedAt, loading, error, disabled, onRefresh, slotId }) {
  const fields = analysis?.fields || {}
  const primary = [AI_FIELD_META[0], AI_FIELD_META[4]]
  return (
    <div data-critic-source="local-ollama-qwen" data-critic-slot={slotId}>
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>{CRITIC_SOURCE_LABEL}</Eyebrow>
        {!disabled && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="focus-ring rounded-[8px] px-2 py-0.5 text-[12px] font-medium text-fg3 transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-40"
            title="Ask the local critic again"
          >
            {loading ? 'Thinking…' : 'Refresh'}
          </button>
        )}
      </div>
      {loading && (
        <motion.div className="mt-3 h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
          <motion.div
            className="h-full w-1/3 rounded-full"
            style={{ background: 'linear-gradient(90deg, transparent, var(--run), transparent)' }}
            animate={{ x: ['-100%', '300%'] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          />
        </motion.div>
      )}
      {error && <p className="mt-2 text-[13px] text-fail">{error}</p>}
      {analysis ? (
        <dl className="mt-3 grid gap-2.5">
          {primary.map(field => (
            <div key={field.key}>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: field.color }}>{field.label}</dt>
              <dd className="mt-0.5 text-[14px] leading-relaxed text-fg2" data-ai-field={field.key}>
                {fields[field.key] ? clip(fields[field.key], 170) : <span className="text-warn">missing from saved response</span>}
              </dd>
            </div>
          ))}
          {analysis.malformed && (
            <details className="text-[12px] text-fg4">
              <summary className="cursor-pointer text-warn">Raw response ({analysis.missing.length} field{analysis.missing.length === 1 ? '' : 's'} missing)</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[10px] bg-black/35 p-2.5 font-mono text-fg3">{analysis.raw}</pre>
            </details>
          )}
          {savedAt && <div className="text-[12px] text-fg4">saved {new Date(savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {analysis.model}</div>}
        </dl>
      ) : (
        <p className="mt-3 text-[14px] leading-relaxed text-fg4">
          {disabled
            ? <>The local critic is off on this Pi. Enable it with <code className="whitespace-nowrap font-mono text-[12px] text-fg3">PI_PULSE_ENABLE_LOCAL_LLM=1</code> and a small local model reviews each run.</>
            : 'No saved critique yet. It refreshes after the next completed run.'}
        </p>
      )}
    </div>
  )
}

export function Critic({ slotId, autoTrigger }) {
  const critic = useCritic(slotId, autoTrigger)
  return <CriticView {...critic} slotId={slotId} onRefresh={critic.refresh} />
}
