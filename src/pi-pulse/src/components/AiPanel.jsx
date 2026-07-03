import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

const KEY_MAP = {
  DIRECTION: ['direction', 'dir', 'duration', 'heading'],
  STRONGEST: ['strongest', 'strong', 'best', 'winning'],
  WEAKEST:   ['weakest', 'weak', 'worst', 'problem'],
  DRIFT:     ['drift', 'drifting'],
  NEXT:      ['next', 'mutate', 'suggested', 'suggestion', 'move', 'priority'],
}

function parseAnalysis(text) {
  const fields = {}
  const cleaned = text.replace(/\*\*/g, '').replace(/\r/g, '')
  const re = /([A-Z]{2,}[A-Z\s]*):\s*\n?([\s\S]*?)(?=\n[A-Z]{2,}[A-Z\s]*:|$)/g
  let m
  while ((m = re.exec(cleaned)) !== null) {
    const rawKey = m[1].trim().toLowerCase()
    const value = m[2].trim().replace(/\n+/g, ' ')
    if (!value) continue
    for (const [canonical, aliases] of Object.entries(KEY_MAP)) {
      if (aliases.some(a => rawKey.includes(a))) {
        fields[canonical] = value
        break
      }
    }
  }
  return fields
}

const FIELD_META = [
  { key: 'DIRECTION', label: 'Direction', color: 'var(--accent)' },
  { key: 'STRONGEST', label: 'Strongest', color: '#22c55e' },
  { key: 'WEAKEST',   label: 'Weakest',   color: '#f97316' },
  { key: 'DRIFT',     label: 'Drift',     color: '#a78bfa' },
  { key: 'NEXT',      label: 'Next move', color: '#38bdf8' },
]

// ─── Analysis body ─────────────────────────────────────────────────────────────

