import { AnimatePresence, motion } from 'framer-motion'
import { clip } from '../lib/format.js'
import { OUTCOME } from '../lib/incubator.js'
import { LoopDial } from './LoopDial.jsx'
import { Chip, Dot, Eyebrow, toneColor } from './ui.jsx'

const TONE_EYEBROW = {
  run: 'Agent at work',
  ok: 'Running feral',
  warn: 'Running · something needs setup',
  idle: 'Resting',
}

// What the lab did since you last looked, newest first.
function AwayDigest({ away, onFocus }) {
  if (!away?.total && !away?.finished?.length) return null
  const parts = [
    `${away.total} session${away.total === 1 ? '' : 's'}`,
    away.kept ? `${away.kept} kept` : null,
    away.reverted ? `${away.reverted} reverted by the lab` : null,
    away.failed ? `${away.failed} failed and retrying` : null,
  ].filter(Boolean)
  return (
    <div className="mt-7 rounded-[18px] border border-white/[0.07] bg-black/25 p-4 sm:p-5" data-away-digest={away.total}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>While you were away</Eyebrow>
        <span className="text-[13px] text-fg3">{parts.join(' · ')}</span>
      </div>
      {away.finished.length > 0 && (
        <p className="mt-3 text-[14px] text-ok" data-away-finished={away.finished.length}>
          Finished: {away.finished.join(', ')} — {away.finished.length === 1 ? 'it meets its brief' : 'they meet their briefs'} and {away.finished.length === 1 ? 'rests' : 'rest'}.
        </p>
      )}
      <ul className="mt-3 grid gap-1.5">
        {away.items.slice(0, 5).map(item => {
          const meta = OUTCOME[item.outcome] || { label: item.type, tone: 'idle' }
          return (
            <li key={`${item.slotId}-${item.num}`}>
              <button
                type="button"
                onClick={() => onFocus?.(item.slotId)}
                className="focus-ring group flex w-full items-baseline gap-3 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                <Chip tone={meta.tone} className="shrink-0">{meta.label}</Chip>
                <span className="min-w-0 flex-1 truncate text-[14px] text-fg2">
                  <span className="font-medium text-fg">{item.name}</span>
                  <span className="text-fg4"> · #{item.num} </span>
                  {clip(item.text, 120)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Stat({ label, value, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`focus-ring min-w-[88px] rounded-[14px] text-left ${onClick ? 'cursor-pointer transition-colors hover:bg-white/[0.04]' : ''} -m-2 p-2`}
    >
      <div className="num text-[28px] font-semibold leading-none tracking-[-0.03em]" style={{ color: tone ? toneColor(tone) : 'var(--text)' }}>{value}</div>
      <div className="mt-2 text-[12px] font-medium text-fg4">{label}</div>
    </Tag>
  )
}

export function LoopHero({ slots, headline, today, away, now, onFocus }) {
  const attention = headline.attention || []
  return (
    <section className="glass overflow-hidden p-6 sm:p-8" aria-label="Autonomous lab status">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-32 h-[420px] w-[520px] rounded-full opacity-60 blur-3xl"
        style={{ background: `radial-gradient(circle, ${headline.tone === 'run' ? 'rgba(167,139,250,0.20)' : 'var(--accent-glow)'}, transparent 65%)` }}
      />
      <div className="relative flex flex-col-reverse items-center gap-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <Dot tone={headline.tone === 'idle' ? 'idle' : headline.tone} pulse={headline.tone === 'run' || headline.tone === 'ok'} />
            <Eyebrow style={{ color: toneColor(headline.tone) }}>{TONE_EYEBROW[headline.tone] || 'Autonomous lab'}</Eyebrow>
          </div>
          <AnimatePresence mode="wait">
            <motion.h1
              key={headline.title}
              initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(6px)' }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className="mt-4 text-balance text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-[46px]"
              data-loop-headline={headline.tone}
            >
              {headline.title}
            </motion.h1>
          </AnimatePresence>
          <p className="mt-3 max-w-[560px] text-[15px] leading-relaxed text-fg3">{headline.subtitle}</p>

          <div className="mt-8 flex flex-wrap gap-x-10 gap-y-5">
            <Stat label="on autopilot" value={`${headline.autopilot}/${slots.length}`} tone={headline.autopilot ? 'ok' : null} />
            <Stat label="sessions today" value={today.total} />
            <Stat label="kept today" value={today.kept ?? 0} tone={today.kept ? 'ok' : null} />
            {attention.length > 0
              ? <Stat label="need setup" value={attention.length} tone="warn" onClick={() => onFocus?.(attention[0].id)} />
              : <Stat label="done & resting" value={headline.resting ?? 0} tone={headline.resting ? 'ok' : null} />}
          </div>

          {attention.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2" data-attention-list="true">
              {attention.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onFocus?.(item.id)}
                  className="focus-ring group inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-[13px] transition-colors"
                  style={{ borderColor: `color-mix(in srgb, ${toneColor(item.state.tone)} 30%, transparent)`, background: `color-mix(in srgb, ${toneColor(item.state.tone)} 7%, transparent)` }}
                >
                  <Dot tone={item.state.tone} size={6} />
                  <span className="font-medium text-fg">{item.name}</span>
                  <span className="truncate text-fg3">{item.state.label}</span>
                </button>
              ))}
            </div>
          )}
          <AwayDigest away={away} onFocus={onFocus} />
        </div>
        <LoopDial slots={slots} now={now} headline={headline} />
      </div>
    </section>
  )
}
