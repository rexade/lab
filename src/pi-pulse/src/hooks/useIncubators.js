import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchApiJson, mutationBlockMessage, postJson, waitForPulseHealthy } from '../lib/api.js'

// All incubator state and actions. Reads refresh on the server's SSE ping and a
// 30s safety poll; every mutation either refreshes or throws a human sentence.
export function useIncubators() {
  const [slots, setSlots] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [runsBySlot, setRunsBySlot] = useState({})
  const [historyErrors, setHistoryErrors] = useState({})
  const [preflightBySlot, setPreflightBySlot] = useState({})
  const refreshTimer = useRef(null)

  const refreshSlotDetails = useCallback(async id => {
    const [runs, preflight] = await Promise.allSettled([
      fetchApiJson(`/api/incubators/${id}/runs`),
      fetchApiJson(`/api/incubators/${id}/preflight`),
    ])
    if (runs.status === 'fulfilled' && runs.value.response.ok && runs.value.data.ok !== false) {
      setRunsBySlot(prev => ({ ...prev, [id]: runs.value.data.runs || [] }))
      setHistoryErrors(prev => ({ ...prev, [id]: null }))
    } else {
      const message = runs.status === 'rejected'
        ? runs.reason?.message
        : runs.value.data?.error || `history request failed (${runs.value.response.status})`
      setRunsBySlot(prev => ({ ...prev, [id]: [] }))
      setHistoryErrors(prev => ({ ...prev, [id]: message || 'run history unavailable' }))
    }
    setPreflightBySlot(prev => ({
      ...prev,
      [id]: preflight.status === 'fulfilled'
        ? preflight.value.data
        : { ok: false, error: preflight.reason?.message || 'preflight unavailable', checks: [] },
    }))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { data } = await fetchApiJson('/api/incubators')
      if (!data.ok) throw new Error(data.error || 'incubators unavailable')
      setSlots(data.slots || [])
      setLoadError(null)
      setLoaded(true)
      await Promise.all((data.slots || []).map(slot => refreshSlotDetails(slot.id)))
    } catch (err) {
      setLoadError(err.message)
      setLoaded(true)
    }
  }, [refreshSlotDetails])

  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(refresh, 250)
  }, [refresh])

  useEffect(() => {
    refresh()
    const stream = new EventSource('/api/incubators/stream')
    stream.onmessage = scheduleRefresh
    const poll = setInterval(refresh, 30000)
    return () => {
      stream.close()
      clearInterval(poll)
      clearTimeout(refreshTimer.current)
    }
  }, [refresh, scheduleRefresh])

  const restartService = useCallback(async () => {
    try {
      await fetch('/api/restart', { method: 'POST' })
    } catch {
      // The process exits to restart; a cut-off response is expected.
    }
    const health = await waitForPulseHealthy()
    await refresh()
    return health
  }, [refresh])

  const mutate = useCallback(async (url, body, fallback) => {
    const { response, data } = await postJson(url, body)
    if (!response.ok || data.ok === false) {
      const err = new Error(mutationBlockMessage(data, fallback))
      err.code = data.code
      err.data = data
      throw err
    }
    return data
  }, [])

  const run = useCallback(async id => {
    try {
      return await mutate(`/api/incubators/${id}/run`, {}, 'could not start the run')
    } finally {
      // A blocked launch writes a FAILED row server-side; show it either way.
      await refresh()
    }
  }, [mutate, refresh])

  const setSchedule = useCallback(async (slot, patch) => {
    const data = await mutate(`/api/incubators/${slot.id}/schedule`, {
      enabled: patch.enabled ?? !!slot.enabled,
      intervalHours: patch.intervalHours ?? slot.intervalHours ?? 0.5,
    }, 'could not update autopilot')
    await refresh()
    return data
  }, [mutate, refresh])

  const setRunner = useCallback(async (slot, runner) => {
    const attempt = () => mutate(`/api/incubators/${slot.id}/runner`, { runner }, 'could not switch runner')
    let data
    try {
      data = await attempt()
    } catch (err) {
      if (err.code !== 'STALE_SERVICE_SOURCE') throw err
      // New source is on disk but not loaded: restart once, then retry once.
      await restartService()
      data = await attempt()
    }
    await refresh()
    return data
  }, [mutate, refresh, restartService])

  const sendFeedback = useCallback(async (id, feedback) => {
    const data = await mutate(`/api/incubators/${id}/feedback`, { feedback }, 'could not save steering')
    await refresh()
    return data
  }, [mutate, refresh])

  const create = useCallback(async (idea, title) => {
    const data = await mutate('/api/incubators/create', { idea, title }, 'could not create the incubator')
    await refresh()
    return data.slot
  }, [mutate, refresh])

  const remove = useCallback(async id => {
    const { response, data } = await fetchApiJson(`/api/incubators/${id}`, { method: 'DELETE' })
    if (!response.ok || !data.ok) throw new Error(mutationBlockMessage(data, 'could not remove the incubator'))
    await refresh()
    return data
  }, [refresh])

  return {
    slots,
    loaded,
    loadError,
    runsBySlot,
    historyErrors,
    preflightBySlot,
    refresh,
    actions: { run, setSchedule, setRunner, sendFeedback, create, remove, restartService },
  }
}
