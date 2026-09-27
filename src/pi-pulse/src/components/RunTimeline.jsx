import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { clip, fmtRelativeDay } from '../lib/format.js'
import { OUTCOME } from '../lib/incubator.js'
import {
  defaultOpenRunKey,
  failureHeadline,
  RUN_TYPE_COLOR,
  runAttemptText,
  runHistorySummary,
  runOutcome,
  runOutputDetail,
  timelineRuns,
} from '../lib/runHistory.js'
import { runHistoryKey } from '../lib/runSignals.js'
import { Chip, Eyebrow } from './ui.jsx'

const GATE_TONE = { PASS: 'ok', 'NEEDS-EVIDENCE': 'warn', FAIL: 'fail' }

function gateOf(run) {
  const raw = String(run['Quality gate'] || '').toUpperCase()
  if (raw.startsWith('PASS')) return 'PASS'
  if (raw.startsWith('FAIL')) return 'FAIL'
  if (raw.includes('EVIDENCE')) return 'NEEDS-EVIDENCE'
  return null
}

export function RunRow({ run, runKey, open, onToggle, last }) {
  const failed = run.type === 'FAILED'
  const color = RUN_TYPE_COLOR[run.type] || 'rgba(148,163,184,0.7)'
  const summary = failed ? failureHeadline(runHistorySummary(run)) : runHistorySummary(run)
  const detail = runOutputDetail(run) || (failed ? summary : '')
  const gate = gateOf(run)
  const outcome = OUTCOME[runOutcome(run).key]
  const attempt = runAttemptText(run)
  return (
    <li
      className="relative flex gap-4 pb-5"
      data-run-key={runKey}
      data-run-type={run.type || 'RUN'}
      data-detail-open={detail ? String(open) : undefined}
    >
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[6px] top-5 w-px bg-gradient-to-b from-white/[0.12] to-white/[0.02]" />}
      <span className="relative mt-1.5 h-[13px] w-[13px] shrink-0 rounded-full border-2" style={{ borderColor: color, background: failed ? color : '#05070a', boxShadow: `0 0 10px ${color}66` }} />
      <div className={`min-w-0 flex-1 ${failed ? 'rounded-[14px] border border-[rgba(248,113,113,0.22)] bg-[rgba(248,113,113,0.05)] p-3.5' : ''}`}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[12px] font-semibold uppercase tracking-[0.12em]" style={{ color }}>{run.type || 'Run'}</span>
          <span className="num text-[12px] text-fg4">#{run.num} · {fmtRelativeDay(run.date)}{attempt ? ` · ${attempt}` : ''}</span>
          {outcome && !failed
            ? <Chip tone={outcome.tone} data-run-outcome={runOutcome(run).key}>{outcome.label.toLowerCase()}</Chip>
            : gate && <Chip tone={GATE_TONE[gate]}>{gate === 'NEEDS-EVIDENCE' ? 'needs evidence' : gate.toLowerCase()}{run['Quality rating'] ? ` · ${run['Quality rating']}` : ''}</Chip>}
        </div>
        <p className={`mt-1.5 text-[14px] leading-relaxed ${failed ? 'text-[rgba(254,202,202,0.92)]' : 'text-fg2'}`}>{clip(summary, failed ? 260 : 200)}</p>
        {detail && (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              data-detail-toggle={runKey}
              className={`focus-ring inline-flex max-w-full items-center gap-2 rounded-[10px] px-2.5 py-1 text-[12px] transition-colors ${failed ? 'text-fail hover:bg-[rgba(248,113,113,0.08)]' : 'text-fg3 hover:bg-white/[0.05] hover:text-fg2'}`}
            >
              <span className="font-semibold uppercase tracking-[0.1em]">{open ? 'Hide' : failed ? 'Error' : 'Details'}</span>
              {!open && failed && <span className="truncate font-mono text-fg4">{clip(failureHeadline(detail), 90)}</span>}
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.pre
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  className={`mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[12px] border p-3 font-mono text-[12px] leading-relaxed ${failed ? 'border-[rgba(248,113,113,0.2)] bg-black/40 text-[rgba(254,202,202,0.9)]' : 'border-white/[0.06] bg-black/35 text-fg3'}`}
                >
                  {detail}
                </motion.pre>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </li>
  )
}

export function RunTimeline({ runs = [], slotId, error = null, limit = 8 }) {
  const [openKeys, setOpenKeys] = useState({})
  const { runs: visible, pinned } = timelineRuns(runs, limit)
  const defaultOpenKey = defaultOpenRunKey(visible, slotId)
  const isOpen = key => openKeys[key] ?? key === defaultOpenKey
  const toggle = key => setOpenKeys(prev => ({ ...prev, [key]: !isOpen(key) }))

  return (
    <div data-run-timeline={slotId}>
      <div className="mb-4 flex items-baseline justify-between">
        <Eyebrow>Run history</Eyebrow>
        <span className="num text-[12px] text-fg4">{runs.length ? `${runs.length} recorded` : ''}</span>
      </div>
      {error && (
        <div className="mb-4 rounded-[12px] border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.06)] px-3 py-2 text-[13px] text-fail" role="alert" data-run-history-error={slotId}>
          History unavailable: {error}
        </div>
      )}
      {pinned && (
        <div className="mb-5 rounded-[14px] border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.07)] px-4 py-3" data-pinned-failure={pinned.num}>
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-fail">Unresolved failure · #{pinned.num}</div>
          <p className="mt-1 text-[14px] text-[rgba(254,202,202,0.92)]">{clip(failureHeadline(runOutputDetail(pinned) || runHistorySummary(pinned)), 220)}</p>
        </div>
      )}
      {!visible.length && !error && <p className="text-[14px] text-fg4">No runs yet — the first run will appear here.</p>}
      <ol>
        {visible.map((run, index) => {
          const key = runHistoryKey(slotId, run, index)
          return <RunRow key={key} run={run} runKey={key} open={isOpen(key)} onToggle={() => toggle(key)} last={index === visible.length - 1} />
        })}
      </ol>
    </div>
  )
}

