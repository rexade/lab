import { useState, useEffect, useRef, useMemo } from 'react'
import { motion } from 'framer-motion'

// ─── AI analysis strip ────────────────────────────────────────────────────────

const AI_FIELD_META = [
  { key: 'DIRECTION', label: 'Direction', color: 'var(--accent)' },
  { key: 'STRONGEST', label: 'Strongest', color: '#22c55e' },
  { key: 'WEAKEST',   label: 'Weakest',   color: '#f97316' },
  { key: 'DRIFT',     label: 'Drift',     color: '#a78bfa' },
  { key: 'NEXT',      label: 'Next',      color: '#38bdf8' },
]
const AI_FIELD_KEYS = AI_FIELD_META.map(f => f.key)

function normalizeAnalysis(data = {}) {
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

function AiStrip({ slotId, autoTrigger }) {
  const [open, setOpen]         = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [lastRun, setLastRun]   = useState(null)
  const prevTriggerBySlotRef    = useRef({})

  useEffect(() => {
    setAnalysis(null)
    setError(null)
    setLastRun(null)
    if (!slotId) return
    fetch(`/api/incubators/${slotId}/ai/latest`)
      .then(async r => {
        const text = await r.text()
        try { return JSON.parse(text) }
        catch { throw new Error('AI feedback API returned HTML, not JSON') }
      })
      .then(d => {
        if (d.ok && d.response) {
          setAnalysis(normalizeAnalysis(d))
          setLastRun(d.ts ? new Date(d.ts).toLocaleTimeString() : null)
        }
      })
      .catch(err => setError(err.message))
  }, [slotId])

  useEffect(() => {
    if (!slotId) return
    const prev = prevTriggerBySlotRef.current[slotId]
    if (prev == null) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
      return
    }
    if (autoTrigger > prev && !loading) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
      runAnalysis()
    } else if (autoTrigger > prev) {
      prevTriggerBySlotRef.current[slotId] = autoTrigger
    }
  }, [slotId, autoTrigger])

  async function runAnalysis(e) {
    e?.stopPropagation()
    setLoading(true)
    setError(null)
    setOpen(true)
    try {
      const r = await fetch(`/api/incubators/${slotId}/ai/analyze`, { method: 'POST' })
      const text = await r.text()
      let d
      try { d = JSON.parse(text) }
      catch { throw new Error('AI feedback API returned HTML, not JSON') }
      if (!d.ok) throw new Error(d.error || 'failed')
      setAnalysis(normalizeAnalysis(d))
      setLastRun(d.ts ? new Date(d.ts).toLocaleTimeString() : new Date().toLocaleTimeString())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const fields = analysis?.fields || {}
  const preview = fields.DIRECTION || analysis?.raw?.split('\n').find(Boolean) || ''
  const active = loading || !!analysis?.raw

  return (
    <>
      {/* Header strip */}
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o) }}
        style={{
          borderTop: active
            ? '1px solid color-mix(in srgb, #a78bfa 28%, transparent)'
            : '1px solid var(--border)',
          padding: '10px 24px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
          background: active ? 'color-mix(in srgb, #a78bfa 3%, transparent)' : 'transparent',
          transition: 'background 0.5s ease, border-top-color 0.5s ease',
          position: 'relative', overflow: 'hidden',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = active ? 'color-mix(in srgb, #a78bfa 5%, transparent)' : 'rgba(255,255,255,0.02)' }}
        onMouseLeave={e => { e.currentTarget.style.background = active ? 'color-mix(in srgb, #a78bfa 3%, transparent)' : 'transparent' }}
      >
        {loading && (
          <motion.div
            initial={{ x: '-100%' }} animate={{ x: '240%' }}
            transition={{ duration: 1.7, repeat: Infinity, ease: 'linear' }}
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '42%',
              background: 'linear-gradient(90deg, transparent, color-mix(in srgb, #a78bfa 22%, transparent), transparent)',
              pointerEvents: 'none' }}
          />
        )}
        <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.12em',
          color: active ? '#a78bfa' : 'var(--muted)', position: 'relative' }}>
          Local Ollama/Qwen
        </span>
        <motion.div
          animate={analysis ? { opacity: [1, 0.3, 1] } : {}}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          style={{ width: 5, height: 5, borderRadius: '50%', background: error ? '#ef4444' : analysis?.malformed ? '#f59e0b' : '#22c55e', flexShrink: 0 }}
        />
        <span style={{ flex: 1, fontSize: '0.67rem', fontFamily: 'monospace',
          color: !open && preview ? 'rgba(241,245,249,0.55)' : 'rgba(71,85,105,0.4)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {!open && preview
            ? (preview.length > 60 ? preview.slice(0, 60) + '…' : preview)
            : !open && loading ? 'analyzing…' : !open ? 'ready' : ''}
        </span>
        <button onClick={e => { e.stopPropagation(); runAnalysis() }} disabled={loading}
          title="Refresh local Ollama/Qwen analysis"
          style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.18 : 0.32, color: 'rgba(148,163,184,1)', display: 'flex', alignItems: 'center',
            transition: 'opacity 0.2s ease', flexShrink: 0 }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.72' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = loading ? '0.18' : '0.32' }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
        <motion.svg animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="rgba(71,85,105,0.5)" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </motion.svg>
      </div>

      {/* Collapsible body */}
      <motion.div
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={{ height: { duration: 0.22, ease: [0.4, 0, 0.2, 1] }, opacity: { duration: 0.15 } }}
        style={{ overflow: 'hidden' }}
      >
        <div style={{ padding: '4px 24px 16px' }}>
          {error && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '5px 0 4px' }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
              <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(248,113,113,0.8)' }}>{error}</span>
            </div>
          )}
          {AI_FIELD_META.map((f, i) => (
            <div key={f.key} style={{ display: 'flex', gap: 12, alignItems: loading ? 'center' : 'flex-start',
              padding: '6px 0', borderBottom: i < AI_FIELD_META.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontSize: '0.57rem', fontFamily: 'monospace', textTransform: 'uppercase',
                letterSpacing: '0.1em', fontWeight: 600, color: f.color,
                minWidth: 68, flexShrink: 0, opacity: (!analysis && !loading) ? 0.4 : 1 }}>
                {f.label}
              </span>
              {loading ? (
                <div className="animate-pulse" style={{ height: 7, flex: 1, background: 'rgba(255,255,255,0.07)', borderRadius: 3 }} />
              ) : (
                <span style={{ fontSize: '0.78rem', fontFamily: 'monospace', lineHeight: 1.5,
                  color: fields[f.key] ? 'rgba(241,245,249,0.85)' : analysis?.malformed ? 'rgba(245,158,11,0.72)' : 'rgba(71,85,105,0.32)' }}>
                  {fields[f.key] ?? (analysis?.malformed ? 'missing from saved response' : '—')}
                </span>
              )}
            </div>
          ))}
          {analysis?.malformed && (
            <div style={{ marginTop: 8, border: '1px solid rgba(245,158,11,0.18)', background: 'rgba(245,158,11,0.05)', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontSize: '0.56rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(245,158,11,0.8)', marginBottom: 6 }}>
                raw local qwen response
              </div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.68rem', lineHeight: 1.45, fontFamily: 'monospace', color: 'rgba(241,245,249,0.72)', maxHeight: 160, overflow: 'auto' }}>{analysis.raw}</pre>
            </div>
          )}
          {lastRun && !loading && (
            <div style={{ paddingTop: 7, borderTop: '1px solid rgba(255,255,255,0.04)', marginTop: 2 }}>
              <span style={{ fontSize: '0.59rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)' }}>
                saved {lastRun} · local Ollama/Qwen · {analysis?.model}
              </span>
            </div>
          )}
        </div>
      </motion.div>
    </>
  )
}

