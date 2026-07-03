import { useEffect, useState } from 'react'
import { useSystemStats } from './hooks/useSystemStats.js'
import { NavShell } from './components/NavShell.jsx'
import { PulsePanel } from './components/PulsePanel.jsx'
import { BottomPanel } from './components/BottomPanel.jsx'
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
              {/* Central pulse — the soul of the dashboard */}
              <PulsePanel stats={stats} history={history} tempHistory={tempHistory} netRxHistory={netRxHistory} netTxHistory={netTxHistory} />

              {/* Unified lower panel — event log + controls + AI as one instrument surface */}
              <BottomPanel stats={stats} />

              {/* Child project — race-whisperer-predict, isolated from Pi Pulse itself */}
              <ProjectPanel />
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
