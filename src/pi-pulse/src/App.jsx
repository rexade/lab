import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { IncubatorDetail } from './components/IncubatorDetail.jsx'
import { LoopHero } from './components/LoopHero.jsx'
import { PulsePanel } from './components/PulsePanel.jsx'
import { Roster } from './components/Roster.jsx'
import { ServicesView } from './components/ServicesView.jsx'
import { TopBar } from './components/TopBar.jsx'
import { useIncubators } from './hooks/useIncubators.js'
import { useNow } from './hooks/useNow.js'
import { useSystemStats } from './hooks/useSystemStats.js'
import { fetchApiJson } from './lib/api.js'
import { awayDigest, localDay, loopHeadline, runsOnDay } from './lib/incubator.js'

const AMBIENT = {
  cool: { accent: '#22d3ee', glow: 'rgba(34,211,238,0.32)' },
  warm: { accent: '#fb923c', glow: 'rgba(251,146,60,0.32)' },
  hot: { accent: '#f87171', glow: 'rgba(248,113,113,0.34)' },
}
const TABS = ['lab', 'system', 'services']

function readStored(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

// Bloom presence follows the local time of day: receded at night, full by day.
function circadian(now) {
  const date = new Date(now)
  const h = date.getHours() + date.getMinutes() / 60
  if (h >= 22 || h < 5) return 0.55
  if (h < 8) return 0.55 + ((h - 5) / 3) * 0.45
  if (h < 18) return 1
  return 1 - ((h - 18) / 4) * 0.45
}

function useHealth() {
  const [health, setHealth] = useState(null)
  useEffect(() => {
    const load = () => fetchApiJson('/api/health', { cache: 'no-store' }).then(({ data }) => setHealth(data)).catch(() => setHealth(null))
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])
  return [health, setHealth]
}

function useTab() {
  const initial = TABS.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'lab'
  const [tab, setTab] = useState(initial)
  useEffect(() => {
    const onHash = () => TABS.includes(window.location.hash.slice(1)) && setTab(window.location.hash.slice(1))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const select = next => {
    setTab(next)
    window.history.replaceState(null, '', next === 'lab' ? window.location.pathname : `#${next}`)
  }
  return [tab, select]
}

// When you last looked: the moment the page was last hidden or closed. The
// hero summarises what the lab did since then.
function useLastVisit() {
  const [since] = useState(() => Number(readStored('pi-pulse.lastVisit', 0)) || Date.now() - 24 * 3600 * 1000)
  useEffect(() => {
    const mark = () => writeStored('pi-pulse.lastVisit', String(Date.now()))
    const onVisibility = () => { if (document.visibilityState === 'hidden') mark() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', mark)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', mark)
    }
  }, [])
  return since
}

export default function App() {
  const { stats, history, tempHistory, netRxHistory, netTxHistory, connected } = useSystemStats()
  const { slots, loaded, loadError, runsBySlot, historyErrors, preflightBySlot, actions } = useIncubators()
  const [health, setHealth] = useHealth()
  const [tab, setTab] = useTab()
  const [selectedId, setSelectedId] = useState(() => readStored('pi-pulse.selected', null))
  const [restarting, setRestarting] = useState(false)
  const now = useNow(1000)
  const lastVisit = useLastVisit()

  const headline = useMemo(() => loopHeadline(slots, { preflightBySlot, now }), [slots, preflightBySlot, now])
  const today = useMemo(() => runsOnDay(runsBySlot, localDay(new Date(now))), [runsBySlot, now])
  const away = useMemo(() => awayDigest(slots, runsBySlot, lastVisit), [slots, runsBySlot, lastVisit])
  const selected = slots.find(slot => slot.id === selectedId) || slots.find(slot => slot.id === headline.focusId) || slots[0] || null

  const select = id => {
    setSelectedId(id)
    writeStored('pi-pulse.selected', id)
  }

  useEffect(() => {
    const cpu = stats?.cpu ?? 0
    const temp = stats?.temperature ?? 40
    const level = cpu > 85 || temp > 75 ? 'hot' : cpu > 65 || temp > 60 ? 'warm' : 'cool'
    const root = document.documentElement.style
    root.setProperty('--accent', AMBIENT[level].accent)
    root.setProperty('--accent-glow', AMBIENT[level].glow)
  }, [stats?.cpu, stats?.temperature])

  const restart = async () => {
    setRestarting(true)
    try {
      setHealth(await actions.restartService())
    } catch {
      // The pill keeps offering the restart while the source is still stale.
    } finally {
      setRestarting(false)
    }
  }

  const running = headline.tone === 'run'
  return (
    <div className="relative min-h-screen">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-[-22vh] h-[70vh] w-[min(1400px,140vw)] -translate-x-1/2 rounded-full"
          style={{
            background: `radial-gradient(ellipse at 50% 40%, ${running ? 'rgba(167,139,250,0.22)' : 'var(--accent-glow)'}, transparent 62%)`,
            opacity: 0.55 * circadian(now),
            transition: 'opacity 60s ease, background 1.2s ease',
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-[40vh]" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.6), transparent)' }} />
      </div>

      <TopBar
        tab={tab}
        onTab={setTab}
        stats={stats}
        connected={connected}
        health={health}
        busy={running}
        restarting={restarting}
        onRestart={restart}
      />

      <main className="relative mx-auto flex max-w-[1240px] flex-col gap-5 px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
        {/* Enter-only on purpose: an exit-gated (mode="wait") switch can hang when
            the outgoing view holds shared-layout animations, leaving the old tab up. */}
        <motion.div
            key={tab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col gap-5"
          >
            {tab === 'lab' && (
              <>
                {loaded
                  ? <LoopHero slots={slots} headline={headline} today={today} away={away} now={now} onFocus={select} />
                  : <div className="glass h-[340px] animate-pulse" aria-label="Loading the lab" />}
                <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
                  <div className="min-w-0 lg:sticky lg:top-[84px]">
                    <Roster
                      slots={slots}
                      selectedId={selected?.id}
                      onSelect={select}
                      runsBySlot={runsBySlot}
                      preflightBySlot={preflightBySlot}
                      now={now}
                      onCreate={async (idea, title) => {
                        const slot = await actions.create(idea, title)
                        if (slot?.id) select(slot.id)
                      }}
                      loadError={loadError}
                    />
                  </div>
                  {selected ? (
                    <IncubatorDetail
                      key={selected.id}
                      slot={selected}
                      runs={runsBySlot[selected.id] || []}
                      preflight={preflightBySlot[selected.id]}
                      historyError={historyErrors[selected.id]}
                      now={now}
                      actions={actions}
                    />
                  ) : loaded && (
                    <div className="glass grid min-h-[320px] place-items-center p-10 text-center text-[15px] text-fg3">
                      Create your first incubator and it will appear here.
                    </div>
                  )}
                </div>
              </>
            )}
            {tab === 'system' && (
              <PulsePanel stats={stats} history={history} tempHistory={tempHistory} netRxHistory={netRxHistory} netTxHistory={netTxHistory} />
            )}
            {tab === 'services' && <ServicesView />}
          </motion.div>
      </main>
    </div>
  )
}
