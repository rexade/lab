import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { fmtClock } from '../lib/format.js'
import { outcomeStrip, slotHue, slotName, slotState } from '../lib/incubator.js'
import { Button, Eyebrow, Glyph, OutcomeStrip, toneColor } from './ui.jsx'

function NewIncubator({ onCreate, onClose }) {
  const [idea, setIdea] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const ready = idea.trim().length >= 8 && !busy

  const submit = async event => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(idea.trim(), title.trim())
      setIdea('')
      setTitle('')
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.form
      onSubmit={submit}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <div className="grid gap-3 border-b border-white/[0.06] px-5 pb-5 pt-1">
        <textarea
          className="field min-h-[96px] resize-y"
          value={idea}
          onChange={event => { setIdea(event.target.value); setError(null) }}
          placeholder="Describe what the lab should build — the agent takes it from here."
          aria-label="Incubator idea"
        />
        <input
          className="field"
          value={title}
          maxLength={48}
          onChange={event => { setTitle(event.target.value); setError(null) }}
          placeholder="Short name (optional)"
          aria-label="Incubator name"
        />
        {error && <div className="text-[13px] text-fail">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" type="submit" disabled={!ready}>{busy ? 'Creating…' : 'Create incubator'}</Button>
        </div>
      </div>
    </motion.form>
  )
}

function RosterRow({ slot, selected, state, runs, now, onSelect }) {
  const hue = slotHue(slot.id)
  const name = slotName(slot)
  const running = state.kind === 'running'
  const label = running ? `Incubating · ${fmtClock((now - state.startedAt) / 1000)}` : state.label
  return (
    <button
      type="button"
      onClick={() => onSelect(slot.id)}
      aria-pressed={selected}
      data-incubator-row={slot.id}
      data-incubator-state={state.kind}
      className="focus-ring relative flex w-full items-center gap-4 rounded-[16px] px-3 py-3 text-left transition-colors hover:bg-white/[0.025]"
    >
      {selected && (
        <motion.span
          layoutId="roster-selection"
          className="absolute inset-0 rounded-[16px] border border-white/[0.09] bg-white/[0.055]"
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
        >
          <span className="absolute left-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-full" style={{ background: hue, boxShadow: `0 0 12px ${hue}` }} />
        </motion.span>
      )}
      <span className="relative">
        <Glyph letter={name.slice(0, 1).toUpperCase()} hue={hue} running={running} tone={state.tone === 'fail' ? 'fail' : null} rating={slot.lastQualityRating} />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{name}</span>
        <span className="mt-0.5 block truncate text-[13px]" style={{ color: toneColor(state.tone === 'idle' ? 'idle' : state.tone) }}>
          <span className="num">{label}</span>
          {state.kind !== 'running' && state.detail && <span className="text-fg4"> · {state.detail}</span>}
        </span>
      </span>
      <span className="relative hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
        <OutcomeStrip outcomes={outcomeStrip(runs, 10)} />
        <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${slot.enabled ? 'text-ok' : 'text-fg4'}`}>{slot.enabled ? 'auto' : 'manual'}</span>
      </span>
    </button>
  )
}

export function Roster({ slots, selectedId, onSelect, runsBySlot, preflightBySlot, now, onCreate, loadError }) {
  const [adding, setAdding] = useState(false)
  return (
    <section className="glass flex flex-col overflow-hidden" aria-label="Incubators">
      <div className="flex items-center justify-between px-5 pb-3 pt-5">
        <div className="flex items-baseline gap-2">
          <Eyebrow>Incubators</Eyebrow>
          <span className="num text-[12px] text-fg4">{slots.length}</span>
        </div>
        <Button size="sm" variant={adding ? 'quiet' : 'ghost'} onClick={() => setAdding(open => !open)} aria-expanded={adding}>
          {adding ? 'Close' : '+ New'}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {adding && <NewIncubator onCreate={onCreate} onClose={() => setAdding(false)} />}
      </AnimatePresence>
      {loadError && (
        <div className="mx-5 mb-3 rounded-[12px] border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.06)] px-3 py-2 text-[13px] text-fail" role="alert">
          Incubators unavailable: {loadError}
        </div>
      )}
      <div className="flex flex-col gap-1 px-2 pb-3">
        {slots.map(slot => (
          <RosterRow
            key={slot.id}
            slot={slot}
            selected={slot.id === selectedId}
            state={slotState(slot, { preflight: preflightBySlot[slot.id], now })}
            runs={runsBySlot[slot.id] || []}
            now={now}
            onSelect={onSelect}
          />
        ))}
        {!slots.length && !loadError && (
          <div className="px-4 py-8 text-center text-[14px] text-fg3">
            No incubators yet. <button type="button" className="text-accent underline-offset-4 hover:underline" onClick={() => setAdding(true)}>Start one from an idea.</button>
          </div>
        )}
      </div>
    </section>
  )
}
