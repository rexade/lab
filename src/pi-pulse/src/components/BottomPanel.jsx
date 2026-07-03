import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRuns } from '../hooks/useSystemStats.js'
import { AiPanel } from './AiPanel.jsx'

// ─── Run type config ────────────────────────────────────────────────────────

const TYPE_COLOR = {
  CREATE:    '#22d3ee',
  MUTATE:    '#a78bfa',
  RESEARCH:  '#34d399',
  INTEGRATE: '#fb923c',
  VOICE:     '#fbbf24',
  FAILED:    '#f87171',
}
const TYPE_DOT_COLOR = type => TYPE_COLOR[type] ?? 'rgba(255,255,255,0.3)'

function runAttemptText(run) {
  return run.attemptTotal > 1 && run.attempt ? ` · attempt ${run.attempt}/${run.attemptTotal}` : ''
}

// ─── Timeline ────────────────────────────────────────────────────────────────

function TimelineEntry({ run, index, isLast }) {
  const color = TYPE_DOT_COLOR(run.type)
  const what = run['Failure'] || run['Error'] || run['What I built'] || run['What I changed'] || run['What changed'] || run['What I investigated'] || run['Finding'] || run['What happened'] || '—'

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: index * 0.06 }}
      className="flex gap-3 relative"
      style={{ paddingBottom: isLast ? 0 : 20 }}
    >
      {/* Vertical line continuation */}
      {!isLast && (
        <div
          className="absolute"
          style={{
            left: 5,
            top: 14,
            bottom: 0,
            width: 1,
            background: 'linear-gradient(to bottom, var(--border) 0%, transparent 100%)',
          }}
        />
      )}

      {/* Node */}
      <div className="shrink-0 flex flex-col items-center" style={{ width: 11, paddingTop: 4 }}>
        <div
          className="rounded-full"
          style={{
            width: 8,
            height: 8,
            background: color,
            boxShadow: `0 0 6px ${color}88`,
            flexShrink: 0,
          }}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1" style={{ paddingTop: 1 }}>
        <div className="flex items-center gap-2 mb-0.5">
          <span
            className="text-xs font-mono uppercase"
            style={{ color, letterSpacing: '0.08em', fontSize: '0.65rem' }}
          >
            {run.type ?? 'run'}
          </span>
          <span className="text-xs" style={{ color: 'rgba(71,85,105,0.6)', fontSize: '0.65rem' }}>
            {run.num ? `#${run.num}` : ''} {run.date ?? ''}{runAttemptText(run)}
          </span>
        </div>
        <p
          className="text-sm font-medium leading-snug"
          style={{ color: 'rgba(241,245,249,0.85)', fontSize: '0.8rem' }}
        >
          {what.length > 72 ? what.slice(0, 72) + '…' : what}
        </p>
      </div>
    </motion.div>
  )
}

// ─── Run type chips — compact type:count per run type ────────────────────────

const TYPE_ORDER = ['CREATE', 'MUTATE', 'RESEARCH', 'INTEGRATE', 'FAILED']

function RunTypeChips({ runs }) {
  const counts = useMemo(() => {
    const c = {}
    for (const r of runs) {
      const t = r.type ?? 'OTHER'
      c[t] = (c[t] || 0) + 1
    }
    return c
  }, [runs])

  const types = TYPE_ORDER.filter(t => counts[t])
  if (!types.length) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {types.map(type => {
        const color = TYPE_DOT_COLOR(type)
        return (
          <span
            key={type}
            title={type}
            style={{
              fontSize: '0.58rem',
              fontFamily: 'monospace',
              color,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
              padding: '1px 5px',
              borderRadius: 3,
              letterSpacing: '0.04em',
              lineHeight: 1.4,
            }}
          >
            {type[0]}{counts[type]}
          </span>
        )
      })}
    </div>
  )
}

// Ghost entries — pulsing placeholder nodes for empty state
function GhostEntry({ delay, wide }) {
  return (
    <motion.div
      animate={{ opacity: [0.06, 0.14, 0.06] }}
      transition={{ duration: 2.8, repeat: Infinity, delay, ease: 'easeInOut' }}
      className="flex gap-3"
      style={{ paddingBottom: 20 }}
    >
      <div className="shrink-0" style={{ width: 11, paddingTop: 4 }}>
        <div className="rounded-full" style={{ width: 8, height: 8, background: 'var(--muted)' }} />
      </div>
      <div className="flex flex-col gap-1.5" style={{ paddingTop: 2 }}>
        <div className="h-1.5 rounded-full" style={{ background: 'var(--muted)', width: 36 }} />
        <div className="h-2 rounded-full" style={{ background: 'var(--muted)', width: wide ? 180 : 120 }} />
      </div>
    </motion.div>
  )
}

