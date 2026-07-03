import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'

function useClock() {
  const fmt = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const [time, setTime] = useState(fmt)
  useEffect(() => {
    const id = setInterval(() => setTime(fmt()), 60_000)
    return () => clearInterval(id)
  }, [])
  return time
}

export function NavShell({ hostname, connected, uptime, runCount, activeTab, onTabChange }) {
  const clock = useClock()
  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      className="flex items-center px-6 py-4 border-b"
      style={{ borderColor: 'var(--border)' }}
    >
      {/* Logo — flex-1 pushes tabs to center */}
      <div className="flex items-center gap-3 flex-1">
        <div className="relative w-8 h-8 flex items-center justify-center">
          <motion.div
            animate={{ scale: [1, 1.15, 1] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-0 rounded-full"
            style={{ background: 'var(--accent-dim)', boxShadow: '0 0 12px var(--accent-glow)' }}
          />
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <div>
          <span className="text-white font-semibold tracking-tight text-base leading-none">Pi Pulse</span>
          <span className="block text-xs mt-0.5 font-mono" style={{ color: 'var(--muted)' }}>
            home console
          </span>
        </div>
      </div>

      {/* Tabs — sits in the center between two flex-1 sections */}
      <div
        className="flex items-center rounded-lg p-1"
        style={{ background: 'rgba(255,255,255,0.04)', gap: 2 }}
      >
        {['pulse', 'lab'].map(tab => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className="font-mono rounded"
            style={{
              fontSize: '0.72rem',
              padding: '4px 14px',
              background: activeTab === tab ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: activeTab === tab ? 'var(--accent)' : 'var(--muted)',
              border: 'none',
              cursor: 'pointer',
              letterSpacing: '0.06em',
              transition: 'color 0.2s, background 0.2s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Right — flex-1 justify-end: search + host + status */}
      <div className="flex items-center gap-4 flex-1 justify-end">

        {/* Search — DuckDuckGo, hidden on small screens */}
        <form
          action="https://duckduckgo.com/"
          method="get"
          target="_blank"
          className="hidden md:flex items-center"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <input
            name="q"
            placeholder="search…"
            autoComplete="off"
            className="bg-transparent font-mono outline-none text-white w-28"
            style={{
              fontSize: '0.72rem',
              padding: '5px 10px',
              caretColor: 'var(--accent)',
            }}
          />
          <button
            type="submit"
            style={{
              background: 'transparent',
              border: 'none',
              padding: '5px 9px',
              color: 'var(--muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        </form>

        <div className="hidden sm:flex items-center gap-2">
          <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>host</span>
          <span className="text-xs font-mono font-medium text-white">{hostname || '—'}</span>
        </div>

        {uptime && (
          <>
            <div className="hidden md:block w-px h-4" style={{ background: 'var(--border)' }} />
            <div className="hidden md:flex items-center gap-2">
              <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>up</span>
              <span className="text-xs font-mono font-medium text-white">{uptime}</span>
            </div>
          </>
        )}

        <div className="w-px h-4" style={{ background: 'var(--border)' }} />

        <div className="flex items-center gap-2">
          <motion.div
            animate={connected ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
            transition={{ duration: 1.8, repeat: Infinity }}
            className="w-2 h-2 rounded-full"
            style={{ background: connected ? 'var(--accent)' : '#f87171' }}
          />
          <span className="text-xs" style={{ color: connected ? 'var(--accent)' : '#f87171' }}>
            {connected ? 'live' : 'demo'}
          </span>
        </div>

        {runCount != null && (
          <>
            <div className="w-px h-4" style={{ background: 'var(--border)' }} />
            <span
              className="text-xs font-mono hidden sm:inline"
              style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}
            >
              RUN {runCount}
            </span>
          </>
        )}

        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <span
          className="text-xs font-mono hidden sm:inline"
          style={{ color: 'var(--muted)', letterSpacing: '0.04em' }}
        >
          {clock}
        </span>
      </div>
    </motion.header>
  )
}
