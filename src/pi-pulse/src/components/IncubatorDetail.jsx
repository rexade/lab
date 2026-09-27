import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { clip, fmtClock, fmtDuration, fmtInterval, fmtRelativeDay, shortPath, timeValue } from '../lib/format.js'
import { OUTCOME, preflightProblems, reviewState, runnerLabel, slotHue, slotName, slotState, STAGE_STEPS, stageOf, upcomingRun } from '../lib/incubator.js'
import { failureHeadline, nextMoveFromRuns, RUN_TYPE_COLOR, runHistorySummary, runOutcome } from '../lib/runHistory.js'
import { RunTimeline } from './RunTimeline.jsx'
import { Button, Chip, Eyebrow, Glyph, Segmented, Switch, toneColor } from './ui.jsx'

const INTERVALS = [0.25, 0.5, 1, 2, 6, 24]

function Banner({ tone, title, children, action, testId }) {
  const color = toneColor(tone)
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.25 }}
      className="relative overflow-hidden rounded-[16px] border px-4 py-3.5"
      style={{ borderColor: `color-mix(in srgb, ${color} 30%, transparent)`, background: `color-mix(in srgb, ${color} 7%, transparent)` }}
      data-banner={testId}
      role={tone === 'fail' ? 'alert' : undefined}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color, boxShadow: `0 0 16px ${color}` }} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color }}>{title}</div>
          {children && <div className="mt-1 text-[14px] leading-relaxed text-fg2">{children}</div>}
        </div>
        {action}
      </div>
    </motion.div>
  )
}

