import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

// ─── Network Pulse — bidirectional rx/tx sparkline ────────────────────────────

function fmtBytesPerSec(b) {
  if (b < 1024) return `${b} B/s`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 102400 ? 1 : 0)} KB/s`
  return `${(b / 1024 / 1024).toFixed(1)} MB/s`
}

function NetPulse({ rxHistory, txHistory, net, width }) {
  const height = 48
  const cy = height / 2
  const padding = 5

  const peak = useMemo(
    () => Math.max(1024, ...rxHistory, ...txHistory),
    [rxHistory, txHistory]
  )

  // Build Catmull-Rom path for one channel from a center baseline
  const buildChannel = useCallback((vals, direction) => {
    const n = vals.length
    if (n < 2) return { line: '', fill: '' }
    const xStep = width / (n - 1)
    const coords = vals.map((v, i) => {
      const offset = (v / peak) * (cy - padding)
      return [i * xStep, direction === 'up' ? cy - offset : cy + offset]
    })
    const pt = i => coords[Math.max(0, Math.min(n - 1, i))]
    let path = `M ${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`
    for (let i = 0; i < n - 1; i++) {
      const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2)
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6
      path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
    }
    const fill = `${path} L ${coords[n - 1][0].toFixed(1)} ${cy} L 0 ${cy} Z`
    return { line: path, fill }
  }, [width, peak, cy, padding])

  const rxPaths = useMemo(() => buildChannel(rxHistory, 'up'), [rxHistory, buildChannel])
  const txPaths = useMemo(() => buildChannel(txHistory, 'down'), [txHistory, buildChannel])

  const latestRx = rxHistory.at(-1) ?? 0
  const latestTx = txHistory.at(-1) ?? 0
  const dotRxY = cy - (latestRx / peak) * (cy - padding)
  const dotTxY = cy + (latestTx / peak) * (cy - padding)
  const dotX = width - 4

  return (
    <div>
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>
          net i/o
        </span>
        <span className="text-xs font-mono" style={{ color: 'rgba(34,211,238,0.8)' }}>
          ↓ {fmtBytesPerSec(latestRx)}
        </span>
        <span className="text-xs font-mono" style={{ color: 'rgba(167,139,250,0.8)' }}>
          ↑ {fmtBytesPerSec(latestTx)}
        </span>
        {net?.iface && (
          <span className="text-xs font-mono ml-auto" style={{ color: 'rgba(255,255,255,0.12)' }}>
            {net.iface}
          </span>
        )}
      </div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="rx-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="tx-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Center baseline */}
        <line x1={0} y1={cy} x2={width} y2={cy}
          stroke="rgba(255,255,255,0.06)" strokeDasharray="3 5" />

        {/* RX — cyan above center */}
        {rxPaths.fill && <path d={rxPaths.fill} fill="url(#rx-fill)" />}
        {rxPaths.line && (
          <path d={rxPaths.line} fill="none" stroke="#22d3ee" strokeWidth="1.5" style={{ opacity: 0.7 }} />
        )}
        {rxHistory.length > 1 && (
          <circle cx={dotX} cy={dotRxY} r="3" fill="#22d3ee"
            style={{ filter: 'drop-shadow(0 0 4px rgba(34,211,238,0.8))' }} />
        )}

        {/* TX — purple below center */}
        {txPaths.fill && <path d={txPaths.fill} fill="url(#tx-fill)" />}
        {txPaths.line && (
          <path d={txPaths.line} fill="none" stroke="#a78bfa" strokeWidth="1.5" style={{ opacity: 0.7 }} />
        )}
        {txHistory.length > 1 && (
          <circle cx={dotX} cy={dotTxY} r="3" fill="#a78bfa"
            style={{ filter: 'drop-shadow(0 0 4px rgba(167,139,250,0.8))' }} />
        )}
      </svg>
    </div>
  )
}

// ─── Day Ring — 24h hourly CPU heatmap clock ──────────────────────────────────

function cpuColor(cpu) {
  if (cpu === null) return 'rgba(255,255,255,0.07)'
  if (cpu > 75) return '#f87171'
  if (cpu > 50) return '#fb923c'
  if (cpu > 25) return '#22d3ee'
  return 'rgba(34,211,238,0.28)'
}

// Ghost tint per diary classState — third data dimension on the ring
function classStateColor(state) {
  if (!state) return null
  const s = state.toLowerCase()
  if (s.includes('inference')) return 'rgba(74,222,128,0.22)'
  if (s.includes('burst') || s.includes('net')) return 'rgba(34,211,238,0.20)'
  if (s.includes('entropy') || s.includes('event')) return 'rgba(139,92,246,0.26)'
  if (s.includes('idle') || s.includes('quiet')) return null
  return 'rgba(255,255,255,0.10)'
}

// Find entry closest in time to the midpoint of a given hour (today)
function findClosestEntry(entries, h) {
  if (!entries.length) return null
  const today = new Date()
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const midpoint = midnight + h * 3600000 + 1800000
  // Prefer entries from the past 24h; fall back to all
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const pool = entries.filter(e => e.ts > cutoff)
  const src = pool.length ? pool : entries
  return src.reduce((best, e) =>
    Math.abs(e.ts - midpoint) < Math.abs(best.ts - midpoint) ? e : best
  )
}

function DayRing({ entries, narrations = [], diaryEntries = [] }) {
  const size = 110
  const cx = size / 2, cy = size / 2
  const outerR = 42, innerR = 26
  const TWO_PI = Math.PI * 2
  const [hoveredHour, setHoveredHour] = useState(null)

  // Bucket into 24 hourly averages
  const hours = useMemo(() => {
    const buckets = Array(24).fill(null).map(() => [])
    for (const e of entries) {
      const h = new Date(e.ts).getHours()
      buckets[h].push(e.cpu)
    }
    return buckets.map(b => b.length ? b.reduce((s, v) => s + v, 0) / b.length : null)
  }, [entries])

  // Bucket diary classState by hour — last entry per hour wins
  const stateHours = useMemo(() => {
    const buckets = Array(24).fill(null)
    for (const e of diaryEntries) {
      if (!e.classState) continue
      const h = new Date(e.ts).getHours()
      buckets[h] = e.classState
    }
    return buckets
  }, [diaryEntries])

  // Hourly avg total network throughput (KB/s) — only entries that have rx/tx
  const netHours = useMemo(() => {
    const buckets = Array(24).fill(null).map(() => [])
    for (const e of entries) {
      if (e.rx !== undefined) {
        const h = new Date(e.ts).getHours()
        buckets[h].push((e.rx + e.tx) / 1024)
      }
    }
    return buckets.map(b => b.length ? b.reduce((s, v) => s + v, 0) / b.length : null)
  }, [entries])

  const nowH = new Date().getHours()
  const nowMin = new Date().getMinutes()
  const nowAngle = ((nowH * 60 + nowMin) / 1440) * TWO_PI - Math.PI / 2

  // Build arc paths (donut segments, 1h each, with small gap)
  const arcs = useMemo(() => hours.map((cpu, h) => {
    const gap = 0.04
    const sa = (h / 24) * TWO_PI - Math.PI / 2 + gap
    const ea = ((h + 1) / 24) * TWO_PI - Math.PI / 2 - gap
    const spanAngle = ea - sa
    const largeArc = spanAngle > Math.PI ? 1 : 0

    const x1o = cx + outerR * Math.cos(sa)
    const y1o = cy + outerR * Math.sin(sa)
    const x2o = cx + outerR * Math.cos(ea)
    const y2o = cy + outerR * Math.sin(ea)
    const x1i = cx + innerR * Math.cos(ea)
    const y1i = cy + innerR * Math.sin(ea)
    const x2i = cx + innerR * Math.cos(sa)
    const y2i = cy + innerR * Math.sin(sa)

    const d = [
      `M ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o.toFixed(2)} ${y2o.toFixed(2)}`,
      `L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i.toFixed(2)} ${y2i.toFixed(2)}`,
      'Z',
    ].join(' ')

    return { h, cpu, d, color: cpuColor(cpu) }
  }), [hours, cx, cy, outerR, innerR, TWO_PI])

  // "Now" marker — small bright line at current time position
  const nowX1 = cx + (innerR - 4) * Math.cos(nowAngle)
  const nowY1 = cy + (innerR - 4) * Math.sin(nowAngle)
  const nowX2 = cx + (outerR + 4) * Math.cos(nowAngle)
  const nowY2 = cy + (outerR + 4) * Math.sin(nowAngle)

  const totalReadings = entries.length

  // Hover info — resolved lazily when hour changes
  const hoverInfo = useMemo(() => {
    if (hoveredHour === null) return null
    return {
      h: hoveredHour,
      cpu: hours[hoveredHour],
      net: netHours[hoveredHour],
      narration: findClosestEntry(narrations, hoveredHour),
      diary: findClosestEntry(diaryEntries, hoveredHour),
    }
  }, [hoveredHour, hours, netHours, narrations, diaryEntries])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ flexShrink: 0, overflow: 'visible' }}
        onMouseLeave={() => setHoveredHour(null)}
      >
        {/* Background ring */}
        <circle cx={cx} cy={cy} r={(outerR + innerR) / 2} fill="none"
          stroke="rgba(255,255,255,0.04)" strokeWidth={outerR - innerR} />

        {/* Hourly segments */}
        {arcs.map(({ h, d, color }) => (
          <path key={h} d={d} fill={color}
            style={{ transition: 'fill 0.8s ease' }} />
        ))}

        {/* Ghost state layer — diary classState tints per hour (third data dimension) */}
        {arcs.map(({ h, d }) => {
          const tint = classStateColor(stateHours[h])
          if (!tint) return null
          return (
            <path key={`state-${h}`} d={d} fill={tint}
              style={{ pointerEvents: 'none', transition: 'fill 1.4s ease' }} />
          )
        })}

        {/* Hover highlight — brightens the active segment */}
        {hoveredHour !== null && (
          <path
            d={arcs[hoveredHour].d}
            fill="rgba(255,255,255,0.12)"
            style={{ pointerEvents: 'none', transition: 'opacity 0.1s' }}
          />
        )}

        {/* Transparent overlay paths — catch hover events per segment */}
        {arcs.map(({ h, d }) => (
          <path key={`ov-${h}`} d={d} fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseEnter={() => setHoveredHour(h)}
          />
        ))}

        {/* Now marker */}
        <line
          x1={nowX1.toFixed(2)} y1={nowY1.toFixed(2)}
          x2={nowX2.toFixed(2)} y2={nowY2.toFixed(2)}
          stroke="rgba(255,255,255,0.9)" strokeWidth="1.5"
          strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 0 3px rgba(255,255,255,0.6))', pointerEvents: 'none' }}
        />

        {/* Cardinal hour ticks + labels — 0h (midnight), 6h, 12h (noon), 18h */}
        {[
          { h: 0,  label: '0',  anchor: 'middle', baseline: 'auto'    },
          { h: 6,  label: '6',  anchor: 'start',  baseline: 'middle'  },
          { h: 12, label: '12', anchor: 'middle', baseline: 'hanging' },
          { h: 18, label: '18', anchor: 'end',    baseline: 'middle'  },
        ].map(({ h, label, anchor, baseline }) => {
          const a = (h / 24) * TWO_PI - Math.PI / 2
          const tx1 = cx + (innerR - 2) * Math.cos(a)
          const ty1 = cy + (innerR - 2) * Math.sin(a)
          const tx2 = cx + (outerR + 2) * Math.cos(a)
          const ty2 = cy + (outerR + 2) * Math.sin(a)
          const lx = cx + (outerR + 8) * Math.cos(a)
          const ly = cy + (outerR + 8) * Math.sin(a)
          return (
            <g key={h} style={{ pointerEvents: 'none' }}>
              <line
                x1={tx1.toFixed(2)} y1={ty1.toFixed(2)}
                x2={tx2.toFixed(2)} y2={ty2.toFixed(2)}
                stroke="rgba(255,255,255,0.18)" strokeWidth="1"
              />
              <text
                x={lx.toFixed(1)} y={ly.toFixed(1)}
                textAnchor={anchor} dominantBaseline={baseline}
                fontSize="6" fill="rgba(255,255,255,0.22)"
                fontFamily="monospace"
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* Current time in center — anchors the ring as a live clock */}
        <text
          x={cx} y={cy}
          textAnchor="middle" dominantBaseline="middle"
          fontSize="9" fill="rgba(255,255,255,0.28)"
          fontFamily="monospace" fontWeight="600"
          style={{ pointerEvents: 'none' }}
        >
          {`${String(nowH).padStart(2, '0')}:${String(nowMin).padStart(2, '0')}`}
        </text>
      </svg>

      {/* Right panel — legend at rest, hour context on hover */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        <AnimatePresence mode="wait">
          {hoverInfo ? (
            <motion.div
              key={`h${hoverInfo.h}`}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12 }}
              style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
            >
              {/* Hour + cpu */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{
                  fontSize: '0.64rem', fontFamily: 'monospace', fontWeight: 700,
                  color: hoverInfo.cpu !== null ? cpuColor(hoverInfo.cpu) : 'rgba(255,255,255,0.25)',
                  letterSpacing: '0.06em',
                }}>
                  {String(hoverInfo.h).padStart(2, '0')}:00
                </span>
                <span style={{
                  fontSize: '0.55rem', fontFamily: 'monospace',
                  color: hoverInfo.cpu !== null ? cpuColor(hoverInfo.cpu) : 'rgba(255,255,255,0.2)',
                  opacity: 0.75,
                }}>
                  {hoverInfo.cpu !== null ? `${Math.round(hoverInfo.cpu)}% cpu` : 'no data'}
                </span>
                {hoverInfo.net !== null && (
                  <span style={{
                    fontSize: '0.52rem', fontFamily: 'monospace',
                    color: 'rgba(34,211,238,0.45)',
                  }}>
                    {hoverInfo.net < 10 ? hoverInfo.net.toFixed(1) : Math.round(hoverInfo.net)} KB/s net
                  </span>
                )}
              </div>
              {/* Dual voice — narrator (amber) + machine diary (violet) */}
              {hoverInfo.narration && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <p style={{
                    margin: 0, fontStyle: 'italic',
                    fontSize: '0.68rem', lineHeight: 1.4,
                    color: 'rgba(251,191,36,0.62)',
                    letterSpacing: '0.005em',
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    "{hoverInfo.narration.text}"
                  </p>
                  <span style={{
                    fontSize: '0.5rem', fontFamily: 'monospace',
                    color: 'rgba(251,191,36,0.28)',
                    letterSpacing: '0.06em',
                  }}>
                    {new Date(hoverInfo.narration.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                  </span>
                </div>
              )}

              {/* Hairline between voices when both present */}
              {hoverInfo.narration && hoverInfo.diary && (
                <div style={{
                  height: 1,
                  background: 'rgba(255,255,255,0.05)',
                  margin: '1px 0',
                }} />
              )}

              {/* Machine diary voice — violet, slower, more interior */}
              {hoverInfo.diary && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <p style={{
                    margin: 0, fontStyle: 'italic',
                    fontSize: '0.68rem', lineHeight: 1.4,
                    color: 'rgba(139,92,246,0.65)',
                    letterSpacing: '0.005em',
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {hoverInfo.diary.text}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{
                      fontSize: '0.5rem', fontFamily: 'monospace',
                      color: 'rgba(139,92,246,0.3)',
                      letterSpacing: '0.06em',
                    }}>
                      {new Date(hoverInfo.diary.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                    {hoverInfo.diary.classState && (() => {
                      const s = hoverInfo.diary.classState.toLowerCase()
                      const c = s.includes('inference') ? '#4ade80'
                        : s.includes('burst') || s.includes('net') ? '#22d3ee'
                        : s.includes('entropy') || s.includes('event') ? '#a78bfa'
                        : 'rgba(255,255,255,0.35)'
                      return (
                        <span style={{
                          fontSize: '0.44rem', fontFamily: 'monospace', letterSpacing: '0.08em',
                          color: c, border: `1px solid ${c}`,
                          borderRadius: 2, padding: '0 3px', opacity: 0.75,
                          textTransform: 'lowercase',
                        }}>
                          {hoverInfo.diary.classState}
                        </span>
                      )
                    })()}
                  </div>
                </div>
              )}

              {/* Silence — no voice at all */}
              {!hoverInfo.narration && !hoverInfo.diary && (
                <span style={{
                  fontSize: '0.58rem', fontFamily: 'monospace',
                  color: 'rgba(255,255,255,0.14)',
                }}>no voice entry</span>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="legend"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <span style={{
                fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.13em',
                color: 'var(--muted)', fontFamily: 'monospace',
              }}>24h activity</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { label: 'idle', color: cpuColor(10) },
                  { label: 'med', color: cpuColor(35) },
                  { label: 'hi', color: cpuColor(60) },
                  { label: 'hot', color: cpuColor(80) },
                ].map(({ label, color }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.55rem', color: 'var(--muted)', fontFamily: 'monospace' }}>{label}</span>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.18)', fontFamily: 'monospace', marginTop: 2 }}>
                {totalReadings} readings · {totalReadings < 12 ? 'building…' : `${Math.round(totalReadings / 12)}h`}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function useDayHistory() {
  const [entries, setEntries] = useState([])
  useEffect(() => {
    const load = () => fetch('/api/history/day').then(r => r.json()).then(d => {
      if (d.ok && Array.isArray(d.entries)) setEntries(d.entries)
    }).catch(() => {})
    load()
    const id = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])
  return entries
}

function useNarrations() {
  const [entries, setEntries] = useState([])
  useEffect(() => {
    fetch('/api/narrations').then(r => r.json()).then(d => {
      if (d.ok && Array.isArray(d.entries)) setEntries(d.entries)
    }).catch(() => {})
  }, [])
  return entries
}

function useDiaryEntries() {
  const [entries, setEntries] = useState([])
  useEffect(() => {
    const load = () =>
      fetch('/api/ghost/diary').then(r => r.json()).then(d => {
        if (d.ok && Array.isArray(d.entries)) setEntries(d.entries)
      }).catch(() => {})
    load()
    // Re-check every 10 minutes — diary generates hourly
    const id = setInterval(load, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [])
  return entries
}

// Build a smooth SVG path through points using Catmull-Rom splines (C2 continuity)
// Converts to cubic bezier: B1 = P1 + (P2-P0)/6, B2 = P2 - (P3-P1)/6
function buildPath(points, width, height, padding = 0.1) {
  if (points.length < 2) return { line: '', fill: '' }
  const n = points.length
  const xStep = width / (n - 1)
  const yPad = height * padding
  const yRange = height - yPad * 2

  const coords = points.map((v, i) => [
    i * xStep,
    yPad + yRange - (v / 100) * yRange,
  ])

  // Clamp-to-boundary Catmull-Rom: endpoints use nearest interior tangent
  const pt = i => coords[Math.max(0, Math.min(n - 1, i))]

  let path = `M ${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2)
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }

  const fill = path + ` L ${coords[n - 1][0].toFixed(1)} ${height} L 0 ${height} Z`
  return { line: path, fill }
}

