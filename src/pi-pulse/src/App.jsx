import { useEffect, useState } from 'react'
import { useSystemStats } from './hooks/useSystemStats.js'
import { NavShell } from './components/NavShell.jsx'
import { PulsePanel } from './components/PulsePanel.jsx'
import { ProjectPanel } from './components/ProjectPanel.jsx'
import { LabPanel } from './components/LabPanel.jsx'

// Ambient color thresholds — shifts the whole UI accent as load rises
const COOL   = { accent: '#22d3ee', dim: 'rgba(34,211,238,0.12)',  glow: 'rgba(34,211,238,0.35)'  }
const WARM   = { accent: '#fb923c', dim: 'rgba(251,146,60,0.12)',  glow: 'rgba(251,146,60,0.35)'  }
const HOT    = { accent: '#f87171', dim: 'rgba(248,113,113,0.12)', glow: 'rgba(248,113,113,0.35)' }

function applyAccent({ accent, dim, glow }) {
  const r = document.documentElement.style
  r.setProperty('--accent', accent)
  r.setProperty('--accent-dim', dim)
  r.setProperty('--accent-glow', glow)
}

// Circadian ambient — bloom opacity and vertical position follow the time of day.
// Night: dim and receded. Dawn: rising. Day: full presence. Dusk: fading.
function useCircadian() {
  const compute = () => {
    const h = new Date().getHours() + new Date().getMinutes() / 60
    if (h >= 22 || h < 5) return { opacity: 0.07, top: '-6vh' }   // deep night — receded
    if (h < 8) {                                                    // dawn — rising
      const p = (h - 5) / 3
      return { opacity: 0.07 + p * 0.09, top: `${(-6 + p * 6).toFixed(1)}vh` }
    }
    if (h < 18) return { opacity: 0.16, top: '0vh' }               // day — full presence
    const p = (h - 18) / 4                                         // dusk — fading
    return { opacity: 0.16 - p * 0.09, top: `${(-p * 6).toFixed(1)}vh` }
  }
  const [state, setState] = useState(compute)
  useEffect(() => {
    const id = setInterval(() => setState(compute()), 60_000)
    return () => clearInterval(id)
  }, [])
  return state
}

