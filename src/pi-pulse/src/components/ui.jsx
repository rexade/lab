import { motion } from 'framer-motion'

export const TONE_COLOR = {
  run: 'var(--run)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  fail: 'var(--fail)',
  idle: 'var(--text-4)',
  accent: 'var(--accent)',
  neutral: 'rgba(148,163,184,0.5)',
}

export function toneColor(tone) {
  return TONE_COLOR[tone] || TONE_COLOR.idle
}

export function Eyebrow({ children, className = '', ...props }) {
  return <div className={`eyebrow ${className}`} {...props}>{children}</div>
}

export function Dot({ tone = 'idle', pulse = false, size = 8 }) {
  const color = toneColor(tone)
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {pulse && (
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ background: color }}
          animate={{ scale: [1, 2.4], opacity: [0.55, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <span className="relative rounded-full" style={{ width: size, height: size, background: color, boxShadow: `0 0 10px ${color}` }} />
    </span>
  )
}

const BUTTON_VARIANTS = {
  primary: 'text-[#041016] font-semibold bg-[var(--accent)] hover:brightness-110 shadow-[0_8px_30px_-8px_var(--accent-glow)]',
  run: 'text-white font-semibold bg-[var(--run)] hover:brightness-110 shadow-[0_8px_30px_-8px_rgba(167,139,250,0.55)]',
  danger: 'text-[var(--fail)] bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.28)] hover:bg-[rgba(248,113,113,0.14)]',
  ghost: 'text-fg2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:text-fg',
  quiet: 'text-fg3 hover:text-fg hover:bg-white/[0.05]',
}

export function Button({ variant = 'ghost', size = 'md', className = '', children, ...props }) {
  const sizing = size === 'sm' ? 'h-8 px-3 text-[13px] rounded-[10px]' : size === 'lg' ? 'h-12 px-6 text-[15px] rounded-[14px]' : 'h-10 px-4 text-[14px] rounded-[12px]'
  return (
    <button
      type="button"
      className={`focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, disabled = false, label, tone = 'ok' }) {
  const color = toneColor(tone)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className="focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-300 disabled:opacity-40"
      style={{
        background: checked ? `color-mix(in srgb, ${color} 22%, transparent)` : 'rgba(255,255,255,0.05)',
        borderColor: checked ? `color-mix(in srgb, ${color} 55%, transparent)` : 'var(--line)',
      }}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 600, damping: 34 }}
        className="absolute h-5 w-5 rounded-full"
        style={{
          left: checked ? 24 : 3,
          background: checked ? color : 'rgba(148,163,184,0.7)',
          boxShadow: checked ? `0 0 14px ${color}` : 'none',
        }}
      />
    </button>
  )
}

export function Segmented({ options, value, onChange, disabled = false, layoutId, size = 'md', ariaLabel }) {
  const height = size === 'sm' ? 'h-8 text-[12px]' : 'h-9 text-[13px]'
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex items-center gap-1 rounded-[12px] border border-white/[0.07] bg-black/30 p-1 ${disabled ? 'opacity-50' : ''}`}>
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => !active && onChange?.(option.value)}
            className={`focus-ring relative ${height} rounded-[9px] px-3 font-medium transition-colors duration-200 ${active ? 'text-fg' : 'text-fg3 hover:text-fg2'} disabled:cursor-not-allowed`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-[9px] border border-white/[0.1] bg-white/[0.09]"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function Chip({ tone = 'idle', children, className = '', ...props }) {
  const color = toneColor(tone)
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[12px] font-medium ${className}`}
      style={{ color, borderColor: `color-mix(in srgb, ${color} 32%, transparent)`, background: `color-mix(in srgb, ${color} 9%, transparent)` }}
      {...props}
    >
      {children}
    </span>
  )
}

export function Glyph({ letter, hue, size = 44, running = false, tone = null, rating = null }) {
  const ring = tone === 'fail' ? 'var(--fail)' : running ? 'var(--run)' : hue
  const stroke = 2.5
  const r = size / 2 - stroke
  const circumference = 2 * Math.PI * r
  const fill = rating == null ? 0.18 : Math.max(0.06, Math.min(1, rating / 5))
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {running && (
        <motion.span
          className="absolute inset-[-3px] rounded-full"
          style={{ background: 'conic-gradient(from 0deg, transparent 0 55%, var(--run) 100%)', filter: 'blur(1px)' }}
          animate={{ rotate: 360 }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
        />
      )}
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="#080b10" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ring}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fill} ${circumference}`}
          style={{ filter: `drop-shadow(0 0 4px ${ring})`, transition: 'stroke-dasharray 0.8s ease' }}
        />
      </svg>
      <span className="relative font-semibold" style={{ color: ring, fontSize: size * 0.36 }}>{letter}</span>
    </span>
  )
}

export function OutcomeStrip({ outcomes = [], height = 16 }) {
  if (!outcomes.length) return <span className="text-[12px] text-fg4">no runs</span>
  return (
    <span className="inline-flex items-end gap-[3px]" aria-label={`last ${outcomes.length} runs`}>
      {outcomes.map((outcome, index) => (
        <span
          key={`${outcome.num}-${index}`}
          title={`#${outcome.num} ${outcome.type}`}
          className="w-[4px] rounded-full"
          style={{
            height: outcome.tone === 'fail' ? height : outcome.tone === 'ok' ? height * 0.8 : height * 0.55,
            background: toneColor(outcome.tone === 'neutral' ? 'neutral' : outcome.tone),
            opacity: 0.45 + (index + 1) / outcomes.length * 0.55,
          }}
        />
      ))}
    </span>
  )
}
