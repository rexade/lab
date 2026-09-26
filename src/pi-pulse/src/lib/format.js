export function timeValue(ts) {
  if (!ts) return 0
  const value = typeof ts === 'number' ? ts : Date.parse(ts)
  return Number.isFinite(value) ? value : 0
}

export function fmtClock(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds || 0))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

export function fmtInterval(hours) {
  if (!hours) return 'manual'
  const mins = Math.round(hours * 60)
  if (mins < 60) return `${mins}m`
  return Number.isInteger(hours) ? `${hours}h` : `${(mins / 60).toFixed(1)}h`
}

export function fmtRelativeDay(date, today = new Date().toISOString().slice(0, 10)) {
  if (!date) return 'never'
  if (date === today) return 'today'
  const diff = Math.round((Date.parse(today) - Date.parse(date)) / 86400000)
  if (diff === 1) return 'yesterday'
  if (diff > 1 && diff < 7) return `${diff} days ago`
  return date
}

export function fmtBytesPerSec(b) {
  if (b == null) return '—'
  if (b < 1024) return `${b} B/s`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 102400 ? 1 : 0)} KB/s`
  return `${(b / 1024 / 1024).toFixed(1)} MB/s`
}

export function shortPath(value = '') {
  const parts = String(value || '').split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(-2).join('/') : (parts[0] || 'missing')
}

export function clip(text = '', max = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