function WaveformCanvas({ history, width, height }) {
  const paths = useMemo(() => buildPath(history, width, height), [history, width, height])

  const latest = history[history.length - 1] ?? 0
  const dotX = width - 5
  const yPad = height * 0.1
  const yRange = height * 0.8
  const dotY = yPad + yRange - (latest / 100) * yRange

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="pulse-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.25 }} />
          <stop offset="60%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.04 }} />
          <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
        </linearGradient>
        <filter id="pulse-glow" x="-5%" y="-50%" width="110%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {[25, 50, 75].map(pct => {
        const y = height * 0.1 + (height * 0.8) * (1 - pct / 100)
        return (
          <line key={pct} x1={0} y1={y} x2={width} y2={y}
            stroke="rgba(255,255,255,0.04)" strokeDasharray="4 6" />
        )
      })}

      {paths.fill && <path d={paths.fill} fill="url(#pulse-fill)" />}
      {paths.line && (
        <path d={paths.line} fill="none" stroke="var(--accent)" strokeWidth="2"
          filter="url(#pulse-glow)"
          style={{ transition: 'stroke 0.6s ease' }}
        />
      )}

      {history.length > 1 && (
        <>
          <circle cx={dotX} cy={dotY} r="5" fill="var(--accent)"
            style={{ filter: 'drop-shadow(0 0 6px var(--accent-glow))' }} />
          <circle cx={dotX} cy={dotY} r="10" fill="var(--accent)" fillOpacity="0.15" />
        </>
      )}
    </svg>
  )
}

