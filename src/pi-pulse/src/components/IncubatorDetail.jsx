import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { clip, fmtClock, fmtDuration, fmtInterval, fmtRelativeDay, shortPath, timeValue } from '../lib/format.js'
import { nextRunType, preflightProblems, qualityState, runnerLabel, slotHue, slotName, slotState, upcomingRun } from '../lib/incubator.js'
import { failureHeadline, nextMoveFromRuns, RUN_TYPE_COLOR, runHistorySummary } from '../lib/runHistory.js'
import { Critic } from './Critic.jsx'
import { RunTimeline } from './RunTimeline.jsx'
import { Button, Chip, Eyebrow, Glyph, Segmented, Switch, toneColor } from './ui.jsx'

const INTERVALS = [0.25, 0.5, 1, 2, 6, 24]
const GATE_TONE = { PASS: 'ok', 'NEEDS-EVIDENCE': 'warn', FAIL: 'fail' }

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
    <Banner tone="run" title={`Incubating · ${nextRunType(slot)} via ${runnerLabel(slot.running?.runner || slot.runner)}`} testId="running">
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

function LastNextBand({ slot, runs, now }) {
  const last = [...runs].reverse()[0] || null
  const lastGate = last ? String(last['Quality gate'] || '').toUpperCase().replace(/\s+/g, '-') : ''
  const gateKey = lastGate.startsWith('PASS') ? 'PASS' : lastGate.startsWith('FAIL') ? 'FAIL' : lastGate.includes('EVIDENCE') ? 'NEEDS-EVIDENCE' : null
  const nextAt = timeValue(slot.nextRunAt)
  const upcoming = upcomingRun(slot)
  const nextMove = nextMoveFromRuns(runs)
  const when = slot.running?.running
    ? 'after the current run'
    : slot.enabled
      ? nextAt > now ? `in ${fmtDuration(nextAt - now)}` : 'any moment'
      : 'when you press Run'
  return (
    <div className="grid gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-white/[0.06]">
      <div className="md:pr-6" data-last-run={last?.num ?? 'none'}>
        <Eyebrow>Last run</Eyebrow>
        {last ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.1em]" style={{ color: RUN_TYPE_COLOR[last.type] || 'var(--text-3)' }}>{last.type}</span>
              <span className="num text-[13px] text-fg4">#{last.num} · {fmtRelativeDay(last.date)}</span>
              {gateKey && <Chip tone={GATE_TONE[gateKey]}>{gateKey === 'NEEDS-EVIDENCE' ? 'needs evidence' : gateKey.toLowerCase()}</Chip>}
            </div>
            <p className={`mt-2 text-[14px] leading-relaxed ${last.type === 'FAILED' ? 'text-[rgba(254,202,202,0.92)]' : 'text-fg2'}`}>{clip(last.type === 'FAILED' ? failureHeadline(runHistorySummary(last)) : runHistorySummary(last), 180)}</p>
          </>
        ) : <p className="mt-3 text-[14px] text-fg4">Nothing has run yet.</p>}
      </div>
      <div className="md:px-6" data-next-run={upcoming.type}>
        <Eyebrow>Next run</Eyebrow>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold uppercase tracking-[0.1em]" style={{ color: RUN_TYPE_COLOR[upcoming.type] || 'var(--text-3)' }}>{upcoming.type}</span>
          <span className="num text-[13px] text-fg4">#{upcoming.num} · {when}</span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-fg2" data-next-move={nextMove ? 'agent' : 'default'}>{nextMove ? clip(nextMove, 180) : 'The agent picks the most valuable next step from the run log and your notes.'}</p>
      </div>
      <div className="md:pl-6">
        <Critic slotId={slot.id} autoTrigger={slot.criticTrigger || 0} />
      </div>
    </div>
  )
}