function RunningBanner({ slot, state, now }) {
  return (
    <Banner tone="run" title={`Incubating · ${state.detail} via ${runnerLabel(slot.running?.runner || slot.runner)}`} testId="running">
      <div className="flex items-center gap-3">
        <span className="num font-mono text-[20px] font-medium text-fg">{fmtClock((now - state.startedAt) / 1000)}</span>
        <span className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.span
            className="absolute inset-y-0 w-1/4 rounded-full"
            style={{ background: 'linear-gradient(90deg, transparent, var(--run), transparent)' }}
            animate={{ x: ['-100%', '400%'] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
          />
        </span>
      </div>
    </Banner>
  )
}

function Section({ children, className = '' }) {
  return <div className={`border-t border-white/[0.06] px-5 py-6 sm:px-7 ${className}`}>{children}</div>
}

// Shaping -> Building -> Polishing -> Done. The lab moves the project along.
function StageTrack({ slot }) {
  const current = stageOf(slot)
  return (
    <ol className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={`Stage: ${current.label}`} data-stage={current.key}>
      {STAGE_STEPS.map((step, index) => {
        const reached = index <= current.index
        const active = index === current.index
        return (
          <li key={step.key} className="flex items-center gap-1.5" title={step.blurb}>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[12px] font-medium ${active ? 'text-fg' : reached ? 'text-fg3' : 'text-fg4'}`}
              style={active ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 38%, transparent)' } : undefined}
              aria-current={active ? 'step' : undefined}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: reached ? 'var(--accent)' : 'rgba(148,163,184,0.35)', boxShadow: active ? '0 0 8px var(--accent-glow)' : 'none' }} />
              {step.key === 'shaping' && slot.stage === 'advancing' ? 'Next milestone' : step.key === 'done' && slot.lifecycle === 'finite' ? 'Done' : step.label}
            </span>
            {index < STAGE_STEPS.length - 1 && <span aria-hidden="true" className={`h-px w-3 ${index < current.index ? 'bg-[var(--accent)] opacity-60' : 'bg-white/[0.12]'}`} />}
          </li>
        )
      })}
    </ol>
  )
}

function evidenceUrl(slot, evidence, file) {
  return `/api/incubators/${encodeURIComponent(slot.id)}/evidence/${encodeURIComponent(evidence)}/${encodeURIComponent(file)}`
}

// What the product looks like now (the lab's own screenshot of the last kept
// session), next to how it looked the session before.
function ProductView({ slot }) {
  const kept = slot.keptEvidence || []
  const latest = kept[kept.length - 1] || null
  const previous = kept.length > 1 ? kept[kept.length - 2] : null
  const [which, setWhich] = useState('now')
  const [view, setView] = useState('desktop')
  useEffect(() => { setWhich('now'); setView('desktop') }, [slot.id, latest?.run])
  const shown = which === 'before' && previous ? previous : latest
  const file = shown?.shots?.includes(`${view}.png`) ? `${view}.png` : shown?.shots?.[0]

  if (!latest) {
    return (
      <div className="grid min-h-[180px] place-items-center rounded-[16px] border border-dashed border-white/[0.09] bg-black/20 p-6 text-center" data-product-view="none">
        <div>
          <div className="text-[14px] font-medium text-fg2">No screenshot yet</div>
          <p className="mx-auto mt-1 max-w-[340px] text-[13px] leading-relaxed text-fg4">
            After each kept session the lab opens web apps in a headless browser and keeps what it saw here.{slot.playUrl ? ' You can open the app itself above.' : ''}
          </p>
        </div>
      </div>
    )
  }
  return (
    <figure className="m-0" data-product-view={`run-${latest.run}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {previous ? (
          <Segmented
            size="sm"
            ariaLabel="Compare with the previous session"
            layoutId={`shot-${slot.id}`}
            options={[{ value: 'now', label: `Now · #${latest.run}` }, { value: 'before', label: `Before · #${previous.run}` }]}
            value={which}
            onChange={setWhich}
          />
        ) : <span className="text-[12px] text-fg4">After session #{latest.run}</span>}
        {shown?.shots?.includes('mobile.png') && (
          <Segmented
            size="sm"
            ariaLabel="Screen size"
            layoutId={`view-${slot.id}`}
            options={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Phone' }]}
            value={view}
            onChange={setView}
          />
        )}
      </div>
      <div className={`overflow-hidden rounded-[14px] border border-white/[0.08] bg-black/40 ${view === 'mobile' ? 'mx-auto max-w-[260px]' : ''}`}>
        <img
          key={`${shown.evidence}/${file}`}
          src={evidenceUrl(slot, shown.evidence, file)}
          alt={`${slotName(slot)} after session #${shown.run} (${view})`}
          className="block max-h-[420px] w-full object-cover object-top"
          loading="lazy"
          data-shot={`${shown.evidence}/${file}`}
        />
      </div>
      <figcaption className="mt-2 text-[12px] text-fg4">Screenshot the lab took after session #{shown.run}{shown.at ? `, ${fmtRelativeDay(String(shown.at).slice(0, 10))}` : ''}.</figcaption>
    </figure>
  )
}

// The builder's own brief: what it is, and what done means.
function BriefCard({ slot }) {
  const brief = slot.brief || {}
  if (!brief.exists) {
    return (
      <div data-brief="none">
        <Eyebrow>Brief</Eyebrow>
        <p className="mt-3 text-[14px] leading-relaxed text-fg3">
          The first session records the product direction in <span className="font-mono text-[13px] text-fg2">BRIEF.md</span> and chooses its first milestone. Each milestone can take multiple sessions.
        </p>
      </div>
    )
  }
  const milestone = slot.milestone || brief
  const outcomes = milestone.done || []
  const doneCount = outcomes.filter(item => item.checked).length
  return (
    <div data-brief="present">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Product direction</Eyebrow>
        {outcomes.length > 0 && <span className="num text-[12px] text-fg4">{doneCount}/{outcomes.length} outcomes checked</span>}
      </div>
      {brief.what && <p className="mt-3 text-[16px] leading-snug tracking-[-0.01em] text-fg">{brief.what}</p>}
      <p className="mt-3 text-[12px] text-fg4">{slot.lifecycle === 'finite' ? 'Bounded deliverable' : 'Ongoing product · milestones continue automatically while autopilot is on'} · {slot.milestoneCount || 0} milestones completed</p>
      {slot.milestone && <p className="mt-4 text-[14px] text-fg2">Current milestone: {milestone.goal}</p>}
      {outcomes.length > 0 && (
        <ul className="mt-4 grid gap-2" data-brief-done={outcomes.length}>
          {outcomes.map(item => (
            <li key={item.text} className="flex items-start gap-2.5 text-[14px] leading-relaxed">
              <span
                aria-hidden="true"
                className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-[10px]"
                style={item.checked
                  ? { borderColor: 'color-mix(in srgb, var(--ok) 55%, transparent)', background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }
                  : { borderColor: 'rgba(255,255,255,0.14)' }}
              >
                {item.checked ? '✓' : ''}
              </span>
              <span className={item.checked ? 'text-fg3' : 'text-fg2'}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      {brief.constraints.length > 0 && (
        <p className="mt-4 text-[12px] leading-relaxed text-fg4">Designed within: {brief.constraints.join(' · ')}</p>
      )}
      {slot.milestoneHistory?.length > 0 && <details className="mt-4 text-[12px] text-fg3"><summary>Recent completed milestones</summary><ul className="mt-2 grid gap-2">{slot.milestoneHistory.map(item => <li key={`${item.key}-${item.run}`}>#{item.run} · {item.goal}</li>)}</ul></details>}
    </div>
  )
}

function RatingMeter({ rating }) {
  return (
    <span className="inline-flex gap-1" aria-label={rating == null ? 'not rated' : `${rating} of 5`}>
      {[1, 2, 3, 4, 5].map(step => {
        const fill = rating == null ? 0 : Math.max(0, Math.min(1, rating - step + 1))
        return (
          <span key={step} className="h-2 w-6 overflow-hidden rounded-full bg-white/[0.07]">
            <span className="block h-full rounded-full" style={{ width: `${fill * 100}%`, background: 'var(--accent)', boxShadow: fill ? '0 0 8px var(--accent-glow)' : 'none' }} />
          </span>
        )
      })}
    </span>
  )
}

function ReviewColumn({ slot }) {
  const review = reviewState(slot)
  return (
    <div data-review={review.reviewed ? review.verdict : 'none'}>
      <Eyebrow>Independent review</Eyebrow>
      {review.reviewed ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chip tone={review.tone}>{review.label}</Chip>
            <Chip tone={review.done ? 'ok' : 'idle'}>{review.done ? 'milestone met' : 'milestone in progress'}</Chip>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <RatingMeter rating={review.rating} />
            <span className="num text-[12px] text-fg4">{review.rating}/5</span>
          </div>
          {review.problems.length > 0 && (
            <ol className="mt-3 grid gap-1.5 text-[13px] leading-relaxed text-fg2" data-review-problems={review.problems.length}>
              {review.problems.slice(0, 3).map((problem, index) => (
                <li key={problem} className="flex gap-2"><span className="num text-fg4">{index + 1}.</span><span>{clip(problem, 150)}</span></li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-[12px] text-fg4">By {runnerLabel(review.reviewer)} in a fresh session{review.run ? ` after #${review.run}` : ''}. It steers the next session.</p>
        </>
      ) : (
        <p className="mt-3 text-[14px] leading-relaxed text-fg4">After each kept session a separate, read-only agent looks at the product and says what a person would feel. {review.rating != null ? `Older self-rating: ${review.rating}/5.` : ''}</p>
      )}
      {slot.lastReviewError && <p className="mt-2 text-[12px] text-warn">Last review unavailable: {slot.lastReviewError}.</p>}
    </div>
  )
}

function LastNextBand({ slot, runs, now }) {
  const last = [...runs].reverse()[0] || null
  const outcome = last ? runOutcome(last) : null
  const meta = outcome?.key ? OUTCOME[outcome.key] : null
  const nextAt = timeValue(slot.nextRunAt)
  const upcoming = upcomingRun(slot)
  const resting = slot.stage === 'done' && slot.lifecycle === 'finite'
  const when = slot.running?.running
    ? 'after the current session'
    : resting ? 'when a note wakes it'
      : slot.enabled
        ? nextAt > now ? `in ${fmtDuration(nextAt - now)}` : 'any moment'
        : 'when you press Run'
  const noteFirst = slot.latestUserFeedback && timeValue(slot.feedbackUpdatedAt) > timeValue(slot.lastOutcomeAt)
  const nextMove = nextMoveFromRuns(runs)
  return (
    <div className="grid gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-white/[0.06]">
      <div className="md:pr-6" data-last-run={last?.num ?? 'none'}>
        <Eyebrow>Last session</Eyebrow>
        {last ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.1em]" style={{ color: RUN_TYPE_COLOR[last.type] || 'var(--text-3)' }}>{last.type}</span>
              <span className="num text-[13px] text-fg4">#{last.num} · {fmtRelativeDay(last.date)}</span>
              {meta && <Chip tone={meta.tone} data-outcome={outcome.key}>{meta.label}</Chip>}
            </div>
            <p className={`mt-2 text-[14px] leading-relaxed ${last.type === 'FAILED' ? 'text-[rgba(254,202,202,0.92)]' : 'text-fg2'}`}>{clip(last.type === 'FAILED' ? failureHeadline(runHistorySummary(last)) : runHistorySummary(last), 180)}</p>
            {(outcome.key === 'reverted' || outcome.key === 'regressed') && outcome.reason && (
              <p className="mt-2 text-[13px] leading-relaxed text-warn" data-outcome-reason={outcome.key}>{outcome.key === 'reverted' ? 'Reverted by the lab: ' : 'Made the product worse: '}{clip(outcome.reason, 160)}</p>
            )}
          </>
        ) : <p className="mt-3 text-[14px] text-fg4">Nothing has run yet.</p>}
      </div>
      <div className="md:px-6" data-next-run={upcoming.type}>
        <Eyebrow>Next session</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold uppercase tracking-[0.1em]" style={{ color: RUN_TYPE_COLOR[upcoming.type] || 'var(--text-3)' }}>{upcoming.type}</span>
          <span className="num text-[13px] text-fg4">#{upcoming.num} · {when}</span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-fg2" data-next-move={noteFirst ? 'note' : nextMove ? 'agent' : 'default'}>
          {noteFirst
            ? <>Your note comes first: <span className="text-fg">{clip(slot.latestUserFeedback, 160)}</span></>
            : nextMove ? clip(nextMove, 180) : 'The builder picks the most valuable next goal from its brief, the review and your notes.'}
        </p>
      </div>
      <div className="md:pl-6">
        <ReviewColumn slot={slot} />
      </div>
    </div>
  )
}

function Steering({ slot, onSend }) {
  const [text, setText] = useState('')
  const [state, setState] = useState(null)
  useEffect(() => { setText(''); setState(null) }, [slot.id])
  const send = async event => {
    event.preventDefault()
    const feedback = text.trim()
    if (feedback.length < 3 || state === 'saving') return
    setState('saving')
    try {
      await onSend(feedback)
      setText('')
      setState('saved')
      setTimeout(() => setState(current => current === 'saved' ? null : current), 2200)
    } catch (err) {
      setState(err.message)
    }
  }
  return (
    <form onSubmit={send}>
      <Eyebrow>Leave a note</Eyebrow>
      <p className="mt-2 text-[14px] text-fg3">Optional. The next session reads it before anything else{slot.stage === 'done' && slot.lifecycle === 'finite' ? ', and it wakes this finished project up' : ''}.</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <textarea
          className="field min-h-[52px] flex-1 resize-y"
          rows={2}
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="I like where this is heading, but…"
          aria-label={`Note for ${slotName(slot)}`}
        />
        <Button type="submit" variant="ghost" disabled={text.trim().length < 3 || state === 'saving'}>
          {state === 'saving' ? 'Sending…' : state === 'saved' ? 'Sent ✓' : 'Send'}
        </Button>
      </div>
      {state && !['saving', 'saved'].includes(state) && <p className="mt-2 text-[13px] text-fail">{state}</p>}
      {slot.latestUserFeedback && (
        <p className="mt-3 text-[13px] leading-relaxed text-fg4">
          Last note{slot.feedbackUpdatedAt ? ` · ${new Date(slot.feedbackUpdatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}: <span className="text-fg3">{clip(slot.latestUserFeedback.replace(/^#.*$/gm, ''), 200)}</span>
        </p>
      )}
    </form>
  )
}

function RunnerDetails({ slot, preflight }) {
  const setup = slot.runnerSetups?.claude
  const rows = [
    ['Builder', runnerLabel(slot.runner)],
    ['Reviewer', slot.review === false ? 'off' : `${runnerLabel(slot.reviewer)} (fresh session, read-only)`],
    ['Command', preflight?.command],
    slot.runner === 'claude' ? ['Model', `${slot.claudeModel || setup?.model || 'CLI default'} (falls back to sonnet)`] : ['Model', slot.codexModel || 'Codex default'],
    slot.runner === 'claude' ? ['Permissions', setup?.permissionMode || 'auto'] : ['Sandbox', 'workspace-write (project only)'],
    ['Version control', slot.ratchet === 'off' ? `off: ${slot.ratchetReason || 'unavailable'}` : slot.lastGoodCommit ? `on · last good ${slot.lastGoodCommit}` : 'starts with the first session'],
    ['Launcher', slot.launcher ? shortPath(slot.launcher) : null],
    ['Repo', slot.repo],
    ['Run log', slot.runLog ? shortPath(slot.runLog) : null],
  ].filter(([, value]) => value)
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-[13px] font-medium text-fg3 transition-colors hover:text-fg">
        <span className="inline-block transition-transform group-open:rotate-90">›</span> Runner details
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[12px] font-medium text-fg4">{label}</dt>
            <dd className="break-all font-mono text-[12px] text-fg3">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

export function IncubatorDetail({ slot, runs = [], preflight, historyError, now, actions }) {
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [failureOpen, setFailureOpen] = useState(false)
  useEffect(() => { setNotice(null); setConfirmRemove(false); setFailureOpen(false) }, [slot.id])
  useEffect(() => {
    if (!confirmRemove) return undefined
    const id = setTimeout(() => setConfirmRemove(false), 3500)
    return () => clearTimeout(id)
  }, [confirmRemove])

  const hue = slotHue(slot.id)
  const name = slotName(slot)
  const state = slotState(slot, { preflight, now })
  const problems = preflightProblems(preflight)
  const running = state.kind === 'running'
  const intervalOptions = [...new Set([...INTERVALS, Number(slot.intervalHours) || 0.5])].sort((a, b) => a - b)
    .map(hours => ({ value: hours, label: fmtInterval(hours) }))

  const act = async (kind, fn, success) => {
    setBusy(kind)
    setNotice(null)
    try {
      const result = await fn()
      const text = typeof success === 'function' ? success(result) : success
      if (text) setNotice({ tone: result?.warning && /blocked/i.test(result.warning) ? 'fail' : 'ok', text })
    } catch (err) {
      setNotice({ tone: 'fail', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  const runLabel = running ? 'Incubating…' : busy === 'run' ? 'Starting…' : problems.length ? 'Try run' : 'Run now'
  const setup = slot.runnerSetups?.claude
  const runnerCaption = slot.runner === 'claude'
    ? `${slot.claudeModel || setup?.model || 'sonnet'} · ${setup?.permissionMode || 'auto'} permissions`
    : slot.codexModel || 'sandboxed to the project'

  return (
    <article className="glass overflow-hidden" aria-label={`${name} incubator`} data-incubator-detail={slot.id}>
      <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: `radial-gradient(circle, ${hue}33, transparent 70%)` }} />
      <div className="relative px-5 pb-6 pt-6 sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 items-center gap-4">
            <Glyph letter={name.slice(0, 1).toUpperCase()} hue={hue} size={58} running={running} tone={state.tone === 'fail' ? 'fail' : null} rating={slot.lastQualityRating} />
            <div className="min-w-0">
              <h2 className="truncate text-[26px] font-semibold leading-tight tracking-[-0.03em] text-fg sm:text-[30px]">{name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg4">
                {slot.phase && <><span>{slot.phase}</span><span>·</span></>}
                <span className="num">{slot.runCount || 0} sessions</span>
              </div>
              <StageTrack slot={slot} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {slot.playUrl && (
              <a href={slot.playUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-[12px] border border-white/[0.08] bg-white/[0.04] px-4 text-[14px] text-fg2 transition-colors hover:bg-white/[0.08] hover:text-fg">
                Open app <span aria-hidden="true">↗</span>
              </a>
            )}
            <Button
              variant={problems.length ? 'danger' : running ? 'ghost' : 'run'}
              onClick={() => act('run', () => actions.run(slot.id), `${name} started`)}
              disabled={running || !!busy}
              title={problems.length ? `Launch is blocked: ${problems[0]}. Trying records the blocked attempt in history.` : `Run a session of ${name} now`}
              data-run-button={slot.id}
              data-run-blocked={problems.length ? 'true' : 'false'}
            >
              {!running && !problems.length && <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" /></svg>}
              {runLabel}
            </Button>
            <Button
              variant={confirmRemove ? 'danger' : 'quiet'}
              size="md"
              onClick={() => confirmRemove ? act('remove', () => actions.remove(slot.id)) : setConfirmRemove(true)}
              disabled={!!busy}
              title="Remove from Pi Pulse (the project files stay on disk)"
            >
              {confirmRemove ? 'Confirm remove' : 'Remove'}
            </Button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4 rounded-[16px] border border-white/[0.06] bg-black/25 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              checked={!!slot.enabled}
              onChange={enabled => act('schedule', () => actions.setSchedule(slot, { enabled }), enabled ? 'Autopilot on — it will run on its own' : 'Autopilot off')}
              disabled={!!busy}
              label="Autopilot"
            />
            <div>
              <div className="text-[14px] font-medium text-fg">Autopilot</div>
              <div className="text-[12px] text-fg4">{slot.enabled ? `a session every ${fmtInterval(slot.intervalHours)}` : 'runs only when you press Run'}</div>
            </div>
            <Segmented
              size="sm"
              ariaLabel="Run interval"
              layoutId={`interval-${slot.id}`}
              options={intervalOptions}
              value={Number(slot.intervalHours) || 0.5}
              onChange={hours => act('schedule', () => actions.setSchedule(slot, { intervalHours: hours }), `Every ${fmtInterval(hours)}`)}
              disabled={!!busy}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              size="sm"
              ariaLabel="Runner"
              layoutId={`runner-${slot.id}`}
              options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]}
              value={slot.runner}
              onChange={runner => act('runner', () => actions.setRunner(slot, runner), result => result.warning || `${runnerLabel(runner)} selected`)}
              disabled={!!busy || running}
            />
            <span className="text-[12px] text-fg4" data-runner-caption={slot.runner}>{runnerCaption}</span>
          </div>
        </div>

        <div className="mt-4 grid gap-3" aria-live="polite">
          <AnimatePresence initial={false}>
            {running && <RunningBanner key="running" slot={slot} state={state} now={now} />}
            {state.kind === 'blocked' && (
              <Banner key="blocked" tone="fail" title="Launch blocked" testId="blocked">
                <ul className="grid gap-1" data-preflight-problems={problems.length}>
                  {problems.map(problem => <li key={problem} className="font-mono text-[13px] text-[rgba(254,202,202,0.92)]">{problem}</li>)}
                </ul>
                <p className="mt-2 text-[13px] text-fg3">This is setup the lab cannot fix by itself. Until it is fixed, every launch attempt is recorded as a failed session.</p>
              </Banner>
            )}
            {!running && state.kind !== 'blocked' && slot.lastRunStatus === 'failed' && (
              <Banner
                key="failed"
                tone="fail"
                title={`Last session failed${slot.lastRunFailureSource ? ` · ${slot.lastRunFailureSource}` : ''}`}
                testId="failed"
                action={slot.lastRunFailure && slot.lastRunFailure.length > 120 ? <Button size="sm" variant="quiet" onClick={() => setFailureOpen(open => !open)}>{failureOpen ? 'Less' : 'Full error'}</Button> : null}
              >
                <span className="font-mono text-[13px] text-[rgba(254,202,202,0.92)]">{failureOpen ? slot.lastRunFailure : clip(failureHeadline(slot.lastRunFailure || ''), 200)}</span>
                {slot.enabled && (
                  <p className="mt-2 text-[13px] text-fg3" data-retry={slot.failStreak || 0}>
                    Nothing to do: it retries on its own{timeValue(slot.nextRunAt) > now ? ` in ${fmtDuration(timeValue(slot.nextRunAt) - now)}` : ' shortly'}{slot.failStreak > 1 ? `, waiting longer after each failure (${slot.failStreak} in a row)` : ''}.
                  </p>
                )}
              </Banner>
            )}
            {state.kind === 'paused' && (
              <Banner
                key="paused"
                tone="warn"
                title="Autopilot paused"
                testId="paused"
                action={<Button size="sm" variant="ghost" onClick={() => act('schedule', () => actions.setSchedule(slot, { enabled: true }), 'Autopilot resumed')} disabled={!!busy}>Resume</Button>}
              >
                {state.detail}
              </Banner>
            )}
            {state.kind === 'resting' && (
              <Banner key="resting" tone="ok" title="Done — it meets its brief" testId="resting">
                The reviewer confirmed the brief and polishing found nothing more worth doing, so it rests. Leave a note to give it something new.
              </Banner>
            )}
            {notice && (
              <Banner key={`notice-${notice.text}`} tone={notice.tone} title={notice.tone === 'fail' ? 'That did not work' : 'Done'} testId="notice">{notice.text}</Banner>
            )}
          </AnimatePresence>
        </div>
      </div>

      <Section>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-8">
          <ProductView slot={slot} />
          <BriefCard slot={slot} />
        </div>
      </Section>
      <Section>
        <LastNextBand slot={slot} runs={runs} now={now} />
      </Section>
      <Section>
        <RunTimeline runs={runs} slotId={slot.id} error={historyError} />
      </Section>
      <Section>
        <Steering slot={slot} onSend={feedback => actions.sendFeedback(slot.id, feedback)} />
      </Section>
      <Section className="pb-7">
        <RunnerDetails slot={slot} preflight={preflight} />
      </Section>
    </article>
  )
}
