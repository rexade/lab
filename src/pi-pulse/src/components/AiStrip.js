import { createElement as h, useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

export const AI_FIELD_META = [
  { key: 'DIRECTION', label: 'Direction', color: 'var(--accent)' },
  { key: 'STRONGEST', label: 'Strongest', color: '#22c55e' },
  { key: 'WEAKEST', label: 'Weakest', color: '#f97316' },
  { key: 'DRIFT', label: 'Drift', color: '#a78bfa' },
  { key: 'NEXT', label: 'Next', color: '#38bdf8' },
]

export const AI_FIELD_KEYS = AI_FIELD_META.map(field => field.key)

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
    lastRun: data.ts ? new Date(data.ts).toLocaleTimeString() : null,
  }
}

export async function requestAiFeedbackRefresh({ fetchImpl = fetch, slotId }) {
  const data = await readAiJson(await fetchImpl(`/api/incubators/${slotId}/ai/analyze`, { method: 'POST' }))
  if (!data.ok) throw new Error(data.error || 'failed')
  return {
    analysis: normalizeAnalysis(data),
    lastRun: data.ts ? new Date(data.ts).toLocaleTimeString() : new Date().toLocaleTimeString(),
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

function iconRefresh() {
  return h('svg', {
    width: 10,
    height: 10,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2.5',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, [
    h('polyline', { key: 'head', points: '23 4 23 10 17 10' }),
    h('path', { key: 'body', d: 'M20.49 15a9 9 0 11-2.12-9.36L23 10' }),
  ])
}

export function AiStripView({
  open = false,
  setOpen = () => {},
  analysis = null,
  slotId = null,
  loading = false,
  error = null,
  lastRun = null,
  onRefresh = () => {},
}) {
  const fields = analysis?.fields || {}
  const preview = fields.DIRECTION || analysis?.raw?.split('\n').find(Boolean) || ''
  const active = loading || !!analysis?.raw
  const incubatorId = analysis?.incubatorId || slotId

  return h('div', { 'data-ai-strip': 'local-ollama-qwen' }, [
    h('div', {
      key: 'header',
      role: 'button',
      tabIndex: 0,
      onClick: () => setOpen(!open),
      onKeyDown: event => {
        if (event.key === 'Enter' || event.key === ' ') setOpen(!open)
      },
      'data-ai-strip-source': 'local-ollama-qwen',
      'data-ai-incubator': incubatorId,
      'aria-label': incubatorId ? `Local Ollama/Qwen feedback for ${incubatorId}` : 'Local Ollama/Qwen feedback',
      style: {
        borderTop: active
          ? '1px solid color-mix(in srgb, #a78bfa 28%, transparent)'
          : '1px solid var(--border)',
        padding: '10px 24px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: active ? 'color-mix(in srgb, #a78bfa 3%, transparent)' : 'transparent',
        transition: 'background 0.5s ease, border-top-color 0.5s ease',
        position: 'relative',
        overflow: 'hidden',
      },
      onMouseEnter: event => {
        event.currentTarget.style.background = active ? 'color-mix(in srgb, #a78bfa 5%, transparent)' : 'rgba(255,255,255,0.02)'
      },
      onMouseLeave: event => {
        event.currentTarget.style.background = active ? 'color-mix(in srgb, #a78bfa 3%, transparent)' : 'transparent'
      },
    }, [
      loading && h(motion.div, {
        key: 'scan',
        initial: { x: '-100%' },
        animate: { x: '240%' },
        transition: { duration: 1.7, repeat: Infinity, ease: 'linear' },
        style: {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: '42%',
          background: 'linear-gradient(90deg, transparent, color-mix(in srgb, #a78bfa 22%, transparent), transparent)',
          pointerEvents: 'none',
        },
      }),
      h('span', {
        key: 'source',
        style: {
          fontSize: '0.6rem',
          fontFamily: 'monospace',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: active ? '#a78bfa' : 'var(--muted)',
          position: 'relative',
        },
      }, 'Local Ollama/Qwen'),
      h(motion.div, {
        key: 'dot',
        animate: analysis ? { opacity: [1, 0.3, 1] } : {},
        transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
        style: {
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: error ? '#ef4444' : analysis?.malformed ? '#f59e0b' : '#22c55e',
          flexShrink: 0,
        },
      }),
      h('span', {
        key: 'preview',
        style: {
          flex: 1,
          fontSize: '0.67rem',
          fontFamily: 'monospace',
          color: !open && preview ? 'rgba(241,245,249,0.55)' : 'rgba(71,85,105,0.4)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, !open && preview
        ? (preview.length > 60 ? `${preview.slice(0, 60)}...` : preview)
        : !open && loading ? 'analyzing...' : !open ? 'ready' : ''),
      h('button', {
        key: 'refresh',
        onClick: event => {
          event.stopPropagation()
          onRefresh()
        },
        disabled: loading,
        title: 'Refresh local Ollama/Qwen analysis',
        style: {
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.18 : 0.32,
          color: 'rgba(148,163,184,1)',
          display: 'flex',
          alignItems: 'center',
          transition: 'opacity 0.2s ease',
          flexShrink: 0,
        },
        onMouseEnter: event => {
          if (!loading) event.currentTarget.style.opacity = '0.72'
        },
        onMouseLeave: event => {
          event.currentTarget.style.opacity = loading ? '0.18' : '0.32'
        },
      }, iconRefresh()),
      h(motion.svg, {
        key: 'chevron',
        animate: { rotate: open ? 180 : 0 },
        transition: { duration: 0.2 },
        width: 10,
        height: 10,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'rgba(71,85,105,0.5)',
        strokeWidth: '2.5',
        strokeLinecap: 'round',
        style: { flexShrink: 0 },
      }, h('polyline', { points: '6 9 12 15 18 9' })),
    ]),
    h(motion.div, {
      key: 'body',
      initial: false,
      animate: { height: open ? 'auto' : 0, opacity: open ? 1 : 0 },
      transition: { height: { duration: 0.22, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.15 } },
      style: { overflow: 'hidden' },
    }, h('div', { style: { padding: '4px 24px 16px' } }, [
      error && h('div', {
        key: 'error',
        style: { display: 'flex', gap: 6, alignItems: 'center', padding: '5px 0 4px' },
      }, [
        h('div', { key: 'dot', style: { width: 5, height: 5, borderRadius: '50%', background: '#ef4444', flexShrink: 0 } }),
        h('span', { key: 'text', style: { fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(248,113,113,0.8)' } }, error),
      ]),
      ...AI_FIELD_META.map((field, index) => h('div', {
        key: field.key,
        style: {
          display: 'flex',
          gap: 12,
          alignItems: loading ? 'center' : 'flex-start',
          padding: '6px 0',
          borderBottom: index < AI_FIELD_META.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
        },
      }, [
        h('span', {
          key: 'label',
          style: {
            fontSize: '0.57rem',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 600,
            color: field.color,
            minWidth: 68,
            flexShrink: 0,
            opacity: (!analysis && !loading) ? 0.4 : 1,
          },
        }, field.label),
        loading
          ? h('div', { key: 'loading', className: 'animate-pulse', style: { height: 7, flex: 1, background: 'rgba(255,255,255,0.07)', borderRadius: 3 } })
          : h('span', {
            key: 'value',
            'data-ai-field': field.key,
            style: {
              fontSize: '0.78rem',
              fontFamily: 'monospace',
              lineHeight: 1.5,
              color: fields[field.key] ? 'rgba(241,245,249,0.85)' : analysis?.malformed ? 'rgba(245,158,11,0.72)' : 'rgba(71,85,105,0.32)',
            },
          }, fields[field.key] ?? (analysis?.malformed ? 'missing from saved response' : '-')),
      ])),
      analysis?.malformed && h('div', {
        key: 'raw',
        style: {
          marginTop: 8,
          border: '1px solid rgba(245,158,11,0.18)',
          background: 'rgba(245,158,11,0.05)',
          borderRadius: 6,
          padding: '8px 10px',
        },
      }, [
        h('div', {
          key: 'label',
          style: { fontSize: '0.56rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(245,158,11,0.8)', marginBottom: 6 },
        }, 'raw local qwen response'),
        h('pre', {
          key: 'text',
          style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.68rem', lineHeight: 1.45, fontFamily: 'monospace', color: 'rgba(241,245,249,0.72)', maxHeight: 160, overflow: 'auto' },
        }, analysis.raw),
      ]),
      lastRun && !loading && h('div', {
        key: 'saved',
        style: { paddingTop: 7, borderTop: '1px solid rgba(255,255,255,0.04)', marginTop: 2 },
      }, h('span', {
        style: { fontSize: '0.59rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)' },
      }, `saved ${lastRun} | local Ollama/Qwen | ${analysis?.model}`)),
    ])),
  ])
}

export function AiStrip({ slotId, autoTrigger, fetchImpl = fetch }) {
  const [open, setOpen] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const feedbackCacheRef = useRef({})
  const activeSlotRef = useRef(slotId)
  const prevTriggerBySlotRef = useRef({})
  const refreshRequestRef = useRef(0)

  useEffect(() => {
    activeSlotRef.current = slotId
  }, [slotId])

  useEffect(() => {
    let cancelled = false
    refreshRequestRef.current += 1
    setLoading(false)
    setError(null)
    if (!slotId) return undefined
    const cached = cachedAiFeedbackForSlot(feedbackCacheRef.current, slotId)
    if (cached) {
      setAnalysis(cached.analysis)
      setLastRun(cached.lastRun)
      return undefined
    }
    setAnalysis(null)
    setLastRun(null)
    fetchSavedAiFeedback({ fetchImpl, slotId })
      .then(result => {
        if (cancelled || !result) return
        feedbackCacheRef.current = rememberAiFeedbackForSlot(feedbackCacheRef.current, slotId, result)
        setAnalysis(result.analysis)
        setLastRun(result.lastRun)
      })
      .catch(err => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [slotId, fetchImpl])

  useEffect(() => {
    if (!slotId) return
    const prev = prevTriggerBySlotRef.current[slotId] ?? 0
    if (shouldRefreshAiForTrigger(prev, autoTrigger) && !loading) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
      runAnalysis(slotId)
    } else if (autoTrigger > prev) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
    } else if (prevTriggerBySlotRef.current[slotId] == null) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
    }
  }, [slotId, autoTrigger])

  async function runAnalysis(targetSlotId = slotId) {
    if (!targetSlotId) return
    const requestId = ++refreshRequestRef.current
    setLoading(true)
    setError(null)
    setOpen(true)
    try {
      const result = await requestAiFeedbackRefresh({ fetchImpl, slotId: targetSlotId })
      feedbackCacheRef.current = rememberAiFeedbackForSlot(feedbackCacheRef.current, targetSlotId, result)
      if (activeSlotRef.current === targetSlotId) {
        setAnalysis(result.analysis)
        setLastRun(result.lastRun)
      }
    } catch (err) {
      if (activeSlotRef.current === targetSlotId) setError(err.message)
    } finally {
      if (refreshRequestRef.current === requestId) setLoading(false)
    }
  }

  return h(AiStripView, {
    open,
    setOpen,
    analysis,
    slotId,
    loading,
    error,
    lastRun,
    onRefresh: runAnalysis,
  })
}
