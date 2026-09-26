import { AnimatePresence, motion } from 'framer-motion'
import { LoopDial } from './LoopDial.jsx'
import { Dot, Eyebrow, toneColor } from './ui.jsx'

const TONE_EYEBROW = {
  run: 'Agent at work',
  ok: 'Running feral',
  warn: 'Running · needs you',
  idle: 'Resting',
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

export function LoopHero({ slots, headline, today, now, onFocus }) {
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
            <Stat label="runs today" value={today.total} />
            <Stat label="failed today" value={today.failed} tone={today.failed ? 'fail' : null} />
            <Stat label="need you" value={attention.length} tone={attention.length ? 'warn' : null} onClick={attention.length ? () => onFocus?.(attention[0].id) : undefined} />
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
        </div>
        <LoopDial slots={slots} now={now} headline={headline} />
      </div>
    </section>
  )
}