const TYPE_COLOR = {
  MUTATE:   '#a78bfa',
  RESEARCH: '#34d399',
  CREATE:   '#22d3ee',
  FAILED:   '#f87171',
}

function fmtElapsed(secs) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtCountdown(nextRunAt) {
  if (!nextRunAt) return null
  const diffMs = nextRunAt - Date.now()
  if (diffMs <= 0) return 'soon'
  const h = Math.floor(diffMs / 3600000)
  const m = Math.floor((diffMs % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmtInterval(hours) {
  if (!hours) return 'manual'
  const mins = Math.round(hours * 60)
  return mins < 60 ? `${mins}m` : `${hours}h`
}

function runAttemptText(run) {
  return run.attemptTotal > 1 && run.attempt ? ` · attempt ${run.attempt}/${run.attemptTotal}` : ''
}

function firstPreflightIssue(preflight) {
  if (!preflight || preflight.ok) return null
  const failed = preflight.checks?.find(c => !c.ok)
  if (!failed) return preflight.error || 'runner preflight failed'
  return `${failed.label}: ${failed.detail}`
}

function IncubatorSlot({ slot, onToggle, onRun }) {
  const enabled = !!slot.schedule?.enabled
  const active = !!slot.running
  const due = fmtCountdown(slot.schedule?.nextRunAt)
  const runner = slot.runner || slot.schedule?.runner || 'script'
  const ringColor = slot.tone === 'core' ? '#22d3ee' : '#a78bfa'
  const statusColor = active ? ringColor : enabled ? '#22c55e' : 'rgba(71,85,105,0.45)'
  const level = Math.max(1, Math.floor((slot.runCount || 0) / 5) + 1)
  const xp = Math.min(100, ((slot.runCount || 0) % 5) * 20)

  return (
    <div style={{
      border: `1px solid ${active ? `${ringColor}55` : 'rgba(255,255,255,0.08)'}`,
      background: active ? `color-mix(in srgb, ${ringColor} 7%, rgba(8,10,14,0.96))` : 'rgba(8,10,14,0.72)',
      borderRadius: 8,
      padding: 12,
      display: 'grid',
      gridTemplateColumns: '42px 1fr auto',
      gap: 12,
      alignItems: 'center',
      minWidth: 0,
    }}>
      <motion.div
        animate={active ? { rotate: 360 } : { rotate: 0 }}
        transition={active ? { duration: 8, repeat: Infinity, ease: 'linear' } : { duration: 0.4 }}
        style={{
        width: 42,
        height: 42,
        borderRadius: '50%',
        background: `conic-gradient(${ringColor} ${active ? '220deg' : enabled ? '96deg' : '18deg'}, rgba(255,255,255,0.08) 0)`,
        display: 'grid',
        placeItems: 'center',
        boxShadow: active ? `0 0 16px ${ringColor}33` : 'none',
      }}>
        <div style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: '#0d1015',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'grid',
          placeItems: 'center',
          color: ringColor,
          fontSize: '0.58rem',
          fontFamily: 'monospace',
          fontWeight: 700,
        }}>
          {slot.label}
        </div>
      </motion.div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{
            fontSize: '0.58rem',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: ringColor,
            whiteSpace: 'nowrap',
          }}>
            {slot.type}
          </span>
          <span style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: statusColor,
            boxShadow: active ? `0 0 8px ${ringColor}` : 'none',
            flexShrink: 0,
          }} />
          <span style={{
            fontSize: '0.56rem',
            fontFamily: 'monospace',
            color: 'rgba(71,85,105,0.58)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {active ? 'incubating' : enabled ? `every ${fmtInterval(slot.schedule?.intervalHours)}` : 'paused'}
          </span>
        </div>
        <div style={{
          marginTop: 5,
          fontSize: '0.84rem',
          fontWeight: 650,
          color: 'rgba(241,245,249,0.88)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {slot.name}
        </div>
        <div style={{
          marginTop: 4,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: '0.62rem',
          fontFamily: 'monospace',
          color: 'rgba(148,163,184,0.66)',
        }}>
          <span>{runner}</span>
          <span>{slot.charges ?? '∞'} charges</span>
          <span>{active ? fmtElapsed(slot.elapsed || 0) : enabled ? `next ${due}` : 'no timer'}</span>
        </div>
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{
            fontSize: '0.56rem',
            fontFamily: 'monospace',
            color: ringColor,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            whiteSpace: 'nowrap',
          }}>
            lvl {level}
          </span>
          <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
            <motion.div
              initial={false}
              animate={{ width: `${xp || (active ? 8 : 0)}%` }}
              transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
              style={{ height: '100%', background: ringColor, boxShadow: active ? `0 0 10px ${ringColor}` : 'none' }}
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          onClick={onRun}
          disabled={active}
          title={`Run ${slot.name}`}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${ringColor}33`,
            background: `${ringColor}14`,
            color: ringColor,
            cursor: active ? 'not-allowed' : 'pointer',
            display: 'grid',
            placeItems: 'center',
            opacity: active ? 0.45 : 1,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
        <button
          onClick={onToggle}
          title={enabled ? 'Pause incubator' : 'Start incubator'}
          style={{
            minWidth: 46,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${enabled ? 'rgba(34,197,94,0.28)' : 'rgba(255,255,255,0.08)'}`,
            background: enabled ? 'rgba(34,197,94,0.07)' : 'rgba(255,255,255,0.03)',
            color: enabled ? '#22c55e' : 'rgba(148,163,184,0.62)',
            cursor: 'pointer',
            fontSize: '0.58rem',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {enabled ? 'pause' : 'start'}
        </button>
      </div>
    </div>
  )
}

function RunnerSwitch({ value, available = ['codex', 'claude'], onChange, disabled }) {
  const options = ['codex', 'claude']
  return (
    <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, overflow: 'hidden' }}>
      {options.map(option => {
        const active = value === option
        const supported = available.includes(option)
        return (
          <button
            key={option}
            onClick={() => supported && onChange?.(option)}
            disabled={disabled || !supported}
            title={supported ? `Use ${option}` : `${option} runner is not configured for this project`}
            style={{
              border: 'none',
              borderRight: option === 'codex' ? '1px solid rgba(255,255,255,0.08)' : 'none',
              background: active ? 'rgba(167,139,250,0.14)' : 'rgba(255,255,255,0.025)',
              color: active ? '#a78bfa' : supported ? 'rgba(148,163,184,0.68)' : 'rgba(71,85,105,0.35)',
              padding: '4px 8px',
              cursor: disabled || !supported ? 'not-allowed' : 'pointer',
              fontSize: '0.58rem',
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

export function ProjectPanel() {
  const [selected, setSelected] = useState('core')
  const [hostStatus, setHostStatus] = useState(null)
  const [hostRuns, setHostRuns] = useState([])
  const [labSchedule, setLabSchedule] = useState(null)
  const [labRunning, setLabRunning] = useState(false)
  const [labElapsed, setLabElapsed] = useState(0)
  const [labLaunching, setLabLaunching] = useState(false)
  const [incubators, setIncubators] = useState([])
  const [runsBySlot, setRunsBySlot] = useState({})
  const [projects, setProjects] = useState([])
  const [addOpen, setAddOpen] = useState(false)
  const [newIdea, setNewIdea] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creatingIdea, setCreatingIdea] = useState(false)
  const [steerTextBySlot, setSteerTextBySlot] = useState({})
  const [steerStateBySlot, setSteerStateBySlot] = useState({})
  const [switching, setSwitching] = useState(false)
  const [aiTriggersBySlot, setAiTriggersBySlot] = useState({})
  const [preflightBySlot, setPreflightBySlot] = useState({})
  const [launchErrors, setLaunchErrors] = useState({})
  const labStartTimeRef = useRef(null)
  const runSignatureBySlotRef = useRef({})

  const fetchHostStatus = () => fetch('/api/project/status').then(r => r.json()).then(setHostStatus).catch(() => {})

  const latestRunSignature = (runs) => {
    const latest = runs.at(-1)
    if (!latest) return 'empty'
    const what = latest['Failure'] || latest['Error'] || latest['Goal'] || latest['Done'] || latest['What I investigated'] || latest['Investigated'] || latest['What I built'] || latest['What I changed'] || latest['What changed'] || latest['What improved'] || latest['What I found'] || latest['Finding'] || latest['Key finding'] || latest['Suggested next move'] || ''
    return latest.signature || `${latest.num ?? ''}|${latest.date ?? ''}|${latest.type ?? ''}|${what}|${runs.length}`
  }

  const noteLatestRun = (id, runs) => {
    const signature = latestRunSignature(runs)
    const prev = runSignatureBySlotRef.current[id]
    if (prev != null && signature !== prev) {
      setAiTriggersBySlot(current => ({ ...current, [id]: (current[id] || 0) + 1 }))
    }
    runSignatureBySlotRef.current[id] = signature
  }

  const fetchHostRuns = () => fetch('/api/runs').then(r => r.json()).then(runs => {
    setHostRuns(runs)
    noteLatestRun('core', runs)
  }).catch(() => {})
  const fetchLabSchedule = () => fetch('/api/lab/schedule').then(r => r.json()).then(d => { if (d.ok) setLabSchedule(d) }).catch(() => {})
  const fetchProjects = () => fetch('/api/projects/list').then(r => r.json()).then(d => { if (d.ok) setProjects(d.projects) }).catch(() => {})

  const fetchIncubators = async () => {
    try {
      const d = await fetch('/api/incubators').then(r => r.json())
      if (d.ok) {
        setIncubators(d.slots)
        for (const slot of d.slots) fetchSlotRuns(slot.id)
      }
    } catch {}
  }

  const fetchSlotRuns = async (id) => {
    try {
      const d = await fetch(`/api/incubators/${id}/runs`).then(r => r.json())
      if (d.ok) {
        setRunsBySlot(prev => ({ ...prev, [id]: d.runs }))
        noteLatestRun(id, d.runs)
      }
    } catch {}
  }

  const fetchRunStates = async () => {
    try {
      const d = await fetch('/api/run/status').then(r => r.json())
      setLabRunning(!!d.running)
      if (d.running && d.startTime) labStartTimeRef.current = d.startTime
    } catch {}
  }

  useEffect(() => {
    fetchHostStatus(); fetchHostRuns(); fetchLabSchedule(); fetchProjects(); fetchIncubators(); fetchRunStates()
    const hostStream = new EventSource('/api/runs/stream')
    hostStream.onmessage = () => { fetchHostRuns(); fetchHostStatus(); fetchRunStates() }
    const incStream = new EventSource('/api/incubators/stream')
    incStream.onmessage = () => { fetchIncubators() }
    const poll = setInterval(() => {
      fetchHostStatus(); fetchHostRuns(); fetchLabSchedule(); fetchProjects(); fetchIncubators(); fetchRunStates()
    }, 30000)
    return () => { hostStream.close(); incStream.close(); clearInterval(poll) }
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (labRunning && labStartTimeRef.current) setLabElapsed(Math.floor((Date.now() - labStartTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [labRunning])

  const handleLabRun = async () => {
    if (labLaunching || labRunning) return
    setLabLaunching(true)
    try {
      const runner = labSchedule?.runner || hostStatus?.runner || 'codex'
      const preflight = await fetch(`/api/run/preflight?runner=${encodeURIComponent(runner)}`).then(r => r.json())
      setPreflightBySlot(prev => ({ ...prev, core: preflight }))
      if (!preflight.ok) {
        setLaunchErrors(prev => ({ ...prev, core: firstPreflightIssue(preflight) }))
        return
      }
      setLaunchErrors(prev => ({ ...prev, core: null }))
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(firstPreflightIssue(data.preflight) || data.error || 'failed to launch host runner')
      if (data.ok) { labStartTimeRef.current = Date.now(); setLabElapsed(0); setLabRunning(true) }
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, core: err.message }))
    } finally {
      setTimeout(() => setLabLaunching(false), 800)
    }
  }

  const updateLabSchedule = async (enabled) => {
    try {
      const d = await fetch('/api/lab/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalHours: labSchedule?.intervalHours || 0.5, runner: labSchedule?.runner || hostStatus?.runner || 'codex' }),
      }).then(r => r.json())
      if (d.ok) setLabSchedule(d)
    } catch {}
  }

  const updateLabRunner = async (runner) => {
    try {
      const d = await fetch('/api/lab/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: labSchedule?.enabled ?? false, intervalHours: labSchedule?.intervalHours || 0.5, runner }),
      }).then(r => r.json())
      if (d.ok) setLabSchedule(d)
    } catch {}
  }

  const runProjectSlot = async (id) => {
    try {
      const preflight = await fetch(`/api/incubators/${id}/preflight`).then(r => r.json())
      setPreflightBySlot(prev => ({ ...prev, [id]: preflight }))
      if (!preflight.ok) {
        setLaunchErrors(prev => ({ ...prev, [id]: firstPreflightIssue(preflight) }))
        return
      }
      setLaunchErrors(prev => ({ ...prev, [id]: null }))
      const res = await fetch(`/api/incubators/${id}/run`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || data.ok === false) throw new Error(firstPreflightIssue(data.preflight) || data.error || 'failed to launch incubator')
      await fetchIncubators()
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, [id]: err.message }))
    }
  }

  const updateProjectSchedule = async (slot, enabled) => {
    try {
      const d = await fetch(`/api/incubators/${slot.id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalHours: slot.intervalHours || 0.5 }),
      }).then(r => r.json())
      if (d.ok) await fetchIncubators()
    } catch {}
  }

  const updateProjectRunner = async (slot, runner) => {
    try {
      const d = await fetch(`/api/incubators/${slot.id}/runner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      }).then(r => r.json())
      if (d.ok) await fetchIncubators()
    } catch {}
  }

  const addIncubator = async (project) => {
    setSwitching(true)
    try {
      const d = await fetch('/api/incubators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, enabled: false, intervalHours: 0.5 }),
      }).then(r => r.json())
      if (d.ok) {
        setSelected(project)
        setAddOpen(false)
        await fetchIncubators()
      }
    } catch {} finally {
      setSwitching(false)
    }
  }

  const createIncubatorFromIdea = async () => {
    const idea = newIdea.trim()
    if (idea.length < 8 || creatingIdea) return
    setCreatingIdea(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/incubators/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed to create incubator')
      setNewIdea('')
      setSelected(data.slot?.id || data.slot?.project || 'core')
      setAddOpen(false)
      await fetchProjects()
      await fetchIncubators()
    } catch (err) {
      setCreateError(err.message)
    } finally {
      setCreatingIdea(false)
    }
  }
  const removeIncubator = async (id) => {
    if (id === 'rat-deposit') return
    try {
      await fetch(`/api/incubators/${id}`, { method: 'DELETE' })
      setSelected('core')
      await fetchIncubators()
    } catch {}
  }

  const sendProjectFeedback = async (id) => {
    const feedback = (steerTextBySlot[id] || '').trim()
    if (!feedback || steerStateBySlot[id] === 'saving') return
    setSteerStateBySlot(prev => ({ ...prev, [id]: 'saving' }))
    try {
      const endpoint = id === 'core' ? '/api/lab/feedback' : `/api/incubators/${id}/feedback`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed to save feedback')
      setSteerTextBySlot(prev => ({ ...prev, [id]: '' }))
      setSteerStateBySlot(prev => ({ ...prev, [id]: 'saved' }))
      setLaunchErrors(prev => ({ ...prev, [id]: null }))
      if (id === 'core') await fetchHostStatus()
      await fetchIncubators()
      setTimeout(() => {
        setSteerStateBySlot(prev => prev[id] === 'saved' ? ({ ...prev, [id]: null }) : prev)
      }, 1600)
    } catch (err) {
      setSteerStateBySlot(prev => ({ ...prev, [id]: 'error' }))
      console.warn('failed to save incubator feedback', err)
    }
  }
  const coreSlot = {
    id: 'core', type: 'Core Incubator', label: '∞', tone: 'core', name: hostStatus?.project || 'pi-pulse',
    runner: labSchedule?.runner || hostStatus?.runner, schedule: labSchedule, running: labRunning,
    elapsed: labElapsed, runCount: hostStatus?.runCount, charges: '∞', status: hostStatus, runs: hostRuns,
    latestUserFeedback: hostStatus?.latestUserFeedback, feedbackUpdatedAt: hostStatus?.feedbackUpdatedAt,
    onRun: handleLabRun, onToggle: () => updateLabSchedule(!labSchedule?.enabled), launching: labLaunching,
    availableRunners: ['codex', 'claude'],
    onRunnerChange: updateLabRunner,
  }

  const projectSlots = incubators.map(slot => ({
    ...slot,
    tone: 'project',
    type: slot.project === 'race-whisperer-predict' ? 'Analysis Incubator' : 'Project Incubator',
    label: slot.project?.slice(0, 1)?.toUpperCase() || 'P',
    name: slot.project || slot.id,
    schedule: slot,
    status: slot,
    runs: runsBySlot[slot.id] || [],
    running: slot.running?.running,
    elapsed: slot.running?.elapsed || 0,
    onRun: () => runProjectSlot(slot.id),
    onToggle: () => updateProjectSchedule(slot, !slot.enabled),
    onRunnerChange: (runner) => updateProjectRunner(slot, runner),
    launching: false,
  }))

  const slots = [coreSlot, ...projectSlots]
  const activeSlot = slots.find(s => s.id === selected) || slots[0]
  const displayRuns = (activeSlot.runs || []).slice(-5).reverse()
  const nextRunNum = (activeSlot.runCount ?? activeSlot.runs?.length ?? 0) + 1
  const color = activeSlot.tone === 'core' ? '#22d3ee' : '#a78bfa'
  const existingIds = new Set(incubators.map(s => s.id))
  const addableProjects = projects.filter(p => !existingIds.has(p.dir))
  const activePreflight = preflightBySlot[activeSlot.id]
  const readinessIssue = launchErrors[activeSlot.id] || firstPreflightIssue(activePreflight)

  useEffect(() => {
    let cancelled = false
    const runner = activeSlot.runner || activeSlot.schedule?.runner || 'codex'
    const url = activeSlot.id === 'core'
      ? `/api/run/preflight?runner=${encodeURIComponent(runner)}`
      : `/api/incubators/${activeSlot.id}/preflight`
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (!cancelled) setPreflightBySlot(prev => ({ ...prev, [activeSlot.id]: d }))
      })
      .catch(err => {
        if (!cancelled) setLaunchErrors(prev => ({ ...prev, [activeSlot.id]: err.message }))
      })
    return () => { cancelled = true }
  }, [activeSlot.id, activeSlot.runner, activeSlot.schedule?.runner])

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.3 }} className="panel" style={{ padding: 0, overflow: 'visible', position: 'relative' }}>
      {switching && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(8,8,8,0.85)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 'inherit' }}>
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #a78bfa', borderTopColor: 'transparent' }} />
          <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(167,139,250,0.8)', letterSpacing: '0.1em' }}>updating slots…</span>
        </div>
      )}

      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.08))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>Incubator Deck</div>
            <div style={{ marginTop: 4, fontSize: '0.75rem', color: 'rgba(148,163,184,0.66)', lineHeight: 1.35 }}>Each chamber has its own project, runner, timer, and run history.</div>
          </div>
          <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.48)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {slots.filter(s => s.schedule?.enabled).length} active · {projectSlots.length} project slots
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
          {slots.map(slot => (
            <div key={slot.id} onClick={() => setSelected(slot.id)} style={{ cursor: 'pointer', borderRadius: 9, outline: selected === slot.id ? `1px solid ${slot.tone === 'core' ? '#22d3ee66' : '#a78bfa66'}` : '1px solid transparent', outlineOffset: 2 }}>
              <IncubatorSlot slot={slot} onToggle={(e) => { e?.stopPropagation?.(); slot.onToggle() }} onRun={(e) => { e?.stopPropagation?.(); slot.onRun() }} />
            </div>
          ))}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setAddOpen(o => !o)} style={{ width: '100%', minHeight: 98, border: '1px dashed rgba(148,163,184,0.24)', borderRadius: 8, background: 'rgba(8,10,14,0.42)', color: 'rgba(148,163,184,0.62)', cursor: 'pointer', display: 'grid', placeItems: 'center', gap: 4 }}>
              <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>+</span>
              <span style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Add Incubator</span>
            </button>
            {addOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20, minWidth: 330, maxWidth: 380, background: '#111118', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
                <div style={{ padding: 8, display: 'grid', gap: 7, borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 6 }}>
                  <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(167,139,250,0.84)' }}>Create from idea</div>
                  <textarea
                    value={newIdea}
                    onChange={e => { setNewIdea(e.target.value); setCreateError(null) }}
                    rows={4}
                    placeholder="Write the project idea here..."
                    style={{ resize: 'vertical', minHeight: 78, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.28)', color: 'rgba(241,245,249,0.84)', padding: '8px 9px', fontSize: '0.72rem', lineHeight: 1.35, outline: 'none' }}
                  />
                  {createError && <div style={{ fontSize: '0.62rem', color: 'rgba(248,113,113,0.82)', fontFamily: 'monospace' }}>{createError}</div>}
                  <button
                    onClick={createIncubatorFromIdea}
                    disabled={creatingIdea || newIdea.trim().length < 8}
                    style={{ border: '1px solid rgba(167,139,250,0.32)', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', borderRadius: 6, padding: '7px 9px', cursor: (creatingIdea || newIdea.trim().length < 8) ? 'not-allowed' : 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: (creatingIdea || newIdea.trim().length < 8) ? 0.5 : 1 }}
                  >
                    {creatingIdea ? 'creating...' : 'create incubator'}
                  </button>
                </div>
                <div style={{ padding: '3px 8px 6px', fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(71,85,105,0.58)' }}>Existing projects</div>
                {addableProjects.length === 0 ? <div style={{ padding: 10, fontSize: '0.7rem', color: 'rgba(148,163,184,0.5)' }}>no available projects</div> : addableProjects.map(p => (
                  <button key={p.dir} onClick={() => addIncubator(p.dir)} style={{ width: '100%', border: 'none', background: 'transparent', padding: '8px 10px', textAlign: 'left', cursor: 'pointer', borderRadius: 6 }}>
                    <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(241,245,249,0.78)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{p.name}</div>
                    <div style={{ marginTop: 2, fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.55)' }}>{p.phase || 'project'} · run #{p.runCount ?? 0}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: '13px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9, background: activeSlot.running ? `color-mix(in srgb, ${color} 4%, transparent)` : 'transparent' }}>
        <motion.div animate={activeSlot.running ? { opacity: [1, 0.3, 1] } : { opacity: 0.7 }} transition={{ duration: 1.4, repeat: activeSlot.running ? Infinity : 0, ease: 'easeInOut' }} style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: activeSlot.running ? color : '#22c55e', boxShadow: activeSlot.running ? `0 0 8px ${color}` : 'none' }} />
        <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color }}>{activeSlot.type}</span>
        <span style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)' }}>·</span>
        <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(241,245,249,0.82)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{activeSlot.name}</span>
        {activeSlot.phase && <span style={{ fontSize: '0.54rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.42)', letterSpacing: '0.08em', textTransform: 'uppercase', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px' }}>{activeSlot.phase}</span>}
        {activeSlot.playUrl && <a href={activeSlot.playUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.56rem', fontFamily: 'monospace', color, textTransform: 'uppercase', letterSpacing: '0.08em', textDecoration: 'none' }}>open</a>}
        {activeSlot.id !== 'core' && activeSlot.id !== 'rat-deposit' && <button onClick={() => removeIncubator(activeSlot.id)} style={{ border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.05)', color: 'rgba(248,113,113,0.72)', borderRadius: 4, padding: '1px 6px', fontSize: '0.54rem', fontFamily: 'monospace', cursor: 'pointer' }}>remove</button>}
        <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontFamily: 'monospace', color: activeSlot.running ? color : 'rgba(71,85,105,0.48)' }}>{activeSlot.running ? `running · ${fmtElapsed(activeSlot.elapsed)}` : `run #${activeSlot.runCount ?? activeSlot.runs?.length ?? 0} · ${activeSlot.lastRun ?? activeSlot.status?.lastRun ?? '—'}`}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px minmax(260px, 310px)' }} className="max-md:!block">
        <div style={{ padding: '16px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>Run History</div>
            <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{activeSlot.id === 'core' ? 'host log' : 'project log'}</div>
          </div>
          {displayRuns.length === 0 ? <div style={{ fontSize: '0.75rem', color: 'rgba(71,85,105,0.35)', fontFamily: 'monospace' }}>no runs yet</div> : displayRuns.map((run, i) => {
            const runColor = TYPE_COLOR[run.type] ?? 'rgba(71,85,105,0.5)'
            const what = run['Failure'] || run['Error'] || run['Goal'] || run['Done'] || run['What I investigated'] || run['Investigated'] || run['What I built'] || run['What I changed'] || run['What changed'] || run['What improved'] || run['What I found'] || run['Finding'] || run['Key finding'] || run['Suggested next move'] || 'stdout captured with no summary'
            const failureDetail = run.type === 'FAILED' ? (run.detail || what) : ''
            const summaryLimit = run.type === 'FAILED' ? 180 : 92
            const isLast = i === displayRuns.length - 1
            return <div key={`${activeSlot.id}-${run.signature || `${run.num}-${run.date}-${run.type}-${run.attempt || i}`}`} style={{ display: 'flex', gap: 10, paddingBottom: isLast ? 0 : 14, position: 'relative' }}>
              {!isLast && <div style={{ position: 'absolute', left: 3, top: 9, bottom: 0, width: 1, background: 'linear-gradient(to bottom, var(--border), transparent)' }} />}
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: runColor, flexShrink: 0, marginTop: 3, boxShadow: `0 0 5px ${runColor}66` }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}><span style={{ fontSize: '0.57rem', fontFamily: 'monospace', color: runColor, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{run.type ?? 'run'}</span><span style={{ fontSize: '0.57rem', color: 'rgba(71,85,105,0.5)' }}>#{run.num} {run.date}{runAttemptText(run)}</span></div>
                <div style={{ fontSize: '0.77rem', color: 'rgba(241,245,249,0.72)', lineHeight: 1.4 }}>{what.length > summaryLimit ? what.slice(0, summaryLimit) + '…' : what}</div>
                {failureDetail && (
                  <pre style={{ margin: '6px 0 0', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderLeft: `2px solid ${runColor}`, padding: '6px 8px', background: 'rgba(248,113,113,0.055)', color: 'rgba(254,202,202,0.86)', fontSize: '0.64rem', lineHeight: 1.45, fontFamily: 'monospace' }}>{failureDetail}</pre>
                )}
              </div>
            </div>
          })}
        </div>
        <div className="max-md:hidden" style={{ background: 'var(--border)', margin: '12px 0' }} />
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {(activeSlot.current_focus || activeSlot.status?.current_focus) && <div><div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>Focus</div><div style={{ fontSize: '0.77rem', color: 'rgba(241,245,249,0.78)', lineHeight: 1.45 }}>{activeSlot.current_focus || activeSlot.status?.current_focus}</div></div>}
          {(activeSlot.next_run_goal || activeSlot.status?.next_run_goal) && <div><div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>Next</div><div style={{ fontSize: '0.72rem', color: 'rgba(71,85,105,0.75)', lineHeight: 1.4 }}>{((activeSlot.next_run_goal || activeSlot.status?.next_run_goal) || '').slice(0, 130)}</div></div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', minWidth: 44 }}>Runner</div>
            <RunnerSwitch
              value={activeSlot.runner || activeSlot.schedule?.runner || 'script'}
              available={activeSlot.availableRunners || ['codex', 'claude']}
              disabled={activeSlot.running}
              onChange={activeSlot.onRunnerChange}
            />
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)' }}>Steer</div>
                {steerStateBySlot[activeSlot.id] === 'saved' && <span style={{ fontSize: '0.55rem', fontFamily: 'monospace', color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>saved</span>}
                {steerStateBySlot[activeSlot.id] === 'error' && <span style={{ fontSize: '0.55rem', fontFamily: 'monospace', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.08em' }}>error</span>}
              </div>
              {activeSlot.latestUserFeedback && (
                <div style={{ borderLeft: '2px solid rgba(167,139,250,0.35)', paddingLeft: 8, fontSize: '0.66rem', color: 'rgba(148,163,184,0.68)', lineHeight: 1.35 }}>
                  latest: {activeSlot.latestUserFeedback.length > 120 ? activeSlot.latestUserFeedback.slice(0, 120) + '...' : activeSlot.latestUserFeedback}
                </div>
              )}
              <textarea
                value={steerTextBySlot[activeSlot.id] || ''}
                onChange={e => setSteerTextBySlot(prev => ({ ...prev, [activeSlot.id]: e.target.value }))}
                rows={4}
                placeholder="I like where this is heading, but I am missing..."
                style={{ resize: 'vertical', minHeight: 82, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.22)', color: 'rgba(241,245,249,0.84)', padding: '8px 9px', fontSize: '0.72rem', lineHeight: 1.35, outline: 'none' }}
              />
              <button
                onClick={() => sendProjectFeedback(activeSlot.id)}
                disabled={steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()}
                style={{ border: '1px solid rgba(167,139,250,0.3)', background: 'rgba(167,139,250,0.09)', color: '#a78bfa', borderRadius: 6, padding: '7px 9px', cursor: (steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()) ? 'not-allowed' : 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: (steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()) ? 0.52 : 1 }}
              >
                {steerStateBySlot[activeSlot.id] === 'saving' ? 'saving...' : 'save feedback for next run'}
              </button>
            </div>
          {readinessIssue && (
            <div style={{ border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.055)', borderRadius: 6, padding: '7px 9px' }}>
              <div style={{ fontSize: '0.56rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(248,113,113,0.78)', marginBottom: 3 }}>Runner blocked</div>
              <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.86)' }}>{readinessIssue}</div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', minWidth: 44 }}>Sched</div><div style={{ flex: 1, fontSize: '0.72rem', fontFamily: 'monospace', color: activeSlot.schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.35)' }}>{activeSlot.schedule?.enabled ? `every ${fmtInterval(activeSlot.schedule.intervalHours)} · next ${fmtCountdown(activeSlot.schedule.nextRunAt)}` : 'off'}</div><button onClick={activeSlot.onToggle} style={{ background: 'none', border: `1px solid ${activeSlot.schedule?.enabled ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', letterSpacing: '0.06em', color: activeSlot.schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.5)' }}>{activeSlot.schedule?.enabled ? 'pause' : 'start'}</button></div>
          <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={activeSlot.onRun} disabled={activeSlot.launching || activeSlot.running} style={{ marginTop: 'auto', width: '100%', padding: '10px 14px', borderRadius: 9, border: `1px solid ${color}45`, background: `${color}14`, cursor: (activeSlot.launching || activeSlot.running) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 10, opacity: (activeSlot.launching || activeSlot.running) ? 0.72 : 1 }}><div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>{activeSlot.launching || activeSlot.running ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" /></svg></motion.div> : <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>}</div><div style={{ textAlign: 'left' }}><div style={{ fontSize: '0.8rem', fontWeight: 600, color, letterSpacing: '0.04em' }}>{activeSlot.launching ? 'STARTING…' : activeSlot.running ? 'INCUBATING' : 'RUN INCUBATOR'}</div><div style={{ fontSize: '0.65rem', color: 'rgba(71,85,105,0.65)', marginTop: 1 }}>{activeSlot.running ? `${fmtElapsed(activeSlot.elapsed)} elapsed` : `run #${nextRunNum} · ${(activeSlot.lastRunType || activeSlot.status?.lastRunType || 'mutate').toLowerCase()} next`}</div></div></motion.button>
        </div>
      </div>
      <div style={{ background: 'rgba(0,0,0,0.15)' }}><AiStrip slotId={activeSlot.id} autoTrigger={aiTriggersBySlot[activeSlot.id] || 0} /></div>
    </motion.div>
  )
}