function AnalysisBody({ loading, analysis, aiError, unavailable, aiLastRun, compact }) {
  const intelligenceActive = compact && (loading || !!analysis)

  // ── Compact mode: instrument-grade field rows ──
  if (compact) {
    return (
      <div style={{
        padding: '4px 24px 18px',
        background: intelligenceActive
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 4%, transparent) 0%, transparent 55%)'
          : 'transparent',
        transition: 'background 0.6s ease',
      }}>
        {/* Loading skeleton — same row structure as loaded fields */}
        {loading && (
          <div>
            {FIELD_META.map((f, i) => (
              <div
                key={f.key}
                style={{
                  display: 'flex', gap: 12, alignItems: 'center',
                  padding: '7px 0',
                  borderBottom: i < FIELD_META.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                }}
              >
                <span style={{
                  fontSize: '0.58rem', fontFamily: 'monospace',
                  textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
                  color: f.color, minWidth: 72, flexShrink: 0,
                }}>
                  {f.label}
                </span>
                <div
                  className="animate-pulse"
                  style={{ height: 7, flex: 1, background: 'rgba(255,255,255,0.07)', borderRadius: 3 }}
                />
              </div>
            ))}
          </div>
        )}
        {/* Loaded fields */}
        {!loading && analysis && (
          <div>
            {FIELD_META.map((f, i) => {
              const val = analysis[f.key]
              return (
                <div
                  key={f.key}
                  style={{
                    display: 'flex', gap: 12, alignItems: 'flex-start',
                    padding: '7px 0',
                    borderBottom: i < FIELD_META.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                  }}
                >
                  <span style={{
                    fontSize: '0.58rem', fontFamily: 'monospace',
                    textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
                    color: f.color, minWidth: 72, flexShrink: 0, paddingTop: 2,
                  }}>
                    {f.label}
                  </span>
                  <span style={{
                    fontSize: '0.79rem', fontFamily: 'monospace',
                    lineHeight: 1.5,
                    color: val ? 'rgba(241,245,249,0.87)' : 'rgba(71,85,105,0.4)',
                  }}>
                    {val ?? '—'}
                  </span>
                </div>
              )
            })}
            {aiLastRun && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                paddingTop: 8, marginTop: 2,
                borderTop: '1px solid rgba(255,255,255,0.04)',
              }}>
                <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.5)' }}>
                  last run {aiLastRun}
                </span>
                <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.3)' }}>
                  · qwen2.5-instruct:1.5b
                </span>
              </div>
            )}
          </div>
        )}
        {/* Cold instrument — always show row structure when not loading and no analysis */}
        {!loading && !analysis && (
          <div>
            {(aiError || unavailable) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 4px' }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                <span style={{ fontSize: '0.72rem', fontFamily: 'monospace', color: 'rgba(248,113,113,0.8)' }}>
                  {aiError || 'local Ollama not reachable on :11434'}
                </span>
              </div>
            )}
            {FIELD_META.map((f, i) => (
              <div
                key={f.key}
                style={{
                  display: 'flex', gap: 12, alignItems: 'center',
                  padding: '7px 0',
                  borderBottom: i < FIELD_META.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                }}
              >
                <span style={{
                  fontSize: '0.58rem', fontFamily: 'monospace',
                  textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600,
                  color: f.color, opacity: 0.45, minWidth: 72, flexShrink: 0,
                }}>
                  {f.label}
                </span>
                <span style={{ fontSize: '0.79rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.32)' }}>
                  —
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Standalone mode: unchanged ──
  return (
    <div>
      {aiError && (
        <p className="text-xs font-mono mb-2" style={{ color: '#ef4444' }}>{aiError}</p>
      )}
      {unavailable && (
        <p className="text-xs font-mono" style={{ color: '#ef4444' }}>local Ollama not reachable on :11434</p>
      )}
      {loading && (
        <div className="flex flex-col gap-2">
          {FIELD_META.map(f => (
            <div key={f.key} className="flex gap-3 items-center">
              <span className="text-xs font-mono shrink-0" style={{ color: f.color, width: 68 }}>{f.label}</span>
              <div className="h-2.5 rounded flex-1 animate-pulse" style={{ background: 'var(--border)' }} />
            </div>
          ))}
        </div>
      )}
      {!loading && analysis && (
        <div className="flex flex-col gap-2">
          {FIELD_META.map(f => (
            <div key={f.key} className="flex gap-3 items-start">
              <span className="text-xs font-mono shrink-0 pt-px" style={{ color: f.color, width: 68 }}>{f.label}</span>
              <span className="text-xs font-mono leading-relaxed" style={{ color: 'rgba(241,245,249,0.75)' }}>
                {analysis[f.key] ?? '—'}
              </span>
            </div>
          ))}
          {aiLastRun && (
            <p className="text-xs font-mono mt-1" style={{ color: 'var(--muted)' }}>
              last run {aiLastRun} · qwen2.5-instruct:1.5b
            </p>
          )}
        </div>
      )}
      {!loading && !analysis && !aiError && !unavailable && (
        <p className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
          press analyze to read the run log with the local model
        </p>
      )}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function AiPanel({ compact = false, autoTriggerCount = 0 }) {
  const [open, setOpen] = useState(!compact)
  const [status, setStatus] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const prevAutoTriggerRef = useRef(0)

  useEffect(() => {
    fetch('/api/ai/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ available: false }))
    // Load last cached analysis on mount
    fetch('/api/ai/latest')
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.response) {
          setAnalysis(parseAnalysis(data.response))
          setLastRun(new Date(data.ts).toLocaleTimeString())
        }
      })
      .catch(() => {})
  }, [])

  // Auto-analyze when parent signals a new run completed
  useEffect(() => {
    if (autoTriggerCount > prevAutoTriggerRef.current && !loading) {
      prevAutoTriggerRef.current = autoTriggerCount
      runAnalysis()
    }
  }, [autoTriggerCount]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runAnalysis(e) {
    e?.stopPropagation()
    setLoading(true)
    setError(null)
    if (compact) setOpen(true) // open immediately — show loading skeleton, not silent wait
    try {
      const r = await fetch('/api/ai/analyze', { method: 'POST' })
      const data = await r.json()
      if (!data.ok) throw new Error(data.error || 'Analysis failed')
      setAnalysis(parseAnalysis(data.response))
      setLastRun(new Date().toLocaleTimeString())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const unavailable = status?.available === false
  const aiDot = status === null
    ? 'rgba(71,85,105,0.4)'
    : unavailable
    ? '#ef4444'
    : status?.modelLoaded === false
    ? '#f97316'
    : '#22c55e'

  // ── Compact mode: collapsible zone inside BottomPanel ──
  if (compact) {
    const intelligenceActive = loading || !!analysis
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen(o => !o)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o) }}
          style={{
            position: 'relative',
            overflow: 'hidden',
            borderTop: intelligenceActive
              ? '1px solid color-mix(in srgb, var(--accent) 28%, transparent)'
              : unavailable
              ? '1px solid rgba(248,113,113,0.18)'
              : '1px solid var(--border)',
            padding: '11px 24px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            background: intelligenceActive
              ? 'color-mix(in srgb, var(--accent) 3%, transparent)'
              : unavailable
              ? 'rgba(248,113,113,0.03)'
              : 'transparent',
            boxShadow: intelligenceActive
              ? '0 -3px 18px color-mix(in srgb, var(--accent) 10%, transparent)'
              : unavailable
              ? '0 -2px 12px rgba(248,113,113,0.07)'
              : 'none',
            transition: 'background 0.6s ease, border-top-color 0.6s ease, box-shadow 0.6s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = intelligenceActive ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'rgba(255,255,255,0.02)' }}
          onMouseLeave={e => { e.currentTarget.style.background = intelligenceActive ? 'color-mix(in srgb, var(--accent) 3%, transparent)' : 'transparent' }}
        >
          {/* Inference scan line — sweeps left-to-right while model is running */}
          {loading && (
            <motion.div
              key="scan"
              initial={{ x: '-100%' }}
              animate={{ x: '240%' }}
              transition={{ duration: 1.7, repeat: Infinity, ease: 'linear' }}
              style={{
                position: 'absolute',
                top: 0, bottom: 0, left: 0,
                width: '42%',
                background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent) 22%, transparent) 50%, transparent 100%)',
                pointerEvents: 'none',
              }}
            />
          )}

          <span
            className="text-xs font-mono uppercase tracking-widest"
            style={{
              color: intelligenceActive ? 'var(--accent)' : 'var(--muted)',
              letterSpacing: '0.12em', fontSize: '0.62rem', flexShrink: 0,
              textShadow: intelligenceActive ? '0 0 14px var(--accent-glow)' : 'none',
              transition: 'color 0.6s ease, text-shadow 0.6s ease',
              position: 'relative',
            }}
          >
            Local Ollama/Qwen
          </span>
          <motion.div
            animate={(!unavailable && status?.available) ? { opacity: [1, 0.3, 1] } : {}}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            style={{ width: 6, height: 6, borderRadius: '50%', background: aiDot, flexShrink: 0, position: 'relative' }}
          />

          <span
            className="font-mono text-xs truncate"
            style={{
              color: !open && analysis?.DIRECTION
                ? 'rgba(241,245,249,0.58)'
                : 'rgba(241,245,249,0.28)',
              flex: 1, textAlign: 'left', fontSize: '0.68rem',
              transition: 'color 0.4s ease',
              position: 'relative',
            }}
          >
            {!open && analysis?.DIRECTION
              ? (analysis.DIRECTION.length > 64 ? analysis.DIRECTION.slice(0, 64) + '…' : analysis.DIRECTION)
              : !open && loading
              ? 'analyzing…'
              : !open
              ? (unavailable ? 'offline' : 'ready')
              : ''}
          </span>

          {/* Manual analyze trigger — only when AI is reachable */}
          {!unavailable && (
            <button
              onClick={e => { e.stopPropagation(); runAnalysis() }}
              disabled={loading}
              title="Re-analyze"
              style={{
                background: 'none', border: 'none', padding: '2px 4px',
                cursor: loading ? 'default' : 'pointer',
                opacity: loading ? 0.18 : 0.32,
                color: 'rgba(148,163,184,1)',
                display: 'flex', alignItems: 'center',
                transition: 'opacity 0.2s ease',
                flexShrink: 0, position: 'relative',
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.72' }}
              onMouseLeave={e => { e.currentTarget.style.opacity = loading ? '0.18' : '0.32' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </svg>
            </button>
          )}

          <motion.svg
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            width="11" height="11" viewBox="0 0 24 24"
            fill="none" stroke="rgba(71,85,105,0.5)" strokeWidth="2.5" strokeLinecap="round"
            style={{ flexShrink: 0 }}
          >
            <polyline points="6 9 12 15 18 9" />
          </motion.svg>
        </div>

        <motion.div
          initial={false}
          animate={{
            height: open ? 'auto' : 0,
            opacity: open ? 1 : 0,
          }}
          transition={{
            height: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
            opacity: { duration: 0.16 },
          }}
          style={{ overflow: 'hidden', position: 'relative' }}
        >
          {/* Left-edge accent bar — persistent structural element; faint during loading, full when analysis is loaded */}
          {(analysis || loading) && (
            <div style={{
              position: 'absolute',
              left: 0,
              top: 6,
              bottom: 6,
              width: 1,
              background: loading && !analysis
                ? 'linear-gradient(to bottom, color-mix(in srgb, var(--accent) 15%, transparent) 0%, transparent 85%)'
                : 'linear-gradient(to bottom, color-mix(in srgb, var(--accent) 40%, transparent) 0%, transparent 85%)',
              transition: 'background 0.6s ease',
              pointerEvents: 'none',
            }} />
          )}
          <AnalysisBody
            loading={loading}
            analysis={analysis}
            aiError={error}
            unavailable={unavailable}
            aiLastRun={lastRun}
            compact
          />
        </motion.div>
      </>
    )
  }

  // ── Standalone mode: full card ──
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-semibold tracking-widest uppercase" style={{ color: 'var(--muted)' }}>
            Local Ollama/Qwen
          </span>
          <span className="w-2 h-2 rounded-full" style={{ background: aiDot }} />
        </div>
        {loading && (
          <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>analyzing…</span>
        )}
      </div>

      {status?.available && !status?.modelLoaded && !loading && !analysis && (
        <p className="text-xs font-mono" style={{ color: '#f97316' }}>model not loaded — first run will be slow</p>
      )}

      <AnalysisBody
        loading={loading}
        analysis={analysis}
        aiError={error}
        unavailable={unavailable}
        aiLastRun={lastRun}
        compact={false}
      />
    </div>
  )
}
