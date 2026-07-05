import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { latestCompletedRunSignature, newestFailedRunKey } from '../lib/runSignals.js'
import { AiStrip } from './AiStrip.js'
import { failureSignal, RunHistoryList } from './RunHistoryList.js'

function fmtElapsed(secs) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtCountdown(nextRunAt) {
  if (!nextRunAt) return null
  const diffMs = nextRunAt - Date.now()
  if (diffMs <= 0) return 'soon'
  const h = Math.floor(diffMs / 3600000)
  const m = Math.floor((diffMs % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function fmtInterval(hours) {
  if (!hours) return 'manual'
  const mins = Math.round(hours * 60)
  return mins < 60 ? `${mins}m` : `${hours}h`
}

function shortPath(value = '') {
  const parts = String(value || '').split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(-2).join('/') : (parts[0] || 'missing')
}

function shortCommand(value = '') {
  const command = String(value || '').trim()
  if (!command) return 'missing'
  return command.length > 118 ? `...${command.slice(-115)}` : command
}

function timeValue(ts) {
  if (!ts) return 0
  const value = typeof ts === 'number' ? ts : Date.parse(ts)
  return Number.isFinite(value) ? value : 0
}

function fmtScheduleTime(ts) {
  const value = timeValue(ts)
  if (!value) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function latestScheduleBlock(schedule = {}) {
  if (!schedule) return null
  const blockedAt = timeValue(schedule.lastScheduleBlockedAt)
  if (!blockedAt) return null
  const lastSuccess = timeValue(schedule.lastScheduledRun)
  return blockedAt > lastSuccess ? schedule.lastScheduleBlockedAt : null
}

function firstPreflightIssue(preflight) {
  if (!preflight || preflight.ok) return null
  const failed = preflight.checks?.find(c => !c.ok)
  if (!failed) return preflight.error || 'runner preflight failed'
  return `${failed.label}: ${failed.detail}`
}

function mutationBlockMessage(data = {}, fallback = 'request failed') {
  if (data.code === 'STALE_SERVICE_SOURCE') {
    return 'Pi Pulse service source is stale; restart Pi Pulse before switching runners.'
  }
  return firstPreflightIssue(data.preflight || data.setup || data) || data.error || fallback
}

function isStaleSourceBlock(message = '') {
  return String(message).toLowerCase().includes('service source is stale')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readApiJson(response, label = 'API request') {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const contentType = response.headers.get('content-type') || 'unknown content-type'
    const kind = text.trim().startsWith('<') ? 'returned HTML instead of JSON' : 'returned non-JSON'
    throw new Error(`${label} ${kind} (${response.status} ${contentType})`)
  }
}

async function fetchApiJson(url, options) {
  const response = await fetch(url, options)
  const data = await readApiJson(response, url)
  return { response, data }
}

async function waitForPulseHealthy(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  await sleep(650)
  while (Date.now() < deadline) {
    try {
      const { response: res, data } = await fetchApiJson('/api/health', { cache: 'no-store' })
      if (res.ok && data.ok) return data
    } catch {
      // The service is expected to drop briefly while the supervisor restarts it.
    }
    await sleep(450)
  }
  throw new Error('Pi Pulse restart did not come back in time')
}

function preflightFailureRows(preflight) {
  if (!preflight || preflight.ok) return []
  const failedChecks = (preflight.checks || []).filter(check => !check.ok)
  if (failedChecks.length > 0) {
    return failedChecks.map(check => {
      const label = check.label || check.id || 'check'
      const detail = check.detail || 'failed'
      return `${label}: ${detail}${check.path ? ` (${check.path})` : ''}`
    })
  }
  return [preflight.error || 'runner preflight failed']
}

function selectedHistoryRuns(runs = [], limit = 5) {
  const recent = runs.slice(-limit)
  const latestFailure = [...runs].reverse().find(run => run?.type === 'FAILED')
  if (!latestFailure || recent.includes(latestFailure)) return recent
  return [...recent, latestFailure]
}

function IncubatorSlot({ slot, onToggle, onRun, readinessIssue = null, readinessDetails = [] }) {
  const enabled = !!slot.schedule?.enabled
  const active = !!slot.running
  const due = fmtCountdown(slot.schedule?.nextRunAt)
  const runner = slot.runner || slot.schedule?.runner || 'script'
  const ringColor = '#a78bfa'
  const blockedAt = latestScheduleBlock(slot.schedule)
  const runnerBlocked = !!readinessIssue
  const lastRunFailed = slot.lastRunStatus === 'failed' || slot.status?.lastRunStatus === 'failed'
  const lastFailureDetail = slot.lastRunFailure || slot.status?.lastRunFailure || ''
  const failureVisible = runnerBlocked || lastRunFailed
  const statusColor = active ? ringColor : (runnerBlocked || blockedAt || lastRunFailed) ? '#f87171' : enabled ? '#22c55e' : 'rgba(71,85,105,0.45)'
  const level = Math.max(1, Math.floor((slot.runCount || 0) / 5) + 1)
  const xp = Math.min(100, ((slot.runCount || 0) % 5) * 20)
  const blockedDetail = readinessDetails[0] || readinessIssue || failureSignal(lastFailureDetail)

  return (
    <div
      data-card-run-blocked={runnerBlocked ? 'true' : 'false'}
      data-card-preflight-detail={readinessDetails.length ? 'true' : 'false'}
      style={{
      border: `1px solid ${active ? `${ringColor}55` : runnerBlocked ? 'rgba(248,113,113,0.24)' : 'rgba(255,255,255,0.08)'}`,
      background: active ? `color-mix(in srgb, ${ringColor} 7%, rgba(8,10,14,0.96))` : runnerBlocked ? 'rgba(248,113,113,0.045)' : 'rgba(8,10,14,0.72)',
      borderRadius: 8,
      padding: 12,
      display: 'grid',
      gridTemplateColumns: '42px 1fr auto',
      gap: 12,
      alignItems: 'center',
      minWidth: 0,
    }}>
      <motion.div
        animate={active ? { rotate: 360 } : { rotate: 0 }}
        transition={active ? { duration: 8, repeat: Infinity, ease: 'linear' } : { duration: 0.4 }}
        style={{
        width: 42,
        height: 42,
        borderRadius: '50%',
        background: `conic-gradient(${ringColor} ${active ? '220deg' : enabled ? '96deg' : '18deg'}, rgba(255,255,255,0.08) 0)`,
        display: 'grid',
        placeItems: 'center',
        boxShadow: active ? `0 0 16px ${ringColor}33` : 'none',
      }}>
        <div style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: '#0d1015',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'grid',
          placeItems: 'center',
          color: ringColor,
          fontSize: '0.58rem',
          fontFamily: 'monospace',
          fontWeight: 700,
        }}>
          {slot.label}
        </div>
      </motion.div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{
            fontSize: '0.58rem',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: ringColor,
            whiteSpace: 'nowrap',
          }}>
            {slot.type}
          </span>
          <span style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: statusColor,
            boxShadow: active ? `0 0 8px ${ringColor}` : 'none',
            flexShrink: 0,
          }} />
          <span style={{
            fontSize: '0.56rem',
            fontFamily: 'monospace',
            color: 'rgba(71,85,105,0.58)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {active ? 'incubating' : runnerBlocked ? 'runner blocked' : blockedAt ? 'schedule blocked' : lastRunFailed ? 'last failed' : enabled ? `every ${fmtInterval(slot.schedule?.intervalHours)}` : 'paused'}
          </span>
        </div>
        <div style={{
          marginTop: 5,
          fontSize: '0.84rem',
          fontWeight: 650,
          color: 'rgba(241,245,249,0.88)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {slot.name}
        </div>
        <div style={{
          marginTop: 4,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: '0.62rem',
          fontFamily: 'monospace',
          color: 'rgba(148,163,184,0.66)',
        }}>
          <span>{runner}</span>
          <span>{slot.charges ?? '∞'} charges</span>
          <span>{active ? fmtElapsed(slot.elapsed || 0) : runnerBlocked ? 'preflight failed' : blockedAt ? `blocked ${fmtScheduleTime(blockedAt)}` : lastRunFailed ? 'failure recorded' : enabled ? `next ${due}` : 'no timer'}</span>
        </div>
        {failureVisible && (
          <div data-card-last-run-failure={lastRunFailed ? slot.id : undefined} style={{ marginTop: 7, display: 'flex', gap: 6, alignItems: 'flex-start', borderLeft: '2px solid rgba(248,113,113,0.42)', paddingLeft: 7 }}>
            <span style={{ fontSize: '0.54rem', fontFamily: 'monospace', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>fail</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.6rem', fontFamily: 'monospace', color: 'rgba(254,202,202,0.76)' }}>
              {blockedDetail}
            </span>
          </div>
        )}
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{
            fontSize: '0.56rem',
            fontFamily: 'monospace',
            color: ringColor,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            whiteSpace: 'nowrap',
          }}>
            lvl {level}
          </span>
          <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
            <motion.div
              initial={false}
              animate={{ width: `${xp || (active ? 8 : 0)}%` }}
              transition={{ duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
              style={{ height: '100%', background: ringColor, boxShadow: active ? `0 0 10px ${ringColor}` : 'none' }}
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          onClick={onRun}
          disabled={active}
          title={runnerBlocked ? `Record blocked run: ${readinessIssue}` : `Run ${slot.name}`}
          data-card-run-button={slot.id}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${runnerBlocked ? 'rgba(248,113,113,0.28)' : `${ringColor}33`}`,
            background: runnerBlocked ? 'rgba(248,113,113,0.08)' : `${ringColor}14`,
            color: runnerBlocked ? '#f87171' : ringColor,
            cursor: active ? 'not-allowed' : 'pointer',
            display: 'grid',
            placeItems: 'center',
            opacity: active ? 0.45 : 1,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>
        <button
          onClick={onToggle}
          title={enabled ? 'Pause incubator' : 'Start incubator'}
          style={{
            minWidth: 46,
            height: 28,
            borderRadius: 6,
            border: `1px solid ${enabled ? 'rgba(34,197,94,0.28)' : 'rgba(255,255,255,0.08)'}`,
            background: enabled ? 'rgba(34,197,94,0.07)' : 'rgba(255,255,255,0.03)',
            color: enabled ? '#22c55e' : 'rgba(148,163,184,0.62)',
            cursor: 'pointer',
            fontSize: '0.58rem',
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {enabled ? 'pause' : 'start'}
        </button>
      </div>
    </div>
  )
}

function RunnerSwitch({ value, available = ['codex', 'claude'], onChange, disabled }) {
  const options = ['codex', 'claude']
  return (
    <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, overflow: 'hidden' }}>
      {options.map(option => {
        const active = value === option
        const supported = available.includes(option)
        return (
          <button
            key={option}
            onClick={() => supported && onChange?.(option)}
            disabled={disabled || !supported}
            title={supported ? `Use ${option}` : `${option} runner is not configured for this project`}
            style={{
              border: 'none',
              borderRight: option === 'codex' ? '1px solid rgba(255,255,255,0.08)' : 'none',
              background: active ? 'rgba(167,139,250,0.14)' : 'rgba(255,255,255,0.025)',
              color: active ? '#a78bfa' : supported ? 'rgba(148,163,184,0.68)' : 'rgba(71,85,105,0.35)',
              padding: '4px 8px',
              cursor: disabled || !supported ? 'not-allowed' : 'pointer',
              fontSize: '0.58rem',
              fontFamily: 'monospace',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

export function ProjectPanel() {
  const [selected, setSelected] = useState(null)
  const [incubators, setIncubators] = useState([])
  const [runsBySlot, setRunsBySlot] = useState({})
  const [historyErrorsBySlot, setHistoryErrorsBySlot] = useState({})
  const [projects, setProjects] = useState([])
  const [addOpen, setAddOpen] = useState(false)
  const [newIdea, setNewIdea] = useState('')
  const [createError, setCreateError] = useState(null)
  const [creatingIdea, setCreatingIdea] = useState(false)
  const [steerTextBySlot, setSteerTextBySlot] = useState({})
  const [steerStateBySlot, setSteerStateBySlot] = useState({})
  const [switching, setSwitching] = useState(false)
  const [aiTriggersBySlot, setAiTriggersBySlot] = useState({})
  const [preflightBySlot, setPreflightBySlot] = useState({})
  const [launchErrors, setLaunchErrors] = useState({})
  const [runnerNoticeBySlot, setRunnerNoticeBySlot] = useState({})
  const [runnerReceiptsBySlot, setRunnerReceiptsBySlot] = useState({})
  const [expandedFailureKeys, setExpandedFailureKeys] = useState({})
  const [serviceRestarting, setServiceRestarting] = useState(false)
  const runSignatureBySlotRef = useRef({})

  const noteLatestRun = (id, runs) => {
    const signature = latestCompletedRunSignature(runs)
    const prev = runSignatureBySlotRef.current[id]
    if (prev != null && signature !== prev) {
      setAiTriggersBySlot(current => ({ ...current, [id]: (current[id] || 0) + 1 }))
    }
    runSignatureBySlotRef.current[id] = signature
  }

  const fetchProjects = () => fetchApiJson('/api/projects/list').then(({ data: d }) => { if (d.ok) setProjects(d.projects) }).catch(() => {})

  const fetchIncubators = async () => {
    try {
      const { data: d } = await fetchApiJson('/api/incubators')
      if (d.ok) {
        setIncubators(d.slots)
        for (const slot of d.slots) {
          fetchSlotRuns(slot.id)
          fetchSlotPreflight(slot.id)
        }
      }
    } catch {}
  }

  const fetchSlotRuns = async (id) => {
    try {
      const { response: res, data: d } = await fetchApiJson(`/api/incubators/${id}/runs`)
      if (!res.ok || d.ok === false) {
        throw new Error(d.error || `history request failed with ${res.status}`)
      }
      setRunsBySlot(prev => ({ ...prev, [id]: d.runs }))
      setHistoryErrorsBySlot(prev => ({ ...prev, [id]: null }))
      noteLatestRun(id, d.runs)
    } catch (err) {
      setRunsBySlot(prev => ({ ...prev, [id]: [] }))
      setHistoryErrorsBySlot(prev => ({ ...prev, [id]: err.message || 'failed to load run history' }))
    }
  }

  const fetchSlotPreflight = async (id) => {
    try {
      const { data: d } = await fetchApiJson(`/api/incubators/${id}/preflight`)
      setPreflightBySlot(prev => ({ ...prev, [id]: d }))
      if (d.ok) setLaunchErrors(prev => ({ ...prev, [id]: null }))
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, [id]: err.message }))
    }
  }

  useEffect(() => {
    fetchProjects(); fetchIncubators()
    const incStream = new EventSource('/api/incubators/stream')
    incStream.onmessage = () => { fetchIncubators() }
    const poll = setInterval(() => {
      fetchProjects(); fetchIncubators()
    }, 30000)
    return () => { incStream.close(); clearInterval(poll) }
  }, [])

  const runProjectSlot = async (id) => {
    try {
      const { data: preflight } = await fetchApiJson(`/api/incubators/${id}/preflight`)
      setPreflightBySlot(prev => ({ ...prev, [id]: preflight }))
      if (!preflight.ok) {
        setLaunchErrors(prev => ({ ...prev, [id]: firstPreflightIssue(preflight) }))
      }
      if (preflight.ok) setLaunchErrors(prev => ({ ...prev, [id]: null }))
      const { response: res, data } = await fetchApiJson(`/api/incubators/${id}/run`, { method: 'POST' })
      if (!res.ok || data.ok === false) {
        await fetchSlotRuns(id)
        throw new Error(mutationBlockMessage(data, 'failed to launch incubator'))
      }
      await fetchIncubators()
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, [id]: err.message }))
    }
  }

  const updateProjectSchedule = async (slot, enabled) => {
    try {
      const { response: res, data: d } = await fetchApiJson(`/api/incubators/${slot.id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, intervalHours: slot.intervalHours || 0.5 }),
      })
      if (!res.ok || !d.ok) throw new Error(d.error || 'failed to update schedule')
      if (d.ok) await fetchIncubators()
      setLaunchErrors(prev => ({ ...prev, [slot.id]: null }))
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, [slot.id]: err.message }))
    }
  }

  const updateProjectRunner = async (slot, runner) => {
    const performSwitch = async (allowStaleRestart = true) => {
      const { response: res, data: d } = await fetchApiJson(`/api/incubators/${slot.id}/runner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner }),
      })
      if (!res.ok || !d.ok) {
        if (d.code === 'STALE_SERVICE_SOURCE' && allowStaleRestart) {
          setRunnerNoticeBySlot(prev => ({ ...prev, [slot.id]: `Pi Pulse source stale; restarting service, then retrying ${runner} relay switch.` }))
          await restartPulseService()
          return performSwitch(false)
        }
        const setup = d.setup || d.preflight || { ok: false, runner, error: d.error || 'failed to update runner', checks: [] }
        const message = mutationBlockMessage(d, 'failed to update runner')
        setPreflightBySlot(prev => ({ ...prev, [slot.id]: setup }))
        setRunnerNoticeBySlot(prev => ({ ...prev, [slot.id]: null }))
        setRunnerReceiptsBySlot(prev => ({
          ...prev,
          [slot.id]: {
            runner,
            ok: false,
            message,
            command: setup.command || null,
            checks: preflightFailureRows(setup),
            historyRecorded: false,
            ts: Date.now(),
          },
        }))
        throw new Error(message)
      }
      return d
    }

    try {
      const d = await performSwitch()
      setLaunchErrors(prev => ({ ...prev, [slot.id]: null }))
      setRunnerNoticeBySlot(prev => ({ ...prev, [slot.id]: d.warning || `${runner} relay selected` }))
      if (d.preflight || d.setup) setPreflightBySlot(prev => ({ ...prev, [slot.id]: d.preflight || d.setup }))
      setRunnerReceiptsBySlot(prev => ({
        ...prev,
        [slot.id]: {
          runner,
          ok: d.preflight?.ok !== false,
          message: d.warning || `${runner} relay selected`,
          command: d.preflight?.command || null,
          checks: preflightFailureRows(d.preflight || d.setup),
          historyRecorded: !!d.historyRecorded,
          ts: Date.now(),
        },
      }))
      if (d.slot) setIncubators(prev => prev.map(item => item.id === slot.id ? d.slot : item))
      await fetchIncubators()
      const { data: preflight } = await fetchApiJson(`/api/incubators/${slot.id}/preflight`)
      setPreflightBySlot(prev => ({ ...prev, [slot.id]: preflight }))
      await fetchSlotRuns(slot.id)
      const keepNotice = d.historyRecorded || String(d.warning || '').includes('blocked')
      if (!keepNotice) {
        setTimeout(() => {
          setRunnerNoticeBySlot(prev => prev[slot.id] ? ({ ...prev, [slot.id]: null }) : prev)
        }, 2600)
      }
    } catch (err) {
      setLaunchErrors(prev => ({ ...prev, [slot.id]: err.message }))
    }
  }

  const addIncubator = async (project) => {
    setSwitching(true)
    try {
      const { data: d } = await fetchApiJson('/api/incubators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, enabled: false, intervalHours: 0.5 }),
      })
      if (d.ok) {
        setSelected(project)
        setAddOpen(false)
        await fetchIncubators()
      }
    } catch {} finally {
      setSwitching(false)
    }
  }

  const createIncubatorFromIdea = async () => {
    const idea = newIdea.trim()
    if (idea.length < 8 || creatingIdea) return
    setCreatingIdea(true)
    setCreateError(null)
    try {
      const { response: res, data } = await fetchApiJson('/api/incubators/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea }),
      })
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed to create incubator')
      setNewIdea('')
      setSelected(data.slot?.id || data.slot?.project || null)
      setAddOpen(false)
      await fetchProjects()
      await fetchIncubators()
    } catch (err) {
      setCreateError(err.message)
    } finally {
      setCreatingIdea(false)
    }
  }
  const removeIncubator = async (id) => {
    if (id === 'rat-deposit') return
    try {
      await fetch(`/api/incubators/${id}`, { method: 'DELETE' })
      setSelected(null)
      await fetchIncubators()
    } catch {}
  }

  const sendProjectFeedback = async (id) => {
    const feedback = (steerTextBySlot[id] || '').trim()
    if (!feedback || steerStateBySlot[id] === 'saving') return
    setSteerStateBySlot(prev => ({ ...prev, [id]: 'saving' }))
    try {
      const endpoint = `/api/incubators/${id}/feedback`
      const { response: res, data } = await fetchApiJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed to save feedback')
      setSteerTextBySlot(prev => ({ ...prev, [id]: '' }))
      setSteerStateBySlot(prev => ({ ...prev, [id]: 'saved' }))
      setLaunchErrors(prev => ({ ...prev, [id]: null }))
      await fetchIncubators()
      setTimeout(() => {
        setSteerStateBySlot(prev => prev[id] === 'saved' ? ({ ...prev, [id]: null }) : prev)
      }, 1600)
    } catch (err) {
      setSteerStateBySlot(prev => ({ ...prev, [id]: 'error' }))
      console.warn('failed to save incubator feedback', err)
    }
  }

  const restartPulseService = async () => {
    if (serviceRestarting) return waitForPulseHealthy()
    setServiceRestarting(true)
    try {
      await fetch('/api/restart', { method: 'POST' })
    } catch {
      // The request can be cut short by the process exiting for restart.
    }
    try {
      await waitForPulseHealthy()
      return true
    } finally {
      setServiceRestarting(false)
    }
  }

  const projectSlots = incubators.map(slot => ({
    ...slot,
    tone: 'project',
    type: slot.project === 'race-whisperer-predict' ? 'Analysis Incubator' : 'Project Incubator',
    label: slot.project?.slice(0, 1)?.toUpperCase() || 'P',
    name: slot.project || slot.id,
    schedule: slot,
    status: slot,
    runs: runsBySlot[slot.id] || [],
    running: slot.running?.running,
    elapsed: slot.running?.elapsed || 0,
    onRun: () => runProjectSlot(slot.id),
    onToggle: () => updateProjectSchedule(slot, !slot.enabled),
    onRunnerChange: (runner) => updateProjectRunner(slot, runner),
    launching: false,
  }))

  const slots = [...projectSlots]
  // With the core slot retired, slots is empty until /api/incubators
  // responds. Keep hook order stable: never early-return before the
  // trailing hooks - derive against a placeholder and gate in the JSX.
  const slotsLoading = slots.length === 0
  const placeholderSlot = { id: '__loading__', runs: [], schedule: {}, status: {} }
  const activeSlot = slots.find(s => s.id === selected) || slots[0] || placeholderSlot
  const displayRuns = selectedHistoryRuns(activeSlot.runs || []).reverse()
  const defaultOpenFailureKey = newestFailedRunKey(displayRuns, activeSlot.id)
  const historyError = historyErrorsBySlot[activeSlot.id]
  const nextRunNum = (activeSlot.runCount ?? activeSlot.runs?.length ?? 0) + 1
  const color = '#a78bfa'
  const existingIds = new Set(incubators.map(s => s.id))
  const addableProjects = projects.filter(p => !existingIds.has(p.dir))
  const activePreflight = preflightBySlot[activeSlot.id]
  const runnerNotice = runnerNoticeBySlot[activeSlot.id]
  const runnerReceipt = runnerReceiptsBySlot[activeSlot.id]
  const readinessIssue = launchErrors[activeSlot.id] || firstPreflightIssue(activePreflight)
  const readinessDetails = preflightFailureRows(activePreflight)
  const latestDisplayedFailure = displayRuns.find(run => run?.type === 'FAILED') || null
  const latestDisplayedFailurePinned = latestDisplayedFailure && !(activeSlot.runs || []).slice(-5).includes(latestDisplayedFailure)
  const preflightRunnerLabel = activePreflight?.runner || activeSlot.runner || activeSlot.schedule?.runner || 'runner'
  const claudeSetup = activeSlot.runnerSetups?.claude
  const claudeSetupDetails = preflightFailureRows(claudeSetup)
  const showClaudeSetup = claudeSetup && !claudeSetup.ok
  const runnerBlocked = !!readinessIssue
  const selectedRunner = activeSlot.runner || activeSlot.schedule?.runner || 'script'
  const selectedRunnerLaunchOk = !activePreflight || activePreflight.ok !== false
  const runnerReceiptLabel = selectedRunner === 'claude'
    ? selectedRunnerLaunchOk ? 'Claude selected and launchable' : 'Claude selected, launch blocked'
    : selectedRunnerLaunchOk ? 'Codex selected and launchable' : 'Codex selected, launch blocked'
  const staleSourceBlocked = isStaleSourceBlock(readinessIssue)
  const activeScheduleBlockedAt = latestScheduleBlock(activeSlot.schedule)
  const activeLastRunFailed = activeSlot.lastRunStatus === 'failed' || activeSlot.status?.lastRunStatus === 'failed'
  const activeLastFailure = activeSlot.lastRunFailure || activeSlot.status?.lastRunFailure || ''
  const activeLastFailureSource = activeSlot.lastRunFailureSource || activeSlot.status?.lastRunFailureSource || 'last run'
  const activeStatusColor = activeSlot.running ? color : (activeScheduleBlockedAt || activeLastRunFailed) ? '#f87171' : '#22c55e'
  const runDisabled = activeSlot.launching || activeSlot.running
  const runButtonColor = runnerBlocked ? '#f87171' : color
  const runButtonLabel = runnerBlocked
    ? 'RUNNER BLOCKED'
    : activeSlot.launching ? 'STARTING...' : activeSlot.running ? 'INCUBATING' : 'RUN INCUBATOR'
  const runButtonDetail = runnerBlocked
    ? `click to record failure: ${readinessIssue.slice(0, 72)}`
    : activeSlot.running ? `${fmtElapsed(activeSlot.elapsed)} elapsed` : `run #${nextRunNum} · ${(activeSlot.lastRunType || activeSlot.status?.lastRunType || 'mutate').toLowerCase()} next`
  const activeRunnerRows = [
    `selected: ${selectedRunner}`,
    `launch: ${shortPath(activeSlot.launchScript || activeSlot.status?.runScript)}`,
    activePreflight?.command ? `command: ${shortCommand(activePreflight.command)}` : null,
    selectedRunner === 'claude' ? `relay: ${shortPath(activeSlot.claudeRelayScript || activeSlot.relayScript || claudeSetup?.expectedScript)}` : null,
    selectedRunner === 'claude' ? `model: ${activeSlot.claudeModel || claudeSetup?.model || 'Claude CLI default'}` : null,
  ].filter(Boolean)

  const renderSlotCard = (slot) => {
    const slotPreflight = preflightBySlot[slot.id]
    const slotReadinessIssue = launchErrors[slot.id] || firstPreflightIssue(slotPreflight)
    const slotReadinessDetails = preflightFailureRows(slotPreflight)
    return (
      <div
        key={slot.id}
        role="button"
        tabIndex={0}
        aria-pressed={selected === slot.id}
        aria-label={`Select incubator ${slot.name || slot.id}`}
        data-incubator-card={slot.id}
        data-incubator-selected={selected === slot.id ? 'true' : 'false'}
        onClick={() => setSelected(slot.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setSelected(slot.id)
          }
        }}
        style={{ cursor: 'pointer', borderRadius: 9, outline: selected === slot.id ? '1px solid #a78bfa66' : '1px solid transparent', outlineOffset: 2 }}
      >
        <IncubatorSlot
          slot={slot}
          onToggle={(e) => { e?.stopPropagation?.(); slot.onToggle() }}
          onRun={(e) => { e?.stopPropagation?.(); slot.onRun() }}
          readinessIssue={slotReadinessIssue}
          readinessDetails={slotReadinessDetails}
        />
      </div>
    )
  }

  useEffect(() => {
    if (activeSlot.id === '__loading__') return undefined
    let cancelled = false
    const runner = activeSlot.runner || activeSlot.schedule?.runner || 'codex'
    const url = `/api/incubators/${activeSlot.id}/preflight`
    fetchApiJson(url)
      .then(({ data: d }) => {
        if (!cancelled) setPreflightBySlot(prev => ({ ...prev, [activeSlot.id]: d }))
      })
      .catch(err => {
        if (!cancelled) setLaunchErrors(prev => ({ ...prev, [activeSlot.id]: err.message }))
      })
    return () => { cancelled = true }
  }, [activeSlot.id, activeSlot.runner, activeSlot.schedule?.runner])

  if (slotsLoading) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="panel" style={{ padding: 24, fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--muted)', letterSpacing: '0.1em' }}>
        loading incubators…
      </motion.div>
    )
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.3 }} className="panel" style={{ padding: 0, overflow: 'visible', position: 'relative' }}>
      {switching && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(8,8,8,0.85)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 'inherit' }}>
          <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #a78bfa', borderTopColor: 'transparent' }} />
          <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(167,139,250,0.8)', letterSpacing: '0.1em' }}>updating slots…</span>
        </div>
      )}

      <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.08))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>Incubator Deck</div>
            <div style={{ marginTop: 4, fontSize: '0.75rem', color: 'rgba(148,163,184,0.66)', lineHeight: 1.35 }}>Each chamber has its own project, runner, timer, and run history.</div>
          </div>
          <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.48)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {slots.filter(s => s.schedule?.enabled).length} active · {projectSlots.length} project slots
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
          {slots.map(renderSlotCard)}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setAddOpen(o => !o)} style={{ width: '100%', minHeight: 98, border: '1px dashed rgba(148,163,184,0.24)', borderRadius: 8, background: 'rgba(8,10,14,0.42)', color: 'rgba(148,163,184,0.62)', cursor: 'pointer', display: 'grid', placeItems: 'center', gap: 4 }}>
              <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>+</span>
              <span style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Add Incubator</span>
            </button>
            {addOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20, minWidth: 330, maxWidth: 380, background: '#111118', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
                <div style={{ padding: 8, display: 'grid', gap: 7, borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 6 }}>
                  <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(167,139,250,0.84)' }}>Create from idea</div>
                  <textarea
                    value={newIdea}
                    onChange={e => { setNewIdea(e.target.value); setCreateError(null) }}
                    rows={4}
                    placeholder="Write the project idea here..."
                    style={{ resize: 'vertical', minHeight: 78, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.28)', color: 'rgba(241,245,249,0.84)', padding: '8px 9px', fontSize: '0.72rem', lineHeight: 1.35, outline: 'none' }}
                  />
                  {createError && <div style={{ fontSize: '0.62rem', color: 'rgba(248,113,113,0.82)', fontFamily: 'monospace' }}>{createError}</div>}
                  <button
                    onClick={createIncubatorFromIdea}
                    disabled={creatingIdea || newIdea.trim().length < 8}
                    style={{ border: '1px solid rgba(167,139,250,0.32)', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', borderRadius: 6, padding: '7px 9px', cursor: (creatingIdea || newIdea.trim().length < 8) ? 'not-allowed' : 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: (creatingIdea || newIdea.trim().length < 8) ? 0.5 : 1 }}
                  >
                    {creatingIdea ? 'creating...' : 'create incubator'}
                  </button>
                </div>
                <div style={{ padding: '3px 8px 6px', fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(71,85,105,0.58)' }}>Existing projects</div>
                {addableProjects.length === 0 ? <div style={{ padding: 10, fontSize: '0.7rem', color: 'rgba(148,163,184,0.5)' }}>no available projects</div> : addableProjects.map(p => (
                  <button key={p.dir} onClick={() => addIncubator(p.dir)} style={{ width: '100%', border: 'none', background: 'transparent', padding: '8px 10px', textAlign: 'left', cursor: 'pointer', borderRadius: 6 }}>
                    <div style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(241,245,249,0.78)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{p.name}</div>
                    <div style={{ marginTop: 2, fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.55)' }}>{p.phase || 'project'} · run #{p.runCount ?? 0}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: '13px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 9, background: activeSlot.running ? `color-mix(in srgb, ${color} 4%, transparent)` : 'transparent' }}>
        <motion.div animate={activeSlot.running ? { opacity: [1, 0.3, 1] } : { opacity: 0.7 }} transition={{ duration: 1.4, repeat: activeSlot.running ? Infinity : 0, ease: 'easeInOut' }} style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: activeStatusColor, boxShadow: activeSlot.running ? `0 0 8px ${color}` : activeScheduleBlockedAt ? '0 0 8px rgba(248,113,113,0.45)' : 'none' }} />
        <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color }}>{activeSlot.type}</span>
        <span style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)' }}>·</span>
        <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'rgba(241,245,249,0.82)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{activeSlot.name}</span>
        {activeSlot.phase && <span style={{ fontSize: '0.54rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.42)', letterSpacing: '0.08em', textTransform: 'uppercase', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px' }}>{activeSlot.phase}</span>}
        {activeSlot.playUrl && <a href={activeSlot.playUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.56rem', fontFamily: 'monospace', color, textTransform: 'uppercase', letterSpacing: '0.08em', textDecoration: 'none' }}>open</a>}
        {activeSlot.id !== 'rat-deposit' && <button onClick={() => removeIncubator(activeSlot.id)} style={{ border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.05)', color: 'rgba(248,113,113,0.72)', borderRadius: 4, padding: '1px 6px', fontSize: '0.54rem', fontFamily: 'monospace', cursor: 'pointer' }}>remove</button>}
        <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontFamily: 'monospace', color: activeSlot.running ? color : 'rgba(71,85,105,0.48)' }}>{activeSlot.running ? `running · ${fmtElapsed(activeSlot.elapsed)}` : `run #${activeSlot.runCount ?? activeSlot.runs?.length ?? 0} · ${activeSlot.lastRun ?? activeSlot.status?.lastRun ?? '—'}`}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px minmax(260px, 310px)' }} className="max-md:!block">
        <div style={{ padding: '16px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--muted)' }}>Run History</div>
            <div style={{ fontSize: '0.58rem', fontFamily: 'monospace', color: 'rgba(71,85,105,0.45)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>project log</div>
          </div>
          {latestDisplayedFailure && (
            <div data-history-failure-receipt={activeSlot.id} style={{ marginBottom: 10, border: '1px solid rgba(248,113,113,0.16)', borderLeft: '3px solid rgba(248,113,113,0.72)', borderRadius: 7, background: 'rgba(248,113,113,0.045)', padding: '7px 9px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#f87171' }}>failure visible</div>
                <div style={{ marginTop: 3, fontSize: '0.62rem', fontFamily: 'monospace', color: 'rgba(254,202,202,0.76)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  run #{latestDisplayedFailure.num ?? '?'} is {latestDisplayedFailurePinned ? 'pinned with recent history' : 'inside recent history'}
                </div>
              </div>
              <div style={{ flexShrink: 0, fontSize: '0.54rem', fontFamily: 'monospace', color: 'rgba(248,113,113,0.58)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                expands below
              </div>
            </div>
          )}
          {historyError && (
            <div data-run-history-error={activeSlot.id} style={{ marginBottom: 10, border: '1px solid rgba(248,113,113,0.18)', borderLeft: '3px solid rgba(248,113,113,0.78)', borderRadius: 7, background: 'rgba(248,113,113,0.055)', padding: '8px 9px' }}>
              <div style={{ fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#f87171' }}>history unavailable</div>
              <div style={{ marginTop: 4, fontSize: '0.64rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.84)', wordBreak: 'break-word' }}>{historyError}</div>
            </div>
          )}
          <RunHistoryList
            displayRuns={displayRuns}
            slotId={activeSlot.id}
            expandedFailureKeys={expandedFailureKeys}
            setExpandedFailureKeys={setExpandedFailureKeys}
            defaultOpenFailureKey={defaultOpenFailureKey}
          />
        </div>
        <div className="max-md:hidden" style={{ background: 'var(--border)', margin: '12px 0' }} />
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {(activeSlot.current_focus || activeSlot.status?.current_focus) && <div><div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>Focus</div><div style={{ fontSize: '0.77rem', color: 'rgba(241,245,249,0.78)', lineHeight: 1.45 }}>{activeSlot.current_focus || activeSlot.status?.current_focus}</div></div>}
          {(activeSlot.next_run_goal || activeSlot.status?.next_run_goal) && <div><div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', marginBottom: 5 }}>Next</div><div style={{ fontSize: '0.72rem', color: 'rgba(71,85,105,0.75)', lineHeight: 1.4 }}>{((activeSlot.next_run_goal || activeSlot.status?.next_run_goal) || '').slice(0, 130)}</div></div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', minWidth: 44 }}>Runner</div>
            <RunnerSwitch
              value={activeSlot.runner || activeSlot.schedule?.runner || 'script'}
              available={activeSlot.availableRunners || ['codex', 'claude']}
              disabled={activeSlot.running}
              onChange={activeSlot.onRunnerChange}
            />
          </div>
          <div data-runner-relay-detail={activeSlot.id} style={{ display: 'grid', gap: 3, borderLeft: `2px solid ${selectedRunner === 'claude' ? 'rgba(167,139,250,0.38)' : 'rgba(34,211,238,0.24)'}`, paddingLeft: 8 }}>
            <div data-runner-switch-receipt={activeSlot.id} data-runner-launch-ok={selectedRunnerLaunchOk ? 'true' : 'false'} style={{ fontSize: '0.57rem', fontFamily: 'monospace', color: selectedRunnerLaunchOk ? 'rgba(134,239,172,0.76)' : 'rgba(254,202,202,0.82)', lineHeight: 1.32, wordBreak: 'break-word', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {runnerReceiptLabel}
            </div>
            {activeRunnerRows.map(row => (
              <div key={row} style={{ fontSize: '0.57rem', fontFamily: 'monospace', color: selectedRunner === 'claude' ? 'rgba(216,180,254,0.76)' : 'rgba(148,163,184,0.58)', lineHeight: 1.32, wordBreak: 'break-word' }}>
                {row}
              </div>
            ))}
          </div>
          {runnerNotice && (
            <div data-runner-switch-notice={activeSlot.id} style={{ borderLeft: `2px solid ${runnerNotice.includes('blocked') ? 'rgba(245,158,11,0.48)' : `${color}66`}`, paddingLeft: 8, fontSize: '0.62rem', fontFamily: 'monospace', lineHeight: 1.35, color: runnerNotice.includes('blocked') ? 'rgba(253,230,138,0.8)' : 'rgba(167,139,250,0.78)' }}>
              {runnerNotice}
            </div>
          )}
          {runnerReceipt && (
            <div data-runner-switch-receipt-detail={activeSlot.id} data-runner-switch-history-recorded={runnerReceipt.historyRecorded ? 'true' : 'false'} style={{ border: `1px solid ${runnerReceipt.ok ? 'rgba(34,197,94,0.16)' : 'rgba(248,113,113,0.18)'}`, background: runnerReceipt.ok ? 'rgba(34,197,94,0.035)' : 'rgba(248,113,113,0.045)', borderRadius: 6, padding: '7px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 5 }}>
                <div style={{ fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: runnerReceipt.ok ? 'rgba(134,239,172,0.78)' : 'rgba(248,113,113,0.78)' }}>Runner switch receipt</div>
                <div style={{ fontSize: '0.52rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', color: runnerReceipt.historyRecorded ? 'rgba(254,202,202,0.62)' : 'rgba(148,163,184,0.52)' }}>
                  {runnerReceipt.historyRecorded ? 'FAILED row written' : runnerReceipt.ok ? 'launchable' : 'blocked'}
                </div>
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <div style={{ fontSize: '0.6rem', fontFamily: 'monospace', lineHeight: 1.35, color: runnerReceipt.ok ? 'rgba(187,247,208,0.76)' : 'rgba(254,202,202,0.78)', wordBreak: 'break-word' }}>
                  selected: {runnerReceipt.runner} · {runnerReceipt.ok ? 'preflight ok' : 'preflight blocked'}
                </div>
                {runnerReceipt.command && (
                  <div style={{ borderLeft: '2px solid rgba(148,163,184,0.24)', paddingLeft: 7, fontSize: '0.57rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(148,163,184,0.68)', wordBreak: 'break-word' }}>
                    command: {shortCommand(runnerReceipt.command)}
                  </div>
                )}
                {runnerReceipt.message && !runnerReceipt.ok && (
                  <div style={{ borderLeft: '2px solid rgba(248,113,113,0.34)', paddingLeft: 7, fontSize: '0.58rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.72)', wordBreak: 'break-word' }}>
                    {runnerReceipt.message}
                  </div>
                )}
                {runnerReceipt.checks?.slice(0, 4).map(detail => (
                  <div key={detail} style={{ borderLeft: `2px solid ${runnerReceipt.ok ? 'rgba(34,197,94,0.22)' : 'rgba(248,113,113,0.34)'}`, paddingLeft: 7, fontSize: '0.57rem', fontFamily: 'monospace', lineHeight: 1.35, color: runnerReceipt.ok ? 'rgba(187,247,208,0.62)' : 'rgba(254,202,202,0.7)', wordBreak: 'break-word' }}>
                    {detail}
                  </div>
                ))}
              </div>
            </div>
          )}
          {activeLastRunFailed && (
            <div data-last-run-failure={activeSlot.id} style={{ border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.055)', borderRadius: 6, padding: '7px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                <div style={{ fontSize: '0.56rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(248,113,113,0.78)' }}>Last run failed</div>
                <div style={{ fontSize: '0.52rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(254,202,202,0.5)' }}>{activeLastFailureSource}</div>
              </div>
              <div style={{ fontSize: '0.66rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.82)', wordBreak: 'break-word' }}>
                {failureSignal(activeLastFailure)}
              </div>
            </div>
          )}
          {showClaudeSetup && (
            <div data-runner-setup="claude" data-runner-setup-ok="false" style={{ border: '1px solid rgba(248,113,113,0.16)', background: 'rgba(248,113,113,0.045)', borderRadius: 6, padding: '7px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: '0.55rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(248,113,113,0.78)' }}>Claude setup incomplete</div>
                <div style={{ fontSize: '0.52rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(254,202,202,0.5)' }}>relay switch preflight</div>
              </div>
              <div style={{ fontSize: '0.64rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.82)', wordBreak: 'break-word' }}>
                {claudeSetup.error || 'Claude runner setup failed'}
              </div>
              {claudeSetupDetails.length > 0 && (
                <div style={{ marginTop: 7, display: 'grid', gap: 4 }}>
                  {claudeSetupDetails.map(detail => (
                    <div key={detail} style={{ borderLeft: '2px solid rgba(248,113,113,0.34)', paddingLeft: 7, fontSize: '0.59rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.7)', wordBreak: 'break-word' }}>
                      {detail}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'grid', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)' }}>Steer</div>
                {steerStateBySlot[activeSlot.id] === 'saved' && <span style={{ fontSize: '0.55rem', fontFamily: 'monospace', color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>saved</span>}
                {steerStateBySlot[activeSlot.id] === 'error' && <span style={{ fontSize: '0.55rem', fontFamily: 'monospace', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.08em' }}>error</span>}
              </div>
              {activeSlot.latestUserFeedback && (
                <div style={{ borderLeft: '2px solid rgba(167,139,250,0.35)', paddingLeft: 8, fontSize: '0.66rem', color: 'rgba(148,163,184,0.68)', lineHeight: 1.35 }}>
                  latest: {activeSlot.latestUserFeedback.length > 120 ? activeSlot.latestUserFeedback.slice(0, 120) + '...' : activeSlot.latestUserFeedback}
                </div>
              )}
              <textarea
                value={steerTextBySlot[activeSlot.id] || ''}
                onChange={e => setSteerTextBySlot(prev => ({ ...prev, [activeSlot.id]: e.target.value }))}
                rows={4}
                placeholder="I like where this is heading, but I am missing..."
                style={{ resize: 'vertical', minHeight: 82, borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.22)', color: 'rgba(241,245,249,0.84)', padding: '8px 9px', fontSize: '0.72rem', lineHeight: 1.35, outline: 'none' }}
              />
              <button
                onClick={() => sendProjectFeedback(activeSlot.id)}
                disabled={steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()}
                style={{ border: '1px solid rgba(167,139,250,0.3)', background: 'rgba(167,139,250,0.09)', color: '#a78bfa', borderRadius: 6, padding: '7px 9px', cursor: (steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()) ? 'not-allowed' : 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: (steerStateBySlot[activeSlot.id] === 'saving' || !(steerTextBySlot[activeSlot.id] || '').trim()) ? 0.52 : 1 }}
              >
                {steerStateBySlot[activeSlot.id] === 'saving' ? 'saving...' : 'save feedback for next run'}
              </button>
            </div>
          {readinessIssue && (
            <div data-preflight-detail={readinessDetails.length ? 'true' : 'false'} style={{ border: '1px solid rgba(248,113,113,0.18)', background: 'rgba(248,113,113,0.055)', borderRadius: 6, padding: '7px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                <div style={{ fontSize: '0.56rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(248,113,113,0.78)' }}>Runner blocked</div>
                <div style={{ fontSize: '0.52rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(254,202,202,0.5)' }}>{preflightRunnerLabel} preflight</div>
              </div>
              <div style={{ fontSize: '0.68rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.86)' }}>{readinessIssue}</div>
              {readinessDetails.length > 0 && (
                <div style={{ marginTop: 7, display: 'grid', gap: 4 }}>
                  {readinessDetails.map(detail => (
                    <div key={detail} style={{ borderLeft: '2px solid rgba(248,113,113,0.36)', paddingLeft: 7, fontSize: '0.6rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.72)', wordBreak: 'break-word' }}>
                      {detail}
                    </div>
                  ))}
                </div>
              )}
              {staleSourceBlocked && (
                <button
                  type="button"
                  onClick={restartPulseService}
                  disabled={serviceRestarting}
                  data-restart-pulse-service="true"
                  style={{ marginTop: 8, border: '1px solid rgba(251,146,60,0.28)', background: 'rgba(251,146,60,0.08)', color: 'rgba(253,186,116,0.92)', borderRadius: 5, padding: '5px 8px', cursor: serviceRestarting ? 'not-allowed' : 'pointer', fontSize: '0.58rem', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em' }}
                >
                  {serviceRestarting ? 'restarting pi pulse...' : 'restart pi pulse service'}
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: '0.57rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--muted)', minWidth: 44 }}>Sched</div>
              <div style={{ flex: 1, fontSize: '0.72rem', fontFamily: 'monospace', color: activeScheduleBlockedAt ? '#f87171' : activeSlot.schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.35)' }}>
                {activeScheduleBlockedAt
                  ? `blocked ${fmtScheduleTime(activeScheduleBlockedAt)} · next ${fmtCountdown(activeSlot.schedule?.nextRunAt) || 'manual'}`
                  : activeSlot.schedule?.enabled ? `every ${fmtInterval(activeSlot.schedule.intervalHours)} · next ${fmtCountdown(activeSlot.schedule.nextRunAt)}` : 'off'}
              </div>
              <button onClick={activeSlot.onToggle} style={{ background: 'none', border: `1px solid ${activeSlot.schedule?.enabled ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: '0.6rem', fontFamily: 'monospace', letterSpacing: '0.06em', color: activeSlot.schedule?.enabled ? '#22c55e' : 'rgba(71,85,105,0.5)' }}>{activeSlot.schedule?.enabled ? 'pause' : 'start'}</button>
            </div>
            {activeScheduleBlockedAt && (
              <div style={{ marginLeft: 52, borderLeft: '2px solid rgba(248,113,113,0.35)', paddingLeft: 8, fontSize: '0.63rem', fontFamily: 'monospace', lineHeight: 1.35, color: 'rgba(254,202,202,0.78)' }}>
                latest scheduled run was blocked by preflight; history should contain a FAILED row with command detail
              </div>
            )}
          </div>
          <motion.button
            whileHover={runDisabled ? {} : { scale: 1.01 }}
            whileTap={runDisabled ? {} : { scale: 0.98 }}
            onClick={() => { if (!runDisabled) activeSlot.onRun?.() }}
            disabled={runDisabled}
            data-run-blocked={runnerBlocked ? 'true' : 'false'}
            style={{
              marginTop: 'auto',
              width: '100%',
              padding: '10px 14px',
              borderRadius: 9,
              border: `1px solid ${runButtonColor}45`,
              background: runnerBlocked ? 'rgba(248,113,113,0.07)' : `${color}14`,
              cursor: runDisabled ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              opacity: activeSlot.launching || activeSlot.running ? 0.72 : 1,
            }}
          >
            <div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, background: `${runButtonColor}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: runButtonColor }}>
              {activeSlot.launching || activeSlot.running ? (
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" /></svg>
                </motion.div>
              ) : runnerBlocked ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              )}
            </div>
            <div style={{ textAlign: 'left', minWidth: 0 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: runButtonColor, letterSpacing: '0.04em' }}>{runButtonLabel}</div>
              <div style={{ fontSize: '0.65rem', color: runnerBlocked ? 'rgba(254,202,202,0.72)' : 'rgba(71,85,105,0.65)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runButtonDetail}</div>
            </div>
          </motion.button>
        </div>
      </div>
      <div data-active-ai-slot={activeSlot.id} style={{ background: 'rgba(0,0,0,0.15)' }}><AiStrip slotId={activeSlot.id} autoTrigger={aiTriggersBySlot[activeSlot.id] || 0} /></div>
    </motion.div>
  )
}
