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

function parseAnalysis(text) {
  const fields = {}
  const re = /([A-Z]{2,}[A-Z\s]*):\s*\n?([\s\S]*?)(?=\n[A-Z]{2,}[A-Z\s]*:|$)/g
  let m
  while ((m = re.exec(text.replace(/\*\*/g, '').replace(/\r/g, ''))) !== null) {
    const key = m[1].trim().toUpperCase()
    const val = m[2].trim().replace(/\n+/g, ' ')
    if (val && AI_FIELD_META.some(f => f.key === key)) fields[key] = val
  }
  return fields
}

function AiStrip({ autoTrigger }) {
  const [open, setOpen]         = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [lastRun, setLastRun]   = useState(null)
  const prevTriggerRef          = useRef(0)

  useEffect(() => {
    fetch('/api/child/ai/latest').then(r => r.json()).then(d => {
      if (d.ok && d.response) {
        setAnalysis(parseAnalysis(d.response))
        setLastRun(new Date(d.ts).toLocaleTimeString())
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (autoTrigger > prevTriggerRef.current && !loading) {
      prevTriggerRef.current = autoTrigger
      runAnalysis()
    }
  }, [autoTrigger])

  async function runAnalysis(e) {
    e?.stopPropagation()
    setLoading(true)
    setError(null)
    setOpen(true)
    try {
      const r = await fetch('/api/child/ai/analyze', { method: 'POST' })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || 'failed')
      setAnalysis(parseAnalysis(d.response))
      setLastRun(new Date().toLocaleTimeString())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const active = loading || !!analysis

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
          AI HAT+ 2
        </span>
        <motion.div
          animate={analysis ? { opacity: [1, 0.3, 1] } : {}}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          style={{ width: 5, height: 5, borderRadius: '50%', background: error ? '#ef4444' : '#22c55e', flexShrink: 0 }}
        />
        <span style={{ flex: 1, fontSize: '0.67rem', fontFamily: 'monospace',
          color: !open && analysis?.DIRECTION ? 'rgba(241,245,249,0.55)' : 'rgba(71,85,105,0.4)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {!open && analysis?.DIRECTION
            ? (analysis.DIRECTION.length > 60 ? analysis.DIRECTION.slice(0, 60) + '…' : analysis.DIRECTION)
            : !open && loading ? 'analyzing…' : !open ? 'ready' : ''}
        </span>
        <button onClick={e => { e.stopPropagation(); runAnalysis() }} disabled={loading}
          title="Re-analyze"
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
                  color: analysis?.[f.key] ? 'rgba(241,245,249,0.85)' : 'rgba(71,85,105,0.32)' }}>
                  {analysis?.[f.key] ?? '—'}
                </span>
              )}
            </div>
          ))}
          {lastRun && !loading && (
            <div style={{ paddingTop: 7, borderTop: '1px solid rgba(255,255,255,0.04)', marginTop: 2 }}>
              <span style={{ fontSize: '0.59rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)' }}>
                last run {lastRun} · qwen2.5-instruct:1.5b
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

export function ProjectPanel() {
  const [status, setStatus]   = useState(null)
  const [runs, setRuns]       = useState([])
  const [running, setRunning] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [aiTrigger, setAiTrigger] = useState(0)
  const [projects, setProjects]   = useState([])
  const [switchOpen, setSwitchOpen] = useState(false)
  const [switching, setSwitching]   = useState(false)
  const [schedule, setSchedule]     = useState(null)
  const switchRef = useRef(null)
  const startTimeRef = useRef(null)
  const prevRunCountRef = useRef(0)

  const fetchStatus = () =>
    fetch('/api/child/status').then(r => r.json()).then(setStatus).catch(() => {})

  const fetchRuns = () =>
    fetch('/api/child/runs').then(r => r.json()).then(setRuns).catch(() => {})

  const fetchProjects = () =>
    fetch('/api/projects/list').then(r => r.json()).then(d => { if (d.ok) setProjects(d.projects) }).catch(() => {})

  const fetchSchedule = () =>
    fetch('/api/child/schedule').then(r => r.json()).then(d => { if (d.ok) setSchedule(d) }).catch(() => {})

  useEffect(() => {
    fetchStatus()
    fetchRuns()
    fetchProjects()
    fetchSchedule()
    const es = new EventSource('/api/child/runs/stream')
    es.onmessage = () => { fetchRuns(); fetchStatus() }
    const poll = setInterval(() => { fetchStatus(); fetchRuns(); fetchSchedule() }, 30000)
    return () => { es.close(); clearInterval(poll) }
  }, [])

  // Close switcher on outside click
  useEffect(() => {
    if (!switchOpen) return
    const handler = (e) => { if (switchRef.current && !switchRef.current.contains(e.target)) setSwitchOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [switchOpen])

  const handleMount = async (dir) => {
    if (switching) return
    setSwitchOpen(false)
    setSwitching(true)
    try {
      await fetch('/api/projects/mount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir }),
      })
      // Server restarts — poll until it's back, then reload
      const waitForRestart = async () => {
        await new Promise(r => setTimeout(r, 1200))
        for (let i = 0; i < 20; i++) {
          try {
            const r = await fetch('/api/health')
            if (r.ok) { window.location.reload(); return }
          } catch {}
          await new Promise(r => setTimeout(r, 600))
        }
        setSwitching(false) // gave up
      }
      waitForRestart()
    } catch {
      setSwitching(false)
    }
  }

  // Auto-trigger AI after a new run appears
  useEffect(() => {
    if (runs.length > prevRunCountRef.current && prevRunCountRef.current > 0) {
      setAiTrigger(c => c + 1)
    }
    prevRunCountRef.current = runs.length
  }, [runs.length])

  // Tick elapsed + poll run status while in flight
  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const tick = setInterval(() => {
      if (startTimeRef.current) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }
    }, 1000)
    const poll = setInterval(async () => {
      try {
        const r = await fetch('/api/child/run/status')
        const data = await r.json()
        if (!data.running) { setRunning(false); fetchRuns(); fetchStatus() }
      } catch {}
    }, 4000)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [running])

  const handleRun = async () => {
    if (launching || running) return
    setLaunching(true)
    try {
      const r = await fetch('/api/child/run', { method: 'POST' })
      const data = await r.json()
      if (data.ok) { startTimeRef.current = Date.now(); setElapsed(0); setRunning(true) }
    } catch {}
    setTimeout(() => setLaunching(false), 800)
  }

  const handleScheduleToggle = async () => {
    const enabled = !schedule?.enabled
    try {
      const r = await fetch('/api/child/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalHours: 2 }),
      })
      const d = await r.json()
      if (d.ok) setSchedule(d)
    } catch {}
  }

  const displayRuns = runs.slice(-4).reverse()
  const nextRunNum = (status?.runCount ?? runs.length) + 1

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.3 }}
      className="panel"
      style={{ padding: 0, overflow: 'visible', position: 'relative' }}
    >
      {/* Switching overlay */}
      {switching && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          background: 'rgba(8,8,8,0.85)', backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          borderRadius: 'inherit',
        }}>
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #a78bfa', borderTopColor: 'transparent' }} />
          <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(167,139,250,0.8)', letterSpacing: '0.1em' }}>
            reloading…
          </span>
        </div>
      )}

      {/* Header */}
      <div style={{
        padding: '11px 24px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
        background: running ? 'color-mix(in srgb, #a78bfa 4%, transparent)' : 'transparent',
        transition: 'background 0.5s ease',
        position: 'relative',
      }}>
        <motion.div
          animate={running ? { opacity: [1, 0.3, 1] } : { opacity: 0.7 }}
          transition={{ duration: 1.4, repeat: running ? Infinity : 0, ease: 'easeInOut' }}
          style={{
            width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
            background: running ? '#a78bfa' : '#22c55e',
            boxShadow: running ? '0 0 7px #a78bfa' : 'none',
          }}
        />

        {/* Project name — clickable to open switcher */}
        <div ref={switchRef} style={{ position: 'relative' }}>
          <button
            onClick={() => { if (!running && projects.length > 1) setSwitchOpen(o => !o) }}
            style={{
              background: 'none', border: 'none', padding: 0, margin: 0,
              display: 'flex', alignItems: 'center', gap: 5,
              cursor: (!running && projects.length > 1) ? 'pointer' : 'default',
            }}
            title={projects.length > 1 ? 'Switch project' : undefined}
          >
            <span style={{
              fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.14em',
              color: running ? '#a78bfa' : 'var(--muted)',
              transition: 'color 0.4s ease',
            }}>
              {status?.project ?? '…'}
            </span>
            {projects.length > 1 && !running && (
              <motion.svg animate={{ rotate: switchOpen ? 180 : 0 }} transition={{ duration: 0.15 }}
                width="8" height="8" viewBox="0 0 24 24" fill="none"
                stroke="rgba(71,85,105,0.5)" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="6 9 12 15 18 9" />
              </motion.svg>
            )}
          </button>

          {/* Dropdown */}
          {switchOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.12 }}
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
                background: '#111118', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8, padding: '4px 0', minWidth: 200,
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              }}
            >
              {projects.map(p => (
                <button key={p.dir} onClick={() => handleMount(p.dir)}
                  style={{
                    width: '100%', border: 'none',
                    padding: '7px 14px', cursor: 'pointer', textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: p.mounted ? 'rgba(167,139,250,0.06)' : 'transparent',
                  }}
                  onMouseEnter={e => { if (!p.mounted) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = p.mounted ? 'rgba(167,139,250,0.06)' : 'transparent' }}
                >
                  <div style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: p.mounted ? '#a78bfa' : 'rgba(71,85,105,0.4)',
                  }} />
                  <div>
                    <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', fontWeight: p.mounted ? 600 : 400,
                      color: p.mounted ? '#a78bfa' : 'rgba(241,245,249,0.72)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {p.name}
                    </div>
                    {p.phase && (
                      <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.5)', marginTop: 1 }}>
                        {p.phase} · run #{p.runCount}
                      </div>
                    )}
                  </div>
                  {p.mounted && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.55rem', fontFamily: 'monospace',
                      color: 'rgba(167,139,250,0.5)', letterSpacing: '0.08em' }}>
                      MOUNTED
                    </span>
                  )}
                </button>
              ))}
            </motion.div>
          )}
        </div>

        <span style={{
          fontSize: '0.58rem', fontFamily: 'monospace',
          color: 'rgba(71,85,105,0.45)', marginLeft: 2,
        }}>
          · mounted project
        </span>
        {status?.phase && (
          <span style={{
            fontSize: '0.54rem', fontFamily: 'monospace',
            color: 'rgba(71,85,105,0.32)', letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4, padding: '1px 5px',
          }}>
            {status.phase}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontFamily: 'monospace', color: running ? '#a78bfa' : 'rgba(71,85,105,0.4)' }}>
          {running ? `running · ${fmtElapsed(elapsed)}` : status ? `run #${status.runCount} · ${status.lastRun ?? '—'}` : '—'}
        </span>
      </div>

      {/* Body */}
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1px minmax(240px, 280px)' }}
        className="max-md:!block"
      >
        {/* Left: timeline */}
        <div style={{ padding: '16px 24px' }}>
          <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)', marginBottom: 12 }}>
            Runs
          </div>

          {displayRuns.length === 0 ? (
            <div style={{ fontSize: '0.75rem', color: 'rgba(71,85,105,0.35)', fontFamily: 'monospace' }}>
              no runs yet
            </div>
          ) : displayRuns.map((run, i) => {
            const color = TYPE_COLOR[run.type] ?? 'rgba(71,85,105,0.5)'
            const what = run['Goal'] || run['Done'] || run['Investigated'] || run['What I changed'] || run['What I found'] || '—'
            const isLast = i === displayRuns.length - 1
            return (
              <div key={i} style={{ display: 'flex', gap: 10, paddingBottom: isLast ? 0 : 14, position: 'relative' }}>
                {!isLast && (
                  <div style={{
                    position: 'absolute', left: 3, top: 9, bottom: 0, width: 1,
                    background: 'linear-gradient(to bottom, var(--border), transparent)',
                  }} />
                )}
                <div style={{
                  width: 7, height: 7, borderRadius: '50%', background: color,
                  flexShrink: 0, marginTop: 3, boxShadow: `0 0 5px ${color}66`,
                }} />
                <div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: '0.57rem', fontFamily: 'monospace', color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {run.type ?? 'run'}
                    </span>
                    <span style={{ fontSize: '0.57rem', color: 'rgba(71,85,105,0.5)' }}>
                      #{run.num} {run.date}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.77rem', color: 'rgba(241,245,249,0.72)', lineHeight: 1.4 }}>
                    {what.length > 70 ? what.slice(0, 70) + '…' : what}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Divider */}
        <div className="max-md:hidden" style={{ background: 'var(--border)', margin: '12px 0' }} />

        {/* Right: focus + run button */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {status?.current_focus && (
            <div>
              <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>
                Focus
              </div>
              <div style={{ fontSize: '0.77rem', color: 'rgba(241,245,249,0.78)', lineHeight: 1.45 }}>
                {status.current_focus}
              </div>
            </div>
          )}

          {!status?.current_focus && status?.notes && (
            <div>
              <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>
                State
              </div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(241,245,249,0.68)', lineHeight: 1.45, fontFamily: 'monospace' }}>
                {status.notes.length > 130 ? status.notes.slice(0, 130) + '…' : status.notes}
              </div>
            </div>
          )}

          {status?.next_run_goal && (
            <div>
              <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>
                Next
              </div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(71,85,105,0.75)', lineHeight: 1.4 }}>
                {status.next_run_goal.length > 90 ? status.next_run_goal.slice(0, 90) + '…' : status.next_run_goal}
              </div>
            </div>
          )}

          {/* Auto-schedule row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', minWidth: 40 }}>
              Sched
            </div>
            <div style={{ flex: 1, fontSize: '0.72rem', fontFamily: 'monospace',
              color: schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.35)' }}>
              {schedule?.enabled
                ? `every ${schedule.intervalHours}h · next ${fmtCountdown(schedule.nextRunAt)}`
                : 'off'}
            </div>
            <button
              onClick={handleScheduleToggle}
              style={{
                background: 'none',
                border: `1px solid ${schedule?.enabled ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
                fontSize: '0.6rem', fontFamily: 'monospace', letterSpacing: '0.06em',
                color: schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.5)',
                transition: 'all 0.2s ease',
              }}
            >
              {schedule?.enabled ? 'stop' : 'start'}
            </button>
          </div>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleRun}
            disabled={launching || running}
            style={{
              marginTop: 'auto',
              width: '100%', padding: '10px 14px', borderRadius: 9,
              border: '1px solid color-mix(in srgb, #a78bfa 28%, transparent)',
              background: 'color-mix(in srgb, #a78bfa 8%, transparent)',
              cursor: (launching || running) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 10,
              opacity: (launching || running) ? 0.72 : 1,
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: 6, flexShrink: 0,
              background: 'color-mix(in srgb, #a78bfa 14%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#a78bfa',
            }}>
              {launching || running ? (
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
                  </svg>
                </motion.div>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </div>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#a78bfa', letterSpacing: '0.04em' }}>
                {launching ? 'STARTING…' : running ? 'RUNNING' : 'RUN PROJECT'}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(71,85,105,0.65)', marginTop: 1 }}>
                {running
                  ? `${fmtElapsed(elapsed)} elapsed`
                  : `run #${nextRunNum} · ${status?.lastRunType?.toLowerCase() ?? 'mutate'} next`}
              </div>
            </div>
          </motion.button>
        </div>
      </div>
      {/* AI analysis strip — same HAT+ 2, pointed at race-whisperer data */}
      <div style={{ background: 'rgba(0,0,0,0.15)' }}>
        <AiStrip autoTrigger={aiTrigger} />
      </div>
    </motion.div>
  )
}