// ─── Log modal ────────────────────────────────────────────────────────────────

const LOG_TYPE_COLOR = { CREATE: '#22d3ee', MUTATE: '#a78bfa', RESEARCH: '#34d399', HARVEST: '#fbbf24' }
const LOG_FIELD_COLOR = {
  'What I changed': '#e2e8f0', 'What I built': '#e2e8f0', 'What I investigated': '#e2e8f0',
  'Why': '#94a3b8', 'Why this direction': '#94a3b8',
  'What improved': '#22c55e', "What's interesting": '#22c55e', 'Key finding': '#22c55e',
  'What broke': '#f97316', 'What got worse': '#f97316',
  'Next move': '#38bdf8', 'Suggested next move': '#38bdf8', 'Implication': '#38bdf8',
}

function parseRunLog(content) {
  const blocks = content.split(/(?=^## Run \d)/m).filter(s => s.trimStart().startsWith('## Run'))
  return blocks.map(block => {
    // Strip stdout comment dumps
    const clean = block.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
    const lines = clean.split('\n')
    const header = lines[0].replace('## Run ', '')
    const parts = header.split(' — ').map(s => s.trim())
    const num = parts[0], date = parts[1], type = parts[2]
    const fields = []
    for (const line of lines.slice(1)) {
      const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/)
      if (m) fields.push({ label: m[1], value: m[2] })
    }
    return { num, date, type, fields }
  }).reverse()
}

function LogModal({ content, onClose }) {
  const runs = useMemo(() => parseRunLog(content), [content])
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          width: '100%', maxWidth: 680, maxHeight: '82vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: '0.8rem', color: '#e2e8f0', fontFamily: 'monospace', letterSpacing: '0.06em' }}>
            Run Log
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
          >×</button>
        </div>

        {/* Cards */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {runs.map((run, i) => {
            const tc = LOG_TYPE_COLOR[run.type] ?? '#64748b'
            return (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 10,
                padding: '12px 16px',
              }}>
                {/* Run header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{
                    fontSize: '0.62rem', fontFamily: 'monospace', fontWeight: 700,
                    color: tc, letterSpacing: '0.1em', textTransform: 'uppercase',
                    background: `color-mix(in srgb, ${tc} 12%, transparent)`,
                    padding: '2px 7px', borderRadius: 4, border: `1px solid color-mix(in srgb, ${tc} 25%, transparent)`,
                  }}>{run.type}</span>
                  <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: '#e2e8f0', fontWeight: 600 }}>
                    #{run.num}
                  </span>
                  {run.date && (
                    <span style={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'var(--muted)', marginLeft: 'auto' }}>
                      {run.date}
                    </span>
                  )}
                </div>
                {/* Fields */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {run.fields.map((f, j) => (
                    <div key={j} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <span style={{
                        fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 600,
                        color: LOG_FIELD_COLOR[f.label] ?? '#64748b',
                        textTransform: 'uppercase', letterSpacing: '0.08em',
                        minWidth: 90, flexShrink: 0, paddingTop: 2,
                      }}>{f.label}</span>
                      <span style={{ fontSize: '0.78rem', lineHeight: 1.5, color: 'rgba(226,232,240,0.75)' }}>
                        {f.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Secondary action button ──────────────────────────────────────────────────

function SecondaryButton({ label, description, icon, danger, onClick }) {
  const [loading, setLoading] = useState(false)
  const color = danger ? '#f87171' : 'rgba(255,255,255,0.55)'

  const handle = async () => {
    if (loading) return
    setLoading(true)
    try { await onClick?.() } finally {
      setTimeout(() => setLoading(false), 700)
    }
  }

  return (
    <motion.button
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.98 }}
      onClick={handle}
      style={{
        width: '100%', padding: '9px 12px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'transparent',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 10,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{ color, opacity: loading ? 0.5 : 1 }}>
        {loading ? (
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
            </svg>
          </motion.div>
        ) : icon}
      </div>
      <div>
        <div style={{ fontSize: '0.8rem', fontWeight: 500, color: danger ? '#f87171' : 'rgba(241,245,249,0.8)' }}>
          {label}
        </div>
        <div style={{ fontSize: '0.68rem', color: 'rgba(71,85,105,0.7)' }}>{description}</div>
      </div>
    </motion.button>
  )
}

// ─── Reboot button — two-step confirm, real API ───────────────────────────────

function RebootButton() {
  const [phase, setPhase] = useState('idle') // idle | confirm | rebooting
  const timerRef = useRef(null)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const handle = async () => {
    if (phase === 'rebooting') return
    if (phase === 'idle') {
      setPhase('confirm')
      timerRef.current = setTimeout(() => setPhase('idle'), 4000)
    } else {
      clearTimeout(timerRef.current)
      setPhase('rebooting')
      try { await fetch('/api/reboot', { method: 'POST' }) } catch { /* system rebooting */ }
    }
  }

  const confirming = phase === 'confirm'
  const rebooting = phase === 'rebooting'

  return (
    <motion.button
      whileHover={phase === 'idle' ? { x: 2 } : {}}
      whileTap={{ scale: 0.98 }}
      onClick={handle}
      disabled={rebooting}
      style={{
        width: '100%', padding: '9px 12px',
        borderRadius: 8,
        border: confirming ? '1px solid rgba(248,113,113,0.4)' : '1px solid var(--border)',
        background: confirming ? 'rgba(248,113,113,0.08)' : 'transparent',
        cursor: rebooting ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 10,
        transition: 'all 0.2s ease',
      }}
    >
      <div style={{ color: '#f87171', opacity: rebooting ? 0.5 : 1 }}>
        {rebooting ? (
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
            </svg>
          </motion.div>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18.36 6.64a9 9 0 11-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        )}
      </div>
      <div>
        <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#f87171' }}>
          {rebooting ? 'Rebooting…' : confirming ? 'CONFIRM REBOOT' : 'Reboot'}
        </div>
        <div style={{ fontSize: '0.68rem', color: confirming ? 'rgba(248,113,113,0.65)' : 'rgba(71,85,105,0.7)' }}>
          {rebooting ? 'System shutting down' : confirming ? 'Click again to confirm — cancels in 4s' : 'Graceful system restart'}
        </div>
      </div>
    </motion.button>
  )
}

// ─── Live stat bar — matches PulsePanel's LoadBar aesthetic ──────────────────

function MiniBar({ label, value, max = 100, displayValue }) {
  const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)))
  const color = pct > 85 ? '#f87171' : pct > 65 ? '#fb923c' : 'var(--accent)'
  const shown = displayValue ?? `${pct}%`
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted)' }}>
          {label}
        </span>
        <span style={{ fontSize: '0.62rem', fontFamily: 'monospace', color }}>
          {shown}
        </span>
      </div>
      <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <motion.div
          style={{ height: '100%', borderRadius: 2, background: color, boxShadow: `0 0 6px ${color}40` }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        />
      </div>
    </div>
  )
}

// ─── Narrator voice inscription ───────────────────────────────────────────────

function NarratorVoice({ narration, onClick }) {
  if (!narration) return null
  const ago = fmtAgo(narration.ts)
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: 'easeOut' }}
      onClick={onClick}
      style={{
        marginBottom: 20,
        paddingLeft: 14,
        borderLeft: '1px solid rgba(251,191,36,0.22)',
        position: 'relative',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {/* Faint left-edge glow */}
      <div
        style={{
          position: 'absolute',
          left: -1,
          top: 0,
          bottom: 0,
          width: 1,
          background: 'linear-gradient(to bottom, rgba(251,191,36,0.45), rgba(251,191,36,0.08))',
          filter: 'blur(1px)',
        }}
      />
      <div style={{
        fontSize: '0.58rem',
        fontFamily: 'monospace',
        color: 'rgba(251,191,36,0.45)',
        letterSpacing: '0.13em',
        textTransform: 'uppercase',
        marginBottom: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>voice · {ago}</span>
        {onClick && <span style={{ opacity: 0.55, letterSpacing: '0.08em' }}>diary ›</span>}
      </div>
      <motion.p
        animate={{ opacity: [0.68, 0.78, 0.68] }}
        transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
        style={{
          fontStyle: 'italic',
          fontSize: '0.82rem',
          lineHeight: 1.55,
          color: 'rgba(251,191,36,0.72)',
          letterSpacing: '0.01em',
          margin: 0,
        }}
      >
        "{narration.text}"
      </motion.p>
    </motion.div>
  )
}

// ─── Machine Diary — narration archive modal ─────────────────────────────────

function heatColor(temp) {
  if (!temp || temp < 35) return { main: '#38bdf8', dim: 'rgba(56,189,248,0.15)' }
  if (temp < 50)           return { main: '#fbbf24', dim: 'rgba(251,191,36,0.15)' }
  if (temp < 65)           return { main: '#fb923c', dim: 'rgba(251,146,60,0.15)' }
  return                          { main: '#f87171', dim: 'rgba(248,113,113,0.15)' }
}

function NarrationArchiveModal({ entries, onClose }) {
  // Thermal ribbon: oldest → newest (left → right)
  const ribbon = useMemo(() => [...entries].reverse(), [entries])
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          width: '100%', maxWidth: 520, maxHeight: '82vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: '0.62rem', fontFamily: 'monospace', fontWeight: 700,
              color: 'rgba(251,191,36,0.6)', letterSpacing: '0.13em', textTransform: 'uppercase',
            }}>Machine Diary</span>
            <span style={{
              fontSize: '0.58rem', fontFamily: 'monospace',
              color: 'var(--muted)', letterSpacing: '0.06em',
            }}>{entries.length} entries</span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1, padding: '0 2px' }}
          >×</button>
        </div>

        {/* Thermal ribbon — temperature fingerprint, oldest → newest */}
        <div style={{ padding: '10px 20px 8px', flexShrink: 0 }}>
          <div style={{
            fontSize: '0.5rem', fontFamily: 'monospace',
            color: 'rgba(255,255,255,0.13)', letterSpacing: '0.1em',
            textTransform: 'uppercase', marginBottom: 5,
          }}>
            thermal history · oldest → newest
          </div>
          <div style={{ display: 'flex', gap: 2, overflow: 'hidden' }}>
            {ribbon.map((e, i) => {
              const { main } = heatColor(e.stats?.temp)
              const opacity = 0.25 + (i / Math.max(ribbon.length - 1, 1)) * 0.75
              return (
                <div key={i} title={e.stats?.temp != null ? `${e.stats.temp}°C` : '?'} style={{
                  flex: '0 0 auto', width: 8, height: 5,
                  borderRadius: 2, background: main, opacity,
                }} />
              )
            })}
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--border)', flexShrink: 0 }} />

        {/* Entry list */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '12px 20px 16px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {entries.map((entry, i) => {
            const { main: hc } = heatColor(entry.stats?.temp)
            const cpu = entry.stats?.cpu
            const temp = entry.stats?.temp
            return (
              <div key={i} style={{
                paddingLeft: 12,
                borderLeft: `1px solid ${hc}50`,
                position: 'relative',
              }}>
                {/* Heat glow on left edge */}
                <div style={{
                  position: 'absolute', left: -1, top: 0, bottom: 0, width: 1,
                  background: `linear-gradient(to bottom, ${hc}70, ${hc}10)`,
                  filter: 'blur(1px)',
                }} />
                {/* Meta */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3,
                }}>
                  <span style={{
                    fontSize: '0.55rem', fontFamily: 'monospace',
                    color: 'var(--muted)', letterSpacing: '0.04em',
                  }}>
                    {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {fmtAgo(entry.ts)}
                  </span>
                  {(cpu != null || temp != null) && (
                    <span style={{
                      fontSize: '0.52rem', fontFamily: 'monospace',
                      color: hc, opacity: 0.6, letterSpacing: '0.04em',
                    }}>
                      {temp != null ? `${temp}°` : ''}{cpu != null ? ` · ${cpu}%` : ''}
                    </span>
                  )}
                </div>
                {/* Text */}
                <p style={{
                  margin: 0, fontStyle: 'italic',
                  fontSize: '0.8rem', lineHeight: 1.5,
                  color: 'rgba(251,191,36,0.72)', letterSpacing: '0.01em',
                }}>
                  "{entry.text}"
                </p>
              </div>
            )
          })}
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtElapsed(secs) {
  if (!secs || secs < 1) return ''
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins === 1) return '1 min ago'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)}h ago`
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function BottomPanel({ stats }) {
  const [runs, refreshRuns] = useRuns()
  const [logContent, setLogContent] = useState(null)

  // Narrator — latest VOICE entry from /api/narration
  const [latestNarration, setLatestNarration] = useState(null)
  useEffect(() => {
    const fetch_ = async () => {
      try {
        const r = await fetch('/api/narration')
        const data = await r.json()
        if (data.ok && data.text) setLatestNarration(data)
      } catch {}
    }
    fetch_()
    const id = setInterval(fetch_, 60_000)
    return () => clearInterval(id)
  }, [])

  // Machine Diary — narration archive modal
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveEntries, setArchiveEntries] = useState([])
  const openArchive = async () => {
    try {
      const r = await fetch('/api/narrations')
      const data = await r.json()
      if (data.entries?.length) {
        setArchiveEntries(data.entries)
        setArchiveOpen(true)
      }
    } catch {}
  }

  // Auto-trigger AI analysis after every new run
  const prevRunCountRef = useRef(0)
  const [aiTriggerCount, setAiTriggerCount] = useState(0)

  useEffect(() => {
    if (runs.length > prevRunCountRef.current && prevRunCountRef.current > 0) {
      setAiTriggerCount(c => c + 1)
    }
    prevRunCountRef.current = runs.length
  }, [runs.length])

  const displayRuns = runs.slice(-4).reverse()

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.2 }}
      className="panel"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1px minmax(280px, 320px)',
        }}
        className="max-md:!block"
      >
        {/* ── Left: Event Log ────────────────────────────────── */}
        <div style={{ padding: '22px 24px' }}>
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <span
              className="text-xs uppercase tracking-widest font-medium"
              style={{
                color: 'var(--muted)',
                letterSpacing: '0.14em', fontSize: '0.65rem',
                transition: 'color 0.5s ease',
                textShadow: 'none',
              }}
            >
              Event Log
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <RunTypeChips runs={runs} />
              {/* Live stream dot — pulses faintly at rest, glows accent when a run is in flight */}
              <motion.div
                animate={{ opacity: [0.35, 0.12, 0.35] }}
                transition={{
                  duration: 2.8,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
                style={{
                  width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                  background: 'rgba(71,85,105,0.7)',
                  boxShadow: 'none',
                  transition: 'background 0.5s ease, box-shadow 0.5s ease',
                }}
              />
            </div>
          </div>

          {/* Narrator voice — machine's inner monologue — click for full diary */}
          <NarratorVoice narration={latestNarration} onClick={latestNarration ? openArchive : undefined} />

          {/* Timeline */}
          <div className="relative" style={{ paddingLeft: 0 }}>
            {/* Left edge accent line */}
            <div
              className="absolute"
              style={{
                left: 4,
                top: 6,
                bottom: 6,
                width: 1,
                background: 'linear-gradient(to bottom, color-mix(in srgb, var(--accent) 30%, transparent), transparent)',
                transition: 'background 0.6s ease',
              }}
            />

            <AnimatePresence mode="wait">
              {displayRuns.length > 0 ? (
                <motion.div
                  key="real"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  {displayRuns.map((run, i) => (
                    <TimelineEntry
                      key={run.signature || `${run.num ?? 'run'}-${run.date ?? ''}-${run.type ?? ''}-${run.attempt || i}`}
                      run={run}
                      index={i}
                      isLast={i === displayRuns.length - 1}
                    />
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  key="ghost"
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <GhostEntry delay={0} wide />
                  <GhostEntry delay={0.7} wide={false} />
                  <GhostEntry delay={1.4} wide />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Vertical divider (hidden on mobile) ────────────── */}
        <div
          className="max-md:hidden"
          style={{ background: 'var(--border)', margin: '18px 0' }}
        />

        {/* ── Right: Controls ────────────────────────────────── */}
        <div
          style={{ padding: '22px 22px 20px' }}
          className="max-md:border-t max-md:pt-5"
        >
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>
              System Tools
            </div>
            <div style={{ marginTop: 4, fontSize: '0.72rem', color: 'rgba(148,163,184,0.58)', lineHeight: 1.35 }}>
              Host runs now live in the Core Incubator.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SecondaryButton
              label="View Logs"
              description="Open RUN_LOG.md"
              onClick={async () => {
                const res = await fetch('/api/logs')
                const data = await res.json()
                setLogContent(data.content)
              }}
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              }
            />
            <RebootButton />
          </div>

          {/* Live system bars — reacts to same data stream as PulsePanel */}
          <div
            style={{
              marginTop: 16, paddingTop: 14,
              borderTop: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            <MiniBar
              label="Load"
              value={stats?.loadAvg?.[0] ?? 0}
              max={4}
              displayValue={(stats?.loadAvg?.[0] ?? 0).toFixed(2)}
            />
            <MiniBar
              label="Memory"
              value={stats?.memory?.percent ?? 0}
            />
            <MiniBar
              label="Disk"
              value={stats?.disk?.percent ?? 0}
              displayValue={stats?.disk ? `${stats.disk.usedGB}/${stats.disk.totalGB}G` : '—'}
            />
          </div>
        </div>
      </div>

      {/* ── AI Zone — full-width, bottom of panel ──────────── */}
      {/* borderTop is owned by AiPanel. Subtly darker base anchors it as a distinct instrument layer */}
      <div style={{ background: 'rgba(0,0,0,0.15)' }}>
        <AiPanel compact autoTriggerCount={aiTriggerCount} />
      </div>

      <AnimatePresence>
        {logContent && <LogModal content={logContent} onClose={() => setLogContent(null)} />}
        {archiveOpen && <NarrationArchiveModal entries={archiveEntries} onClose={() => setArchiveOpen(false)} />}
      </AnimatePresence>
    </motion.div>
  )
}
