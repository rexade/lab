import { motion } from 'framer-motion'
import { fmtClock } from '../lib/format.js'
import { slotHue, slotName, upcomingSchedule } from '../lib/incubator.js'

const WINDOW_MS = 6 * 3600 * 1000

function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function angleFor(at, now) {
  return -90 + ((at - now) / WINDOW_MS) * 360
}

// Six hours of the loop's future on one dial: every autopilot slot's upcoming
// launches, a sweeping orbit while an agent works, and a live countdown.
export function LoopDial({ slots = [], now = Date.now(), headline, size = 264 }) {
  const c = size / 2
  const R = size / 2 - 18
  const beatR = R - 17
  const innerR = R * 0.64
  const upcoming = upcomingSchedule(slots, now, WINDOW_MS)
  const running = headline?.tone === 'run'
  const names = Object.fromEntries(slots.map(slot => [slot.id, slotName(slot)]))

  let centerValue = '—'
  let centerLabel = 'autopilot off'
  let centerColor = 'var(--text-3)'
  if (running && headline.since) {
    centerValue = fmtClock((now - headline.since) / 1000)
    centerLabel = 'incubating'
    centerColor = 'var(--run)'
  } else if (headline?.until) {
    centerValue = fmtClock((headline.until - now) / 1000)
    centerLabel = 'until next run'
    centerColor = 'var(--accent)'
  }

  const ticks = []
  for (let i = 0; i < 72; i += 1) {
    const hour = i % 12 === 0
    const [x1, y1] = polar(c, c, R, -90 + i * 5)
    const [x2, y2] = polar(c, c, R - (hour ? 9 : 4), -90 + i * 5)
    ticks.push(
      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hour ? 'rgba(226,232,240,0.42)' : 'rgba(148,163,184,0.16)'} strokeWidth={hour ? 1.6 : 1} strokeLinecap="round" />,
    )
  }

  const hourLabels = [2, 4].map(hour => {
    const [x, y] = polar(c, c, R + 11, -90 + hour * 60)
    return <text key={hour} x={x} y={y} fill="rgba(100,116,139,0.8)" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle" dominantBaseline="middle">+{hour}h</text>
  })

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} data-loop-dial={running ? 'running' : headline?.until ? 'scheduled' : 'idle'}>
      <motion.div
        aria-hidden="true"
        className="absolute rounded-full"
        style={{
          inset: 18,
          background: `conic-gradient(from 0deg, transparent 0 86%, ${running ? 'rgba(167,139,250,0.34)' : 'var(--accent-glow)'} 99.4%, transparent 100%)`,
          maskImage: 'radial-gradient(circle, transparent 42%, black 43%)',
          WebkitMaskImage: 'radial-gradient(circle, transparent 42%, black 43%)',
          opacity: running ? 0.95 : 0.6,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: running ? 3.2 : 14, repeat: Infinity, ease: 'linear' }}
      />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="relative" role="img" aria-label={`${upcoming.length} launches scheduled in the next six hours`}>
        <defs>
          <radialGradient id="dial-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={running ? 'rgba(167,139,250,0.16)' : 'rgba(34,211,238,0.10)'} />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          <linearGradient id="orbit" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(167,139,250,0)" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <circle cx={c} cy={c} r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        {ticks}
        {hourLabels}
        <circle cx={c} cy={c} r={innerR} fill="url(#dial-core)" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        {running && (
          <motion.g
            animate={{ rotate: 360 }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'linear' }}
          >
            <circle
              cx={c}
              cy={c}
              r={innerR}
              fill="none"
              stroke="url(#orbit)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${innerR * 1.4} ${innerR * 8}`}
              style={{ filter: 'drop-shadow(0 0 6px rgba(167,139,250,0.8))' }}
            />
          </motion.g>
        )}
        {upcoming.map(item => {
          const [x, y] = polar(c, c, beatR, angleFor(item.at, now))
          const hue = slotHue(item.slotId)
          const fade = 1 - (item.at - now) / WINDOW_MS
          return (
            <g key={`${item.slotId}-${item.at}`} data-dial-beat={item.slotId}>
              <title>{`${names[item.slotId] || item.slotId} · ${new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</title>
              {item.first && <circle cx={x} cy={y} r={9} fill={hue} opacity={0.16} />}
              <circle cx={x} cy={y} r={item.first ? 4.6 : 2.6} fill={hue} opacity={item.first ? 1 : 0.35 + fade * 0.45} style={item.first ? { filter: `drop-shadow(0 0 5px ${hue})` } : undefined} />
            </g>
          )
        })}
        <path d={`M ${c - 5} 7 L ${c + 5} 7 L ${c} 14 Z`} fill="var(--accent)" style={{ filter: 'drop-shadow(0 0 4px var(--accent))' }} />
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="num font-mono font-medium leading-none tracking-[-0.04em]" style={{ color: centerColor, fontSize: size * 0.13, textShadow: `0 0 24px ${running ? 'rgba(167,139,250,0.45)' : 'var(--accent-glow)'}` }}>
            {centerValue}
          </div>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg4">{centerLabel}</div>
        </div>
      </div>
    </div>
  )
}
