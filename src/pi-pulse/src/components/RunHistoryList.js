import { createElement as h } from 'react'
import { runHistoryKey } from '../lib/runSignals.js'

const TYPE_COLOR = {
  MUTATE: '#a78bfa',
  RESEARCH: '#34d399',
  CREATE: '#22d3ee',
  FAILED: '#f87171',
}

const SUMMARY_FIELDS = [
  'Failure',
  'Error',
  'Goal',
  'Acceptance check',
  'Done',
  'What I investigated',
  'Investigated',
  'What I built',
  'What I changed',
  'What changed',
  'What improved',
  'What I found',
  'Finding',
  'Key finding',
  'Quality gate',
  'Quality rating',
  'Output excerpt',
  'Suggested next move',
]

export function runAttemptText(run = {}) {
  return run.attemptTotal > 1 && run.attempt ? ` · attempt ${run.attempt}/${run.attemptTotal}` : ''
}

export function failureSignal(detail = '') {
  const lines = String(detail).split('\n').map(line => line.trim()).filter(Boolean)
  const commandError = lines.find(line => /command not found|not found|enoent|permission denied|exit status|exit \d+|error|failed/i.test(line))
  return commandError || lines.find(line => !line.startsWith('[run failed')) || lines[0] || 'failure detail unavailable'
}

export function outputSignal(detail = '') {
  const text = String(detail || '')
  const stdoutPath = text.match(/Full stdout saved to\s+(\S+)/i)?.[1]?.replace(/[.)\]]+$/, '')
  if (stdoutPath) return `stdout: ${stdoutPath}`
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.find(line => !/^Output(?: excerpt)?|Stdout tail|Next move/i.test(line)) || lines[0] || 'captured stdout'
}

function isStdoutPathOnly(value = '') {
  return /^Full stdout saved to\s+\S+\s*$/i.test(String(value || '').trim())
}

export function runHistorySummary(run = {}) {
  const syntheticDone = /^(Claude|Codex) completed but did not append a run summary\.$/.test(run.Done || '')
  if (syntheticDone && run['Output excerpt'] && !isStdoutPathOnly(run['Output excerpt'])) {
    return run['Output excerpt']
  }
  for (const field of SUMMARY_FIELDS) {
    if (field === 'Done' && syntheticDone) continue
    if ((field === 'Output excerpt' || field === 'Output') && isStdoutPathOnly(run[field])) continue
    if (run[field]) return run[field]
  }
  if (run['Stdout tail']) return run['Stdout tail']
  if (run.Output && !isStdoutPathOnly(run.Output)) return run.Output
  if (run.Done) return run.Done
  if (run['Next move']) return run['Next move']
  return 'stdout captured with no summary'
}

export function runFailureDetail(run = {}) {
  if (run.detail) return run.detail
  return ['Failure', 'Error', 'Output excerpt', 'Output', 'Stdout tail', 'Next move']
    .filter(field => run[field])
    .map(field => `${field}: ${run[field]}`)
    .join('\n')
}

export function runOutputDetail(run = {}) {
  if (run.type === 'FAILED') return runFailureDetail(run)
  const detailFields = [
    'Acceptance check',
    'Evidence',
    'Quality gate',
    'Quality rating',
    'Evidence confidence',
    'Risk / regression',
    'Output excerpt',
    'Stdout tail',
    'Output',
    'Next move',
  ]
  if (!detailFields.some(field => run[field])) return ''
  return detailFields
    .filter(field => run[field])
    .map(field => `${field}: ${run[field]}`)
    .join('\n')
}