function Direction({ slot }) {
  const quality = qualityState(slot)
  const rows = [
    ['Strategy', slot.lastRunStrategy],
    ['Why this run type', slot.lastWhyRunType],
    ['Expected change', slot.lastExpectedQualityDelta],
    ['Actual change', slot.lastActualQualityDelta],
    ['Verdict', slot.lastPlateauRegressionVerdict],
    ['Evidence', slot.lastQualitySummary],
    ['App evidence', slot.lastAppEvidenceSummary ? `${slot.lastAppEvidenceGate || ''} ${slot.lastAppEvidenceSummary}`.trim() : null],
  ].filter(([, value]) => value)
  if (!slot.lastNorthStar && !rows.length && quality.gate == null && quality.rating == null) return null
  return (
    <Section>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <Eyebrow>North star</Eyebrow>
          <p className="mt-3 max-w-[640px] text-[17px] leading-snug tracking-[-0.01em] text-fg">{slot.lastNorthStar ? clip(slot.lastNorthStar, 260) : <span className="text-fg4">Not declared yet.</span>}</p>
        </div>
        <div className="grid gap-2 text-right" data-quality-state={quality.label}>
          <Chip tone={quality.tone} className="justify-self-end">{quality.label}</Chip>
          <RatingMeter rating={quality.rating} />
          <span className="num text-[12px] text-fg4">
            {quality.rating == null ? 'unrated' : `quality ${quality.rating}/5`}{quality.confidence == null ? '' : ` · evidence ${quality.confidence}/5`}
          </span>
        </div>
      </div>
      {rows.length > 0 && (
        <details className="group mt-5">
          <summary className="cursor-pointer list-none text-[13px] font-medium text-fg3 transition-colors hover:text-fg">
            <span className="inline-block transition-transform group-open:rotate-90">›</span> Strategy and evidence
          </summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="rounded-[12px] border border-white/[0.05] bg-black/20 p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg4">{label}</dt>
                <dd className="mt-1 text-[13px] leading-relaxed text-fg2">{clip(value, 320)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </Section>
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
      <Eyebrow>Steer</Eyebrow>
      <p className="mt-2 text-[14px] text-fg3">The next run reads this before choosing its work. Negative feedback puts it in recovery mode.</p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <textarea
          className="field min-h-[52px] flex-1 resize-y"
          rows={2}
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="I like where this is heading, but…"
          aria-label={`Steering note for ${slotName(slot)}`}
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
    ['Runner', runnerLabel(slot.runner)],
    ['Command', preflight?.command],
    slot.runner === 'claude' ? ['Model', `${slot.claudeModel || setup?.model || 'CLI default'} (falls back to sonnet)`] : ['Model', slot.codexModel || 'Codex default'],
    slot.runner === 'claude' ? ['Permissions', setup?.permissionMode || 'auto'] : ['Sandbox', 'workspace-write (project only)'],
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
  const quality = qualityState(slot)
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
                <span className="num">{slot.runCount || 0} runs</span>
              </div>
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
              title={problems.length ? `Launch is blocked: ${problems[0]}. Trying records the blocked attempt in history.` : `Run ${name} now`}
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
              <div className="text-[12px] text-fg4">{slot.enabled ? `runs every ${fmtInterval(slot.intervalHours)}` : 'runs only when you press Run'}</div>
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
                <p className="mt-2 text-[13px] text-fg3">Fix the check above. Until then every launch attempt, manual or on autopilot, is recorded as a failed run.</p>
              </Banner>
            )}
            {!running && state.kind !== 'blocked' && slot.lastRunStatus === 'failed' && (
              <Banner
                key="failed"
                tone="fail"
                title={`Last run failed${slot.lastRunFailureSource ? ` · ${slot.lastRunFailureSource}` : ''}`}
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
            {quality.label === 'Recovery mode' && (
              <Banner key="recovery" tone="warn" title="Recovery mode" testId="recovery">
                Your latest note was critical, so the next run fixes that complaint before adding anything.
              </Banner>
            )}
            {notice && (
              <Banner key={`notice-${notice.text}`} tone={notice.tone} title={notice.tone === 'fail' ? 'That did not work' : 'Done'} testId="notice">{notice.text}</Banner>
            )}
          </AnimatePresence>
        </div>
      </div>

      <Section>
        <LastNextBand slot={slot} runs={runs} now={now} />
      </Section>
      <Direction slot={slot} />
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
