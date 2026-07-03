// ghost — what pi-pulse never shows
// The invisible machine: entropy pool, TCP sockets, kernel threads,
// context switches, interrupts, page faults.
// Samples every 2s. Fires events on threshold crossings.
// Serves dark terminal viewer on port 3032.

import { readFileSync } from 'fs'
import { createServer } from 'http'

const PORT       = 3032
const TICK_MS    = 2000
const HIST_LEN   = 48   // 96 seconds of samples
const MAX_EVENTS = 40

// ── Samplers ──────────────────────────────────────────────────────────────────

function entropy() {
  try { return parseInt(readFileSync('/proc/sys/kernel/random/entropy_avail', 'utf8').trim(), 10) }
  catch { return null }
}

function tcpSockets() {
  try {
    const m = readFileSync('/proc/net/sockstat', 'utf8').match(/TCP:\s+inuse\s+(\d+)/)
    return m ? parseInt(m[1], 10) : null
  } catch { return null }
}

function loadInfo() {
  try {
    const parts = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)
    const [running, total] = parts[3].split('/').map(Number)
    return {
      running: isNaN(running) ? null : running,
      total:   isNaN(total)   ? null : total,
    }
  } catch { return { running: null, total: null } }
}

let prevCtxt = null
let prevIntr  = null
let prevPgf   = null

function deltaStats() {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const ctxt = parseInt(stat.match(/^ctxt\s+(\d+)/m)?.[1] ?? 'x', 10)
    const intr = parseInt(stat.match(/^intr\s+(\d+)/m)?.[1] ?? 'x', 10)
    const vm   = readFileSync('/proc/vmstat', 'utf8')
    const pgf  = parseInt(vm.match(/^pgfault\s+(\d+)/m)?.[1] ?? 'x', 10)

    const dCtxt = isNaN(ctxt) || prevCtxt === null ? null : ctxt - prevCtxt
    const dIntr = isNaN(intr) || prevIntr === null ? null : intr - prevIntr
    const dPgf  = isNaN(pgf)  || prevPgf  === null ? null : pgf  - prevPgf

    if (!isNaN(ctxt)) prevCtxt = ctxt
    if (!isNaN(intr)) prevIntr = intr
    if (!isNaN(pgf))  prevPgf  = pgf

    return { ctxt: dCtxt, intr: dIntr, pgf: dPgf }
  } catch { return { ctxt: null, intr: null, pgf: null } }
}

// ── History ───────────────────────────────────────────────────────────────────

const hist = {
  entropy: [],
  tcp:     [],
  threads: [],
  procs:   [],
  ctxt:    [],
  intr:    [],
  pgf:     [],
}

const events = []

function push(key, val) {
  if (val === null || val === undefined || isNaN(val)) return
  hist[key].push(val)
  if (hist[key].length > HIST_LEN) hist[key].shift()
}

function emit(msg) {
  events.unshift({ ts: Date.now(), msg })
  if (events.length > MAX_EVENTS) events.pop()
}