export function RunHistoryList({
  displayRuns = [],
  slotId = 'slot',
  expandedFailureKeys = {},
  setExpandedFailureKeys = () => {},
  defaultOpenFailureKey = null,
}) {
  if (displayRuns.length === 0) {
    return h('div', {
      style: { fontSize: '0.75rem', color: 'rgba(71,85,105,0.35)', fontFamily: 'monospace' },
    }, 'no runs yet')
  }

  const latestFailureIndex = displayRuns.findIndex(run => run?.type === 'FAILED')
  const latestFailure = latestFailureIndex >= 0 ? displayRuns[latestFailureIndex] : null
  const latestFailureKey = latestFailure ? runHistoryKey(slotId, latestFailure, latestFailureIndex) : null
  const latestFailureDetail = latestFailure ? (runFailureDetail(latestFailure) || runHistorySummary(latestFailure)) : ''
  const latestFailureOpen = latestFailureKey
    ? !!latestFailureDetail && (expandedFailureKeys[latestFailureKey] ?? latestFailureKey === defaultOpenFailureKey)
    : false
  const latestFailureLabel = latestFailure ? failureSignal(latestFailureDetail) : ''
  const openLatestFailure = () => {
    if (!latestFailureKey) return
    setExpandedFailureKeys(prev => ({ ...prev, [latestFailureKey]: true }))
  }

  const rows = displayRuns.map((run, i) => {
    const runColor = TYPE_COLOR[run.type] ?? 'rgba(71,85,105,0.5)'
    const what = runHistorySummary(run)
    const rowDetail = runOutputDetail(run) || (run.type === 'FAILED' ? what : '')
    const itemKey = runHistoryKey(slotId, run, i)
    const detailOpen = !!rowDetail && (expandedFailureKeys[itemKey] ?? itemKey === defaultOpenFailureKey)
    const detailLabel = run.type === 'FAILED' ? failureSignal(rowDetail || what) : outputSignal(rowDetail || what)
    const summaryLimit = run.type === 'FAILED' ? 180 : 92
    const isLast = i === displayRuns.length - 1
    const failed = run.type === 'FAILED'
    const detailKind = failed ? 'error' : 'stdout'
    const ariaDetailKind = failed ? 'failure' : 'stdout'

    return h('div', {
      key: itemKey,
      'data-run-key': itemKey,
      'data-run-type': run.type ?? 'run',
      'data-failure-open': failed ? String(detailOpen) : undefined,
      'data-stdout-open': !failed && rowDetail ? String(detailOpen) : undefined,
      style: {
        display: 'flex',
        gap: 10,
        padding: failed ? '8px 9px 10px 7px' : `0 0 ${isLast ? 0 : 14}px 0`,
        margin: failed ? '0 0 10px -7px' : 0,
        position: 'relative',
        borderRadius: failed ? 7 : 0,
        border: failed ? '1px solid rgba(248,113,113,0.18)' : 'none',
        borderLeft: failed ? '3px solid rgba(248,113,113,0.8)' : 'none',
        background: failed ? 'rgba(248,113,113,0.055)' : 'transparent',
      },
    }, [
      !isLast && h('div', {
        key: 'line',
        style: { position: 'absolute', left: failed ? 9 : 3, top: failed ? 17 : 9, bottom: failed ? -10 : 0, width: 1, background: 'linear-gradient(to bottom, var(--border), transparent)' },
      }),
      h('div', {
        key: 'dot',
        style: { width: 7, height: 7, borderRadius: '50%', background: runColor, flexShrink: 0, marginTop: 3, boxShadow: `0 0 5px ${runColor}66` },
      }),
      h('div', { key: 'body', style: { minWidth: 0, flex: 1 } }, [
        h('div', { key: 'meta', style: { display: 'flex', gap: 6, marginBottom: 2, flexWrap: 'wrap' } }, [
          h('span', {
            key: 'type',
            style: { fontSize: '0.57rem', fontFamily: 'monospace', color: runColor, letterSpacing: '0.08em', textTransform: 'uppercase' },
          }, run.type ?? 'run'),
          h('span', {
            key: 'date',
            style: { fontSize: '0.57rem', color: 'rgba(71,85,105,0.5)' },
          }, `#${run.num} ${run.date}${runAttemptText(run)}`),
        ]),
        h('div', {
          key: 'summary',
          style: { fontSize: '0.77rem', color: 'rgba(241,245,249,0.72)', lineHeight: 1.4 },
        }, what.length > summaryLimit ? `${what.slice(0, summaryLimit)}...` : what),
        rowDetail && h('div', {
          key: 'detail',
          style: { marginTop: 7, border: `1px solid ${failed ? 'rgba(248,113,113,0.16)' : 'rgba(34,211,238,0.14)'}`, borderRadius: 6, background: failed ? 'rgba(248,113,113,0.045)' : 'rgba(34,211,238,0.035)', overflow: 'hidden' },
        }, [
          h('button', {
            key: 'button',
            type: 'button',
            'aria-expanded': detailOpen,
            'aria-label': `Toggle ${ariaDetailKind} detail for run ${run.num ?? 'unknown'}: ${detailLabel}`,
            'data-failure-toggle': itemKey,
            onClick: () => setExpandedFailureKeys(prev => ({ ...prev, [itemKey]: !detailOpen })),
            style: { width: '100%', border: 'none', background: 'transparent', padding: '6px 8px', display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 7, cursor: 'pointer', textAlign: 'left' },
          }, [
            h('span', {
              key: 'kind',
              style: { fontSize: '0.54rem', fontFamily: 'monospace', color: failed ? '#f87171' : '#22d3ee', textTransform: 'uppercase', letterSpacing: '0.1em' },
            }, detailKind),
            h('span', {
              key: 'label',
              style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.64rem', fontFamily: 'monospace', color: failed ? 'rgba(254,202,202,0.86)' : 'rgba(186,230,253,0.82)' },
            }, detailLabel),
            h('span', {
              key: 'state',
              style: { fontSize: '0.54rem', fontFamily: 'monospace', color: failed ? 'rgba(248,113,113,0.58)' : 'rgba(34,211,238,0.55)', textTransform: 'uppercase', letterSpacing: '0.08em' },
            }, detailOpen ? 'hide' : 'details'),
          ]),
          detailOpen && h('pre', {
            key: 'detail',
            style: { margin: 0, maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderTop: `1px solid ${failed ? 'rgba(248,113,113,0.14)' : 'rgba(34,211,238,0.12)'}`, borderLeft: `2px solid ${runColor}`, padding: '7px 9px', background: 'rgba(0,0,0,0.16)', color: failed ? 'rgba(254,202,202,0.86)' : 'rgba(186,230,253,0.82)', fontSize: '0.64rem', lineHeight: 1.45, fontFamily: 'monospace' },
          }, rowDetail),
        ]),
      ]),
    ])
  })

  if (!latestFailure) return rows

  return [
    h('button', {
      key: 'latest-failure-callout',
      type: 'button',
      'data-latest-failure': 'true',
      'aria-label': `Open latest failure detail for run ${latestFailure.num ?? 'unknown'}: ${latestFailureLabel}`,
      onClick: openLatestFailure,
      style: {
        width: '100%',
        margin: '0 0 12px 0',
        border: '1px solid rgba(248,113,113,0.28)',
        borderLeft: '3px solid rgba(248,113,113,0.9)',
        borderRadius: 7,
        background: 'rgba(248,113,113,0.08)',
        padding: '8px 10px 9px 9px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 8,
        textAlign: 'left',
        cursor: 'pointer',
      },
    }, [
      h('span', {
        key: 'label',
        style: { fontSize: '0.55rem', fontFamily: 'monospace', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.1em' },
      }, 'latest failure'),
      h('span', {
        key: 'detail',
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.68rem', fontFamily: 'monospace', color: 'rgba(254,202,202,0.9)' },
      }, `#${latestFailure.num ?? '?'} ${latestFailure.date ?? ''} · ${latestFailureLabel}`),
      h('span', {
        key: 'state',
        style: { fontSize: '0.54rem', fontFamily: 'monospace', color: 'rgba(248,113,113,0.62)', textTransform: 'uppercase', letterSpacing: '0.08em' },
      }, latestFailureOpen ? 'open below' : 'show detail'),
    ]),
    ...rows,
  ]
}