// Temperature sparkline — normalized to Pi operating range
const MIN_TEMP = 30
const MAX_TEMP = 85

function TempSparkline({ history, width, height }) {
  const normalized = useMemo(
    () => history.map(t =>
      Math.max(0, Math.min(100, Math.round(((t - MIN_TEMP) / (MAX_TEMP - MIN_TEMP)) * 100)))
    ),
    [history]
  )
  const paths = useMemo(() => buildPath(normalized, width, height, 0.08), [normalized, width, height])
  const latest = history.at(-1) ?? MIN_TEMP
  const color = latest > 75 ? '#f87171' : latest > 60 ? '#fb923c' : '#fbbf24'

  const dotNorm = normalized.at(-1) ?? 0
  const yPad = height * 0.08
  const yRange = height * 0.84
  const dotX = width - 4
  const dotY = yPad + yRange - (dotNorm / 100) * yRange

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="temp-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {paths.fill && <path d={paths.fill} fill="url(#temp-fill)" />}
      {paths.line && (
        <path d={paths.line} fill="none" stroke={color} strokeWidth="1.5" style={{ opacity: 0.65 }} />
      )}
      {history.length > 1 && (
        <circle cx={dotX} cy={dotY} r="3" fill={color}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      )}
    </svg>
  )
}