function rollingAvg(arr, n = 8) {
  if (!arr.length) return 0
  const sl = arr.slice(-Math.min(n, arr.length))
  return sl.reduce((a, b) => a + b, 0) / sl.length
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

function detect(e, t, lo, d, prev) {
  // Entropy events
  if (e !== null && prev.entropy !== null) {
    if (e < 512 && prev.entropy >= 512)
      emit(`entropy below 512 bits (now ${e})`)
    else if (prev.entropy > 300 && e < prev.entropy * 0.5)
      emit(`entropy drain: ${prev.entropy} → ${e}`)
    else if (prev.entropy < 500 && e > 2000)
      emit(`entropy refilled: ${e} bits`)
  }

  // TCP socket events
  if (t !== null && prev.tcp !== null) {
    const delta = t - prev.tcp
    if (Math.abs(delta) >= 6)
      emit(`tcp ${delta > 0 ? '+' : ''}${delta} sockets (${t} open)`)
  }

  // Thread count events
  if (lo.total !== null && prev.threads !== null) {
    const delta = lo.total - prev.threads
    if (Math.abs(delta) >= 25)
      emit(`threads ${delta > 0 ? '+' : ''}${delta} (now ${lo.total})`)
  }

  // Context switch spike (needs 5+ samples for baseline)
  if (d.ctxt !== null && hist.ctxt.length >= 5) {
    const avg = rollingAvg(hist.ctxt)
    if (avg > 0 && d.ctxt > avg * 3.5 && d.ctxt > 6000)
      emit(`ctx spike ${d.ctxt.toLocaleString()}/2s (avg ${Math.round(avg).toLocaleString()})`)
  }

  // Page fault spike
  if (d.pgf !== null && hist.pgf.length >= 5) {
    const avg = rollingAvg(hist.pgf)
    if (avg > 0 && d.pgf > avg * 5 && d.pgf > 1500)
      emit(`pgfault spike ${d.pgf.toLocaleString()}/2s`)
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

function tick() {
  const prev = {
    entropy: hist.entropy.at(-1) ?? null,
    tcp:     hist.tcp.at(-1)     ?? null,
    threads: hist.threads.at(-1) ?? null,
  }

  const e  = entropy()
  const t  = tcpSockets()
  const lo = loadInfo()
  const d  = deltaStats()

  push('entropy', e)
  push('tcp',     t)
  push('threads', lo.total)
  push('procs',   lo.running)
  push('ctxt',    d.ctxt)
  push('intr',    d.intr)
  push('pgf',     d.pgf)

  detect(e, t, lo, d, prev)
}

// ── API ───────────────────────────────────────────────────────────────────────

function apiData() {
  const latest = {}
  for (const k of Object.keys(hist)) latest[k] = hist[k].at(-1) ?? null
  return { ts: Date.now(), latest, hist, events }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ghost</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#b0b0b0;
  --dim:#303030;
  --vdim:#141414;
  --green:#2d6a2d;
  --green-hi:#4aaa4a;
  --warn:#c04040;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
}
html,body{
  height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased;
}
body{padding:32px 28px;max-width:680px;margin:0 auto}

#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:40px}
.title{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--vdim)}
#ts{font-size:10px;color:var(--vdim);letter-spacing:.04em}

.section{font-size:9px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);padding-bottom:7px;border-bottom:1px solid #111;margin-bottom:0}

.reading{
  display:grid;grid-template-columns:108px 1fr 100px;
  align-items:center;gap:10px;
  padding:7px 0;border-bottom:1px solid #0e0e0e}
.reading:last-child{border-bottom:none}
.r-name{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.r-spark{font-size:11px;color:var(--green);letter-spacing:0;white-space:nowrap;overflow:hidden}
.r-val{font-size:11px;color:var(--fg);text-align:right;white-space:nowrap}
.r-unit{font-size:8px;color:var(--dim);margin-left:2px}

#events-wrap{margin-top:32px}
#log{margin-top:0}
.ev{
  display:grid;grid-template-columns:64px 1fr;gap:12px;
  padding:6px 0;border-bottom:1px solid #0e0e0e}
.ev:last-child{border-bottom:none}
.ev-ts{font-size:9px;color:var(--dim);white-space:nowrap;letter-spacing:.04em;padding-top:1px}
.ev-msg{font-size:10px;color:var(--fg);letter-spacing:.02em}
.ev-msg.warn{color:var(--warn)}
.ev.fresh .ev-msg{animation:flash .6s ease-out}
@keyframes flash{from{color:var(--green-hi)}to{color:var(--fg)}}
.empty{font-size:10px;color:var(--vdim);padding:14px 0;letter-spacing:.06em}

#ft{margin-top:28px;display:flex;justify-content:space-between;
  font-size:9px;color:var(--vdim);letter-spacing:.06em}
</style>
</head>
<body>
<div id="hd">
  <div class="title">ghost</div>
  <div id="ts">—</div>
</div>

<div class="section">readings</div>
<div id="readings"></div>

<div id="events-wrap">
  <div class="section" style="margin-top:32px">events</div>
  <div id="log"><div class="empty">watching…</div></div>
</div>

<div id="ft">
  <div>2s · 48 samples · threshold detection</div>
  <div id="host"></div>
</div>

<script>
var METRICS = [
  {key:'entropy', label:'entropy',     unit:'bits'},
  {key:'tcp',     label:'tcp sockets', unit:'open'},
  {key:'threads', label:'threads',     unit:'total'},
  {key:'procs',   label:'running',     unit:'procs'},
  {key:'ctxt',    label:'ctx switch',  unit:'/2s'},
  {key:'intr',    label:'interrupts',  unit:'/2s'},
  {key:'pgf',     label:'page faults', unit:'/2s'},
]

var B = '▁▂▃▄▅▆▇█'
function spark(arr, len) {
  len = len || 32
  if (!arr || !arr.length) return '·'.repeat(len)
  var sl = arr.slice(-len)
  var mn = Math.min.apply(null, sl)
  var mx = Math.max.apply(null, sl)
  var r  = mx - mn || 1
  var s  = ''
  for (var i = 0; i < sl.length; i++)
    s += B[Math.min(7, Math.max(0, Math.floor(((sl[i]-mn)/r)*7)))]
  while (s.length < len) s = '·' + s
  return s
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—'
  if (v > 9999) return v.toLocaleString()
  return String(v)
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false})
}

var container = document.getElementById('readings')
var logEl = document.getElementById('log')
var lastEvTs = 0
var emptyShown = true

METRICS.forEach(function(m) {
  var d = document.createElement('div')
  d.className = 'reading'
  d.innerHTML =
    '<div class="r-name">' + m.label + '</div>' +
    '<div class="r-spark" id="sp-' + m.key + '">' + ('·'.repeat(32)) + '</div>' +
    '<div class="r-val" id="v-' + m.key + '">—<span class="r-unit">' + m.unit + '</span></div>'
  container.appendChild(d)
})

function update(data) {
  document.getElementById('ts').textContent = fmtTime(data.ts)

  METRICS.forEach(function(m) {
    document.getElementById('sp-' + m.key).textContent = spark(data.hist[m.key], 32)
    var v  = data.latest[m.key]
    var el = document.getElementById('v-' + m.key)
    el.innerHTML = fmtVal(v) + '<span class="r-unit">' + m.unit + '</span>'
  })

  var evs = data.events || []
  if (evs.length && (emptyShown || evs[0].ts !== lastEvTs)) {
    emptyShown = false
    lastEvTs = evs[0].ts
    logEl.innerHTML = ''
    var isFirst = true
    evs.slice(0, 20).forEach(function(ev) {
      var d = document.createElement('div')
      d.className = 'ev' + (isFirst ? ' fresh' : '')
      isFirst = false
      var warn = /drain|spike|below|fault/.test(ev.msg)
      d.innerHTML =
        '<div class="ev-ts">' + fmtTime(ev.ts) + '</div>' +
        '<div class="ev-msg' + (warn ? ' warn' : '') + '">' + ev.msg + '</div>'
      logEl.appendChild(d)
    })
  }
}

document.getElementById('host').textContent = location.hostname

function poll() {
  fetch('/api').then(function(r){return r.json()}).then(update).catch(function(){})
}
poll()
setInterval(poll, 2000)
</script>
</body>
</html>`

// ── HTTP server ───────────────────────────────────────────────────────────────

createServer((req, res) => {
  if (req.url.split('?')[0] === '/api') {
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    })
    res.end(JSON.stringify(apiData()))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
  }
}).listen(PORT, () => {
  console.log(`[ghost] http://localhost:${PORT}`)
  console.log('[ghost] sampling: entropy · tcp · threads · ctx · intr · pgf — every 2s')
})

tick()
setInterval(tick, TICK_MS)
