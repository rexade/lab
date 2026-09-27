import { motion } from 'framer-motion'
import { useNow } from '../hooks/useNow.js'
import { Button, Dot, Segmented } from './ui.jsx'

const TABS = [
  { value: 'lab', label: 'Lab' },
  { value: 'system', label: 'System' },
  { value: 'services', label: 'Services' },
]

function PulseMark({ busy }) {
  return (
    <span className="relative grid h-9 w-9 place-items-center">
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: 'radial-gradient(circle, var(--accent-glow), transparent 70%)' }}
        animate={{ scale: busy ? [1, 1.35, 1] : [1, 1.15, 1], opacity: [0.9, 0.5, 0.9] }}
        transition={{ duration: busy ? 1.2 : 2.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="relative" aria-hidden="true">
        <polyline points="2 12.5 7 12.5 9.5 5 14 19 16.5 11 22 11" />
      </svg>
    </span>
  )
}

function Vital({ label, value, warn }) {
  return (
    <span className="hidden items-baseline gap-1.5 md:inline-flex">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg4">{label}</span>
      <span className={`num font-mono text-[13px] ${warn ? 'text-warn' : 'text-fg2'}`}>{value}</span>
    </span>
  )
}

function ServicePill({ connected, stale, busy, restarting, onRestart }) {
  if (stale) {
    // Restarting kills a running session, so the update waits for it.
    return (
      <Button size="sm" variant="ghost" onClick={onRestart} disabled={restarting || busy} title={busy ? 'New Pi Pulse code is waiting for the running session to finish' : 'New Pi Pulse code is on disk but not loaded'} data-service-state="stale">
        <Dot tone="warn" pulse={!restarting && !busy} size={7} />
        {restarting ? 'Restarting…' : busy ? 'Update after run' : 'Restart to update'}
      </Button>
    )
  }
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-white/[0.07] bg-black/30 px-3 text-[12px] font-medium text-fg2" data-service-state={connected ? 'live' : 'offline'}>
      <Dot tone={connected ? 'ok' : 'fail'} pulse={connected} size={7} />
      {connected ? 'Live' : 'Reconnecting'}
    </span>
  )
}

export function TopBar({ tab, onTab, stats, connected, health, busy, restarting, onRestart }) {
  const now = useNow(30000)
  const cpu = stats?.cpu
  const temp = stats?.temperature
  const clock = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[rgba(4,6,10,0.72)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <PulseMark busy={busy} />
          <div className="min-w-0 leading-tight">
            <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg">Pi Pulse</div>
            <div className="truncate text-[12px] text-fg4">{stats?.hostname || 'pi'} · up {stats?.uptimeFormatted || '—'}</div>
          </div>
        </div>
        <nav aria-label="Views" className="order-3 w-full sm:order-none sm:w-auto">
          <Segmented options={TABS} value={tab} onChange={onTab} layoutId="topbar-tab" ariaLabel="View" />
        </nav>
        <div className="flex flex-1 items-center justify-end gap-4">
          <Vital label="cpu" value={cpu == null ? '—' : `${cpu}%`} warn={cpu > 80} />
          <Vital label="temp" value={temp == null ? '—' : `${temp.toFixed(0)}°`} warn={temp > 70} />
          <span className="num hidden font-mono text-[13px] text-fg3 lg:inline">{clock}</span>
          <ServicePill connected={connected} stale={!!health?.source?.changedSinceStart} busy={busy} restarting={restarting} onRestart={onRestart} />
        </div>
      </div>
    </header>
  )
}
