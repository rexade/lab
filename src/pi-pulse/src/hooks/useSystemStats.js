import { useState, useEffect, useCallback, useRef } from 'react'

// Simulated data for when the API isn't available (demo mode)
function generateDemoStats(prev) {
  const now = Date.now()
  const cpu = Math.max(2, Math.min(95,
    (prev?.cpu ?? 25) + (Math.random() - 0.45) * 12
  ))
  const memPercent = Math.max(20, Math.min(90,
    (prev?.memory?.percent ?? 55) + (Math.random() - 0.5) * 3
  ))
  const totalMB = 4096
  const usedMB = Math.round(totalMB * memPercent / 100)
  return {
    cpu: Math.round(cpu),
    memory: {
      percent: Math.round(memPercent),
      totalMB,
      usedMB,
      freeMB: totalMB - usedMB,
      total: totalMB * 1024 * 1024,
      used: usedMB * 1024 * 1024,
    },
    temperature: 42 + Math.random() * 8,
    uptime: (prev?.uptime ?? 86400) + 2,
    uptimeFormatted: '1d 2h',
    hostname: 'raspberrypi',
    platform: 'linux',
    arch: 'arm64',
    loadAvg: [
      Math.max(0, (prev?.loadAvg?.[0] ?? 0.4) + (Math.random() - 0.5) * 0.1),
      0.38,
      0.35,
    ],
    disk: { percent: 42, usedGB: '12.5', totalGB: '29.7' },
    net: {
      rx: Math.max(0, (prev?.net?.rx ?? 8000) + (Math.random() - 0.45) * 4000),
      tx: Math.max(0, (prev?.net?.tx ?? 1500) + (Math.random() - 0.45) * 1000),
      iface: 'wlan0',
    },
    timestamp: now,
    demo: true,
  }
}

export function useSystemStats() {
  const [stats, setStats] = useState(null)
  const [history, setHistory] = useState([])
  const [tempHistory, setTempHistory] = useState([])
  const [netRxHistory, setNetRxHistory] = useState([])
  const [netTxHistory, setNetTxHistory] = useState([])
  const [isDemo, setIsDemo] = useState(false)
  const [connected, setConnected] = useState(true)
  const prevRef = useRef(null)
  const demoIntervalRef = useRef(null)

  useEffect(() => {
    const es = new EventSource('/api/stats/stream')

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        prevRef.current = data
        setStats(data)
        setIsDemo(false)
        setConnected(true)
        if (demoIntervalRef.current) {
          clearInterval(demoIntervalRef.current)
          demoIntervalRef.current = null
        }
        setHistory(h => [...h, data.cpu].slice(-80))
        if (data.temperature != null) {
          setTempHistory(h => [...h, data.temperature].slice(-80))
        }
        if (data.net != null) {
          setNetRxHistory(h => [...h, data.net.rx].slice(-80))
          setNetTxHistory(h => [...h, data.net.tx].slice(-80))
        }
      } catch { /* malformed event — ignore */ }
    }

    es.onerror = () => {
      setConnected(false)
      setIsDemo(true)
      if (!demoIntervalRef.current) {
        demoIntervalRef.current = setInterval(() => {
          setStats(prev => {
            const demo = generateDemoStats(prev ?? prevRef.current)
            prevRef.current = demo
            setHistory(h => [...h, demo.cpu].slice(-80))
            setTempHistory(h => [...h, demo.temperature].slice(-80))
            setNetRxHistory(h => [...h, demo.net.rx].slice(-80))
            setNetTxHistory(h => [...h, demo.net.tx].slice(-80))
            return demo
          })
        }, 2000)
      }
    }

    return () => {
      es.close()
      if (demoIntervalRef.current) {
        clearInterval(demoIntervalRef.current)
        demoIntervalRef.current = null
      }
    }
  }, [])

  return { stats, history, tempHistory, netRxHistory, netTxHistory, isDemo, connected }
}

export function useRuns(pollInterval = 30_000) {
  const [runs, setRuns] = useState([])
  const loadRef = useRef(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/runs')
        .then(r => r.json())
        .then(setRuns)
        .catch(() => {})

    loadRef.current = load
    load()

    // SSE for instant updates when a run completes — EventSource auto-reconnects
    const es = new EventSource('/api/runs/stream')
    es.onmessage = () => load()

    // Polling as safety net in case SSE drops silently
    const id = setInterval(load, pollInterval)

    return () => {
      es.close()
      clearInterval(id)
    }
  }, [pollInterval])

  const refresh = useCallback(() => { loadRef.current?.() }, [])

  return [runs, refresh]
}