function fmtBytes(b) {
  if (b == null) return '—'
  if (b < 1024) return `${b} B/s`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB/s`
  return `${(b / 1024 / 1024).toFixed(1)} MB/s`
}

function SystemStrip({ stats, latestTemp, connected }) {
  const disk = stats?.disk?.percent ?? null
  const memory = stats?.memory?.percent ?? null
  const cpu = stats?.cpu ?? null
  const hot = latestTemp > 70 || cpu > 85
  const diskHigh = disk != null && disk > 88
  const status = hot ? 'hot' : diskHigh ? 'disk pressure' : connected ? 'safe' : 'offline'
  const statusColor = hot ? '#f87171' : diskHigh ? '#fb923c' : connected ? '#22c55e' : '#64748b'

  const metric = (label, value, color = 'rgba(226,232,240,0.72)') => (
    <div style={{ display: 'grid', gap: 2, minWidth: 64 }}>
      <span style={{ fontSize: '0.52rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(71,85,105,0.62)' }}>
        {label}
      </span>
      <strong style={{ fontSize: '0.78rem', fontFamily: 'monospace', color, fontWeight: 650, lineHeight: 1 }}>
        {value}
      </strong>
    </div>
  )

  return (
    <div
      className="panel"
      style={{
        padding: '10px 16px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 140, flex: '1 1 160px' }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: `0 0 10px ${statusColor}66`,
          flexShrink: 0,
        }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.14em', color: statusColor }}>
            {status}
          </div>
          <div style={{ marginTop: 2, fontSize: '0.62rem', color: 'rgba(148,163,184,0.56)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {stats?.hostname ?? 'pi'} · {stats?.uptimeFormatted ?? '—'}
          </div>
        </div>
      </div>
      {metric('cpu', cpu == null ? '—' : `${cpu}%`, cpu > 65 ? '#fb923c' : undefined)}
      {metric('temp', latestTemp == null ? '—' : `${latestTemp.toFixed(1)}°`, latestTemp > 60 ? '#fb923c' : undefined)}
      {metric('mem', memory == null ? '—' : `${memory}%`)}
      {metric('disk', disk == null ? '—' : `${disk}%`, diskHigh ? '#fb923c' : undefined)}
      {metric('net ↓', fmtBytes(stats?.net?.rx), '#22d3ee')}
      {metric('net ↑', fmtBytes(stats?.net?.tx), '#a78bfa')}
    </div>
  )
}

function CollapsiblePulse({ stats, history, tempHistory, netRxHistory, netTxHistory }) {
  const [open, setOpen] = useState(false)

  return (
    <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--accent)',
          boxShadow: '0 0 10px var(--accent-glow)',
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>
            System Pulse
          </div>
          <div style={{ marginTop: 3, fontSize: '0.72rem', color: 'rgba(148,163,184,0.58)' }}>
            Full telemetry chamber, expanded only when you need the diagnostics.
          </div>
        </div>
        <span style={{ fontSize: '0.64rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.55)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {open ? 'hide' : 'open'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          <PulsePanel stats={stats} history={history} tempHistory={tempHistory} netRxHistory={netRxHistory} netTxHistory={netTxHistory} />
        </div>
      )}
    </section>
  )
}

export default function App() {
  const { stats, history, tempHistory, netRxHistory, netTxHistory, connected } = useSystemStats()
  const [runCount, setRunCount] = useState(null)
  const [activeTab, setActiveTab] = useState('pulse')
  const circadian = useCircadian()

  useEffect(() => {
    const fetchCount = () =>
      fetch('/api/project/status')
        .then(r => r.json())
        .then(d => setRunCount(d.runCount))
        .catch(() => {})

    fetchCount()
    const es = new EventSource('/api/runs/stream')
    es.onmessage = fetchCount
    return () => es.close()
  }, [])

  // Ambient color mode — whole UI heats up with CPU/temp
  useEffect(() => {
    const cpu  = stats?.cpu ?? 0
    const temp = tempHistory.at(-1) ?? 40
    if (cpu > 85 || temp > 75) {
      applyAccent(HOT)
    } else if (cpu > 65 || temp > 60) {
      applyAccent(WARM)
    } else {
      applyAccent(COOL)
    }
  }, [stats?.cpu, tempHistory.length])

  const latestTemp = tempHistory.at(-1)
  const tempColor = latestTemp > 75 ? '#f87171' : latestTemp > 60 ? '#fb923c' : 'rgba(71,85,105,0.4)'

  return (
    <>
      {/* Ambient bloom — fixed radial glow behind all content, shifts with heat and time of day */}
      <div
        className="pointer-events-none"
        style={{
          position: 'fixed',
          top: circadian.top,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(1200px, 130vw)',
          height: '65vh',
          background: 'radial-gradient(ellipse at 50% 0%, var(--accent-glow), transparent 65%)',
          opacity: circadian.opacity,
          zIndex: 0,
          transition: 'opacity 90s ease, top 90s ease',
        }}
      />

      <div
        className="min-h-screen flex flex-col"
        style={{ maxWidth: 1100, margin: '0 auto', position: 'relative', zIndex: 1 }}
      >
        <NavShell
          hostname={stats?.hostname}
          connected={connected}
          uptime={stats?.uptimeFormatted}
          runCount={runCount}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        <main className="flex-1 flex flex-col gap-4 p-4 sm:p-6">
          {activeTab === 'pulse' ? (
            <>
              <SystemStrip stats={stats} latestTemp={latestTemp} connected={connected} />

              {/* Incubator deck — host and mounted project loops */}
              <ProjectPanel />

              <CollapsiblePulse
                stats={stats}
                history={history}
                tempHistory={tempHistory}
                netRxHistory={netRxHistory}
                netTxHistory={netTxHistory}
              />
            </>
          ) : (
            <LabPanel />
          )}
        </main>

        {/* Device status strip — identity left, heat state right */}
        <footer
          style={{
            borderTop: '1px solid var(--border)',
            padding: '7px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(0,0,0,0.3)',
          }}
        >
          <span
            className="font-mono"
            style={{ fontSize: '0.62rem', color: 'rgba(71,85,105,0.28)', letterSpacing: '0.04em' }}
          >
            {stats?.arch ?? 'arm64'} · {stats?.platform ?? 'linux'}
          </span>

          {latestTemp != null && (
            <span className="font-mono" style={{ fontSize: '0.62rem', color: tempColor }}>
              {latestTemp.toFixed(1)}°C
            </span>
          )}
        </footer>
      </div>
    </>
  )
}