function LoadBar({ label, value, max = 100, color = 'var(--accent)' }) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-xs uppercase tracking-wider font-medium" style={{ color: 'var(--muted)' }}>{label}</span>
        <span className="text-xs font-mono" style={{ color }}>{pct}%</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}40` }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        />
      </div>
    </div>
  )
}

export function PulsePanel({ stats, history, tempHistory = [], netRxHistory = [], netTxHistory = [] }) {
  const containerRef = useRef(null)
  const [svgWidth, setSvgWidth] = useState(700)
  const dayHistory = useDayHistory()
  const narrations = useNarrations()
  const diaryEntries = useDiaryEntries()

  const latest = history[history.length - 1] ?? stats?.cpu ?? 0
  const svgHeight = 140
  const tempHeight = 40
  const memPct = stats?.memory?.percent ?? 0
  const load1 = stats?.loadAvg?.[0] ?? 0
  const latestTemp = tempHistory.at(-1)
  const hasTempData = tempHistory.length > 1

  // Wire ResizeObserver to the inner container div (no padding, clean measurement)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width)
        if (w > 0) setSvgWidth(w)
      }
    })
    ro.observe(el)
    const initialW = Math.floor(el.getBoundingClientRect().width)
    if (initialW > 0) setSvgWidth(initialW)
    return () => ro.disconnect()
  }, [])

  const tempColor = latestTemp > 75 ? '#f87171' : latestTemp > 60 ? '#fb923c' : '#fbbf24'

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1, ease: [0.4, 0, 0.2, 1] }}
      className="panel border-accent-glow overflow-hidden"
      style={{ padding: 0 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <motion.div
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--accent)', boxShadow: '0 0 6px var(--accent-glow)' }}
            />
            <span className="text-xs uppercase tracking-widest font-medium" style={{ color: 'var(--muted)' }}>
              system pulse
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <AnimatePresence mode="wait">
              <motion.span
                key={Math.round(latest / 5)}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="text-6xl font-bold mono glow-text"
                style={{ color: 'var(--accent)', letterSpacing: '-2px', lineHeight: 1 }}
              >
                {Math.round(latest)}
              </motion.span>
            </AnimatePresence>
            <div>
              <div className="text-xl font-semibold" style={{ color: 'rgba(255,255,255,0.4)' }}>%</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>cpu usage</div>
            </div>
          </div>
        </div>

        {/* Mini stats */}
        <div className="hidden md:flex flex-col gap-3 items-end" style={{ minWidth: 160 }}>
          <LoadBar label="CPU" value={latest} color="var(--accent)" />
          <LoadBar
            label="Memory"
            value={memPct}
            color={memPct > 80 ? '#fb923c' : 'var(--accent)'}
          />
          <LoadBar
            label="Load"
            value={load1}
            max={4}
            color={load1 > 2.5 ? '#f87171' : 'rgba(255,255,255,0.5)'}
          />
        </div>
      </div>

      {/* CPU Waveform — responsive via ResizeObserver */}
      <div className="w-full px-2">
        <div ref={containerRef} style={{ height: svgHeight }}>
          <WaveformCanvas
            history={history.length > 0 ? history : Array(20).fill(12)}
            width={svgWidth}
            height={svgHeight}
          />
        </div>
      </div>

      {/* Temperature sparkline */}
      {hasTempData && (
        <div className="px-4 pt-3 pb-1">
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)', letterSpacing: '0.12em' }}>
              temp
            </span>
            <span className="text-xs font-mono font-medium" style={{ color: tempColor }}>
              {latestTemp?.toFixed(1)}°C
            </span>
          </div>
          <TempSparkline
            history={tempHistory}
            width={Math.max(10, svgWidth - 16)}
            height={tempHeight}
          />
        </div>
      )}

      {/* Network Pulse — bidirectional rx/tx sparkline */}
      {netRxHistory.length > 1 && (
        <div className="px-4 pt-3 pb-1">
          <NetPulse
            rxHistory={netRxHistory}
            txHistory={netTxHistory}
            net={stats?.net}
            width={Math.max(10, svgWidth - 16)}
          />
        </div>
      )}

      {/* Day Ring — 24h activity clock */}
      {dayHistory.length > 0 && (
        <div className="px-4 pt-3 pb-2">
          <DayRing entries={dayHistory} narrations={narrations} diaryEntries={diaryEntries} />
        </div>
      )}

      {/* Bottom bar — load avg */}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-3 mt-3 border-t"
        style={{ borderColor: 'var(--border)', background: 'rgba(0,0,0,0.2)' }}
      >
        <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--muted)' }}>load avg</span>
        {(stats?.loadAvg ?? [0, 0, 0]).map((v, i) => (
          <div key={i} className="flex items-baseline gap-1">
            <span className="mono font-medium text-sm text-white">{v.toFixed(2)}</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{['1m', '5m', '15m'][i]}</span>
          </div>
        ))}
        {stats?.memory && (
          <div className="ml-auto flex items-baseline gap-1">
            <span className="mono text-sm font-medium text-white">{stats.memory.usedMB}</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>/ {stats.memory.totalMB} MB</span>
          </div>
        )}
      </div>
    </motion.div>
  )
}
