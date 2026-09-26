import { useEffect, useState } from 'react'

const HISTORY = 80

// Live host telemetry over SSE. When the stream drops (restart, network), the
// last real sample stays on screen marked offline; nothing is ever simulated.
export function useSystemStats() {
  const [stats, setStats] = useState(null)
  const [history, setHistory] = useState([])
  const [tempHistory, setTempHistory] = useState([])
  const [netRxHistory, setNetRxHistory] = useState([])
  const [netTxHistory, setNetTxHistory] = useState([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource('/api/stats/stream')
    es.onopen = () => setConnected(true)
    es.onmessage = event => {
      let data
      try { data = JSON.parse(event.data) } catch { return }
      setStats(data)
      setConnected(true)
      setHistory(h => [...h, data.cpu].slice(-HISTORY))
      if (data.temperature != null) setTempHistory(h => [...h, data.temperature].slice(-HISTORY))
      if (data.net != null) {
        setNetRxHistory(h => [...h, data.net.rx].slice(-HISTORY))
        setNetTxHistory(h => [...h, data.net.tx].slice(-HISTORY))
      }
    }
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { stats, history, tempHistory, netRxHistory, netTxHistory, connected }
}
