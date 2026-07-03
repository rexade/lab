// oracle.js — episodic memory for the invisible machine
//
// Ghost fires threshold events. Whisper scores individual moments.
// Oracle groups moments into sessions: coherent episodes of machine activity.
//
// A session is a contiguous period where the machine's dominant character
// stays stable (3-tick hysteresis before switching).
//
// Oracle answers: what has this machine been DOING for the last 2 hours?
//   inference · 14:23–14:31 · peak 4.7 · entropy 1802→312
//   idle      · 14:31–15:04 · 33m
//   net-burst · 15:04–15:05 · 72s · peak 3.1
//
// Renders sessions as a 2-hour colored timeline bar.
// Port 3034. Zero dependencies.

import { readFileSync, appendFileSync } from 'fs'
import { createServer } from 'http'
import { hostname as osHostname } from 'os'

const PORT        = 3034
const TICK_MS     = 2000
const WINDOW_MS   = 2 * 60 * 60 * 1000  // 2-hour session window
const MAX_SESSIONS = 200
const HYSTERESIS  = 3   // ticks of a new class before committing to it
const LOG_FILE    = new URL('./oracle.jsonl', import.meta.url).pathname

// ── Samplers (self-contained — oracle runs without ghost/whisper) ─────────────

function sampleEntropy() {
  try { return parseInt(readFileSync('/proc/sys/kernel/random/entropy_avail', 'utf8').trim(), 10) }
  catch { return null }
}

function sampleTcp() {
  try {
    const m = readFileSync('/proc/net/sockstat', 'utf8').match(/TCP:\s+inuse\s+(\d+)/)
    return m ? parseInt(m[1], 10) : null
  } catch { return null }
}

function sampleLoad() {
  try {
    const parts = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)
    const [running, total] = parts[3].split('/').map(Number)
    return { running: isNaN(running) ? null : running, total: isNaN(total) ? null : total }
  } catch { return { running: null, total: null } }
}

let _prevCtxt = null, _prevIntr = null, _prevPgf = null

function sampleDeltas() {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const ctxt = parseInt(stat.match(/^ctxt\s+(\d+)/m)?.[1] ?? 'x', 10)
    const intr = parseInt(stat.match(/^intr\s+(\d+)/m)?.[1] ?? 'x', 10)
    const vm   = readFileSync('/proc/vmstat', 'utf8')
    const pgf  = parseInt(vm.match(/^pgfault\s+(\d+)/m)?.[1] ?? 'x', 10)
    const dCtxt = isNaN(ctxt) || _prevCtxt === null ? null : ctxt - _prevCtxt
    const dIntr = isNaN(intr) || _prevIntr === null ? null : intr - _prevIntr
    const dPgf  = isNaN(pgf)  || _prevPgf  === null ? null : pgf  - _prevPgf
    if (!isNaN(ctxt)) _prevCtxt = ctxt
    if (!isNaN(intr)) _prevIntr = intr
    if (!isNaN(pgf))  _prevPgf  = pgf
    return { ctxt: dCtxt, intr: dIntr, pgf: dPgf }
  } catch { return { ctxt: null, intr: null, pgf: null } }
}

// ── Rolling baseline / z-scores ───────────────────────────────────────────────

const KEYS = ['entropy', 'tcp', 'threads', 'ctxt', 'intr', 'pgf']
const WIN  = 30
const wins = {}
for (const k of KEYS) wins[k] = []

function pushWin(key, val) {
  if (val === null || val === undefined || isNaN(val)) return
  wins[key].push(val)
  if (wins[key].length > WIN) wins[key].shift()
}

function zScore(val, arr) {
  if (val === null || arr.length < 3) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length
  return Math.abs(val - mean) / (Math.sqrt(variance) + 1)
}

function computeZs(sample) {
  const zs = {}
  for (const k of KEYS) zs[k] = zScore(sample[k], wins[k])
  const score = Object.values(zs).reduce((a, b) => a + b, 0) / KEYS.length
  const driver = KEYS.reduce((best, k) => zs[k] > zs[best] ? k : best, KEYS[0])
  return { zs, score, driver }
}

// ── Classification (same rules as whisper) ────────────────────────────────────

function classify(zs) {
  const { ctxt, pgf, intr, entropy: ent, tcp, threads } = zs
  if (ctxt > 2 && pgf > 2)    return 'inference'
  if (tcp > 2 && intr > 2)    return 'net-burst'
  if (tcp > 3)                 return 'net-burst'
  if (pgf > 3 && ctxt < 1)    return 'mem-pressure'
  if (threads > 3)             return 'fork-storm'
  if (intr > 3 && ctxt < 1)   return 'interrupt-burst'
  if (ent > 3)                 return 'entropy-event'
  if (ctxt > 2 || pgf > 2 || intr > 2) return 'active'
  return 'idle'
}

// ── Session management ────────────────────────────────────────────────────────

// Load recent completed sessions from disk (within WINDOW_MS)
function loadHistory() {
  try {
    const cutoff = Date.now() - WINDOW_MS
    return readFileSync(LOG_FILE, 'utf8')
      .trim().split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(s => s && s.endTs && s.endTs > cutoff)
  } catch { return [] }
}

let sessions = loadHistory()  // completed sessions (chronological)
let current  = null           // active (open) session

// Hysteresis: we wait HYSTERESIS ticks of a new class before committing
let pendingClass = null
let pendingCount = 0

function newSession(cls, ts, entropy) {
  return {
    id:           ts,
    class:        cls,
    startTs:      ts,
    endTs:        null,
    ticks:        0,
    peakScore:    0,
    totalScore:   0,
    startEntropy: entropy ?? null,
    endEntropy:   entropy ?? null,
  }
}

function closeSession(ts, entropy) {
  if (!current) return
  current.endTs      = ts
  current.endEntropy = entropy ?? current.endEntropy
  current.avgScore   = current.ticks > 0 ? +(current.totalScore / current.ticks).toFixed(3) : 0
  sessions.push(current)
  // Persist completed session to disk (cross-restart history)
  try { appendFileSync(LOG_FILE, JSON.stringify(current) + '\n') } catch {}
  // Trim sessions older than window
  const cutoff = Date.now() - WINDOW_MS
  sessions = sessions.filter(s => s.endTs !== null && s.endTs > cutoff)
  if (sessions.length > MAX_SESSIONS) sessions.shift()
  current = null
}

function updateSession(cls, ts, score, entropy) {
  if (!current) {
    current      = newSession(cls, ts, entropy)
    pendingClass = null
    pendingCount = 0
  }

  // Accumulate into current session regardless of pending
  current.ticks++
  current.totalScore += score
  current.endTs      = ts
  if (entropy !== null) current.endEntropy = entropy
  if (score > current.peakScore) current.peakScore = score

  if (cls === current.class) {
    // Staying in same class — reset hysteresis
    pendingClass = null
    pendingCount = 0
  } else {
    // Candidate switch
    if (cls === pendingClass) {
      pendingCount++
    } else {
      pendingClass = cls
      pendingCount = 1
    }
    if (pendingCount >= HYSTERESIS) {
      closeSession(ts, entropy)
      current      = newSession(cls, ts, entropy)
      pendingClass = null
      pendingCount = 0
    }
  }
}

// ── Live state ────────────────────────────────────────────────────────────────

let samplesTotal = 0
let live = { score: 0, class: 'warming…', driver: null, sample: {} }

// ── Main tick ─────────────────────────────────────────────────────────────────

function tick() {
  const lo = sampleLoad()
  const d  = sampleDeltas()
  const e  = sampleEntropy()
  const t  = sampleTcp()

  const sample = {
    entropy: e,
    tcp:     t,
    threads: lo.total,
    ctxt:    d.ctxt,
    intr:    d.intr,
    pgf:     d.pgf,
  }

  for (const [k, v] of Object.entries(sample)) pushWin(k, v)
  samplesTotal++
  live.sample = sample

  const minLen = Math.min(...KEYS.map(k => wins[k].length))
  if (minLen < 5) {
    live.class = 'warming…'
    return
  }

  const { zs, score, driver } = computeZs(sample)
  const cls = classify(zs)

  live.score  = score
  live.class  = cls
  live.driver = driver

  updateSession(cls, Date.now(), score, e)
}

// ── API ───────────────────────────────────────────────────────────────────────

function apiData() {
  const now        = Date.now()
  const windowStart = now - WINDOW_MS

  // Merge completed + current session (with endTs projected to now)
  const allSessions = [
    ...sessions,
    ...(current ? [{ ...current, endTs: now }] : []),
  ]

  return {
    ts:           now,
    windowStart,
    windowMs:     WINDOW_MS,
    hostname:     osHostname(),
    live,
    sessions:     allSessions,
    samples:      samplesTotal,
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>oracle</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#b0b0b0;
  --dim:#303030;
  --vdim:#141414;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
  --c-inference:#4aaa4a;
  --c-net:#4a8aaa;
  --c-mem:#c09000;
  --c-fork:#e05050;
  --c-intr:#e06020;
  --c-entropy:#8a4aaa;
  --c-active:#3a3a3a;
  --c-idle:#1a1a1a;
}
html,body{
  height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased;
}
body{padding:32px 28px;max-width:680px;margin:0 auto}

/* header */
#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:36px}
.title{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--vdim)}
#ts{font-size:10px;color:var(--vdim);letter-spacing:.04em}

/* live state */
#live-wrap{display:flex;align-items:baseline;gap:16px;margin-bottom:28px;min-height:20px}
#live-cls{font-size:13px;letter-spacing:.18em;text-transform:uppercase;transition:color .4s ease}
#live-score{font-size:10px;color:var(--dim);letter-spacing:.04em}
#live-driver{font-size:9px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase}

/* section header */
.section{
  font-size:9px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);padding-bottom:7px;border-bottom:1px solid #111;margin-bottom:12px
}

/* 2-hour timeline */
#timeline-wrap{margin-bottom:8px}
#timeline{
  display:flex;
  height:18px;
  border-radius:2px;
  overflow:hidden;
  background:#111;
  position:relative;
}
.seg{
  height:100%;
  flex-shrink:0;
  cursor:default;
  transition:opacity .15s;
}
.seg:hover{opacity:.7}
.seg.inference{background:var(--c-inference)}
.seg.net-burst{background:var(--c-net)}
.seg.mem-pressure{background:var(--c-mem)}
.seg.fork-storm{background:var(--c-fork)}
.seg.interrupt-burst{background:var(--c-intr)}
.seg.entropy-event{background:var(--c-entropy)}
.seg.active{background:var(--c-active)}
.seg.idle{background:var(--c-idle)}
.seg.warming{background:var(--c-idle)}

/* time axis */
#axis{
  display:flex;justify-content:space-between;
  font-size:8px;color:var(--vdim);letter-spacing:.04em;
  margin-top:5px;padding:0 1px;
  margin-bottom:20px;
}

/* tooltip */
#tip{
  position:fixed;
  background:#0e0e0e;
  border:1px solid #1e1e1e;
  padding:9px 13px;
  font-size:9px;
  letter-spacing:.05em;
  line-height:1.8;
  color:var(--fg);
  pointer-events:none;
  display:none;
  z-index:20;
  white-space:nowrap;
  min-width:180px;
}
#tip .tip-cls{letter-spacing:.15em;text-transform:uppercase;font-size:9px}

/* legend */
#legend{
  display:flex;flex-wrap:wrap;gap:10px 16px;
  margin-bottom:28px;
}
.leg{display:flex;align-items:center;gap:5px;font-size:8px;color:var(--dim);
  letter-spacing:.1em;text-transform:uppercase}
.leg-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.leg-dot.inference{background:var(--c-inference)}
.leg-dot.net-burst{background:var(--c-net)}
.leg-dot.mem-pressure{background:var(--c-mem)}
.leg-dot.fork-storm{background:var(--c-fork)}
.leg-dot.interrupt-burst{background:var(--c-intr)}
.leg-dot.entropy-event{background:var(--c-entropy)}
.leg-dot.active{background:var(--c-active);border:1px solid #555}
.leg-dot.idle{background:var(--c-idle);border:1px solid #2a2a2a}

/* session list */
.sess{
  display:grid;
  grid-template-columns:130px 100px 48px 60px 80px;
  gap:6px;
  align-items:center;
  padding:6px 0;
  border-bottom:1px solid #0e0e0e;
  cursor:default;
}
.sess:last-child{border-bottom:none}
.sess.current{opacity:.65}
.s-time{font-size:8px;color:var(--dim);letter-spacing:.03em;white-space:nowrap}
.s-cls{font-size:9px;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.s-dur{font-size:9px;color:var(--fg);text-align:right;white-space:nowrap}
.s-peak{font-size:9px;color:var(--dim);text-align:right}
.s-ent{font-size:8px;color:var(--vdim);text-align:right;white-space:nowrap;letter-spacing:.02em}

.empty{font-size:10px;color:var(--vdim);padding:14px 0;letter-spacing:.06em}

/* footer */
#ft{margin-top:28px;display:flex;justify-content:space-between;
  font-size:9px;color:var(--vdim);letter-spacing:.06em}
</style>
</head>
<body>

<div id="hd">
  <div class="title">oracle</div>
  <div id="ts">—</div>
</div>

<div id="live-wrap">
  <div id="live-cls">—</div>
  <div id="live-score">—</div>
  <div id="live-driver"></div>
</div>

<div id="timeline-wrap">
  <div class="section">2-hour session timeline</div>
  <div id="timeline"></div>
  <div id="axis">
    <span id="ax-s">—</span>
    <span id="ax-m">—</span>
    <span>now</span>
  </div>
</div>

<div id="legend">
  <div class="leg"><div class="leg-dot inference"></div>inference</div>
  <div class="leg"><div class="leg-dot net-burst"></div>net-burst</div>
  <div class="leg"><div class="leg-dot mem-pressure"></div>mem</div>
  <div class="leg"><div class="leg-dot fork-storm"></div>fork-storm</div>
  <div class="leg"><div class="leg-dot interrupt-burst"></div>interrupt</div>
  <div class="leg"><div class="leg-dot entropy-event"></div>entropy</div>
  <div class="leg"><div class="leg-dot active"></div>active</div>
  <div class="leg"><div class="leg-dot idle"></div>idle</div>
</div>

<div class="section">episodes · newest first</div>
<div id="slist"><div class="empty">building baseline…</div></div>

<div id="ft">
  <div>2s · 3-tick hysteresis · 2h window</div>
  <div id="host"></div>
</div>

<div id="tip"></div>

<script>
var CC = {
  inference:'#4aaa4a','net-burst':'#4a8aaa','mem-pressure':'#c09000',
  'fork-storm':'#e05050','interrupt-burst':'#e06020','entropy-event':'#8a4aaa',
  active:'#3a3a3a',idle:'#1a1a1a','warming\u2026':'#1a1a1a'
}

function ft(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
}
function ftShort(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit',minute:'2-digit',hour12:false})
}
function dur(ms) {
  if (ms < 60000) return Math.round(ms/1000) + 's'
  var m = Math.floor(ms/60000), s = Math.round((ms%60000)/1000)
  return s > 0 ? m + 'm' + s + 's' : m + 'm'
}
function fmtEnt(s, e) {
  if (s == null || e == null) return ''
  if (s === e) return s + 'b'
  return s + (e < s ? '\u2193' : '\u2191') + e + 'b'
}

var tip = document.getElementById('tip')
function showTip(ev, s, now) {
  var ms = (s.endTs || now) - s.startTs
  var cc = CC[s.class] || '#b0b0b0'
  tip.innerHTML =
    '<div class="tip-cls" style="color:' + cc + '">' + s.class + '</div>' +
    ft(s.startTs) + ' \u2192 ' + ft(s.endTs || now) + '<br>' +
    'duration: ' + dur(ms) + '<br>' +
    'peak score: ' + s.peakScore.toFixed(2) + '<br>' +
    'ticks: ' + s.ticks +
    (s.startEntropy != null ? '<br>entropy: ' + fmtEnt(s.startEntropy, s.endEntropy) : '')
  tip.style.display = 'block'
  posTip(ev)
}
function posTip(ev) {
  var x = ev.clientX + 14, y = ev.clientY - 10
  if (x + 240 > window.innerWidth) x = ev.clientX - 250
  tip.style.left = x + 'px'
  tip.style.top  = y + 'px'
}
document.addEventListener('mousemove', function(ev) {
  if (tip.style.display !== 'none') posTip(ev)
})

function update(data) {
  var now = data.ts
  document.getElementById('ts').textContent = ft(now)
  document.getElementById('host').textContent = data.hostname || location.hostname

  // Live
  var cls = data.live.class || '\u2014'
  var lc = document.getElementById('live-cls')
  lc.textContent = cls
  lc.style.color = CC[cls] || '#b0b0b0'
  document.getElementById('live-score').textContent =
    typeof data.live.score === 'number' ? 'score\u00a0' + data.live.score.toFixed(2) : ''
  document.getElementById('live-driver').textContent =
    data.live.driver ? '\u2191\u00a0' + data.live.driver : ''

  // Timeline
  var wMs    = data.windowMs
  var wStart = data.windowStart
  var tl     = document.getElementById('timeline')
  tl.innerHTML = ''
  var segs = data.sessions || []
  segs.forEach(function(s) {
    var ss = Math.max(s.startTs, wStart)
    var se = Math.min(s.endTs || now, now)
    if (se <= ss) return
    var w = ((se - ss) / wMs) * 100
    if (w < 0.02) return
    var seg = document.createElement('div')
    var cls = (s.class || 'idle').replace(/[\s.…]+/g, '-')
    seg.className = 'seg ' + cls
    seg.style.width = w + '%'
    seg.addEventListener('mouseenter', function(ev) { showTip(ev, s, now) })
    seg.addEventListener('mouseleave', function() { tip.style.display = 'none' })
    tl.appendChild(seg)
  })

  // Axis
  document.getElementById('ax-s').textContent = ftShort(wStart)
  document.getElementById('ax-m').textContent = ftShort(wStart + wMs/2)

  // Session list (newest first)
  var slist = document.getElementById('slist')
  var rev = (data.sessions || []).slice().reverse()
  if (!rev.length) {
    slist.innerHTML = '<div class="empty">building baseline\u2026</div>'
    return
  }
  slist.innerHTML = ''
  rev.slice(0, 30).forEach(function(s) {
    var ms = (s.endTs || now) - s.startTs
    var ongoing = !s.endTs || s.endTs >= now - 4000
    var row = document.createElement('div')
    row.className = 'sess' + (ongoing ? ' current' : '')
    var cc = CC[s.class] || '#b0b0b0'
    var endStr = ongoing ? '\u25b6' : ft(s.endTs).slice(0, 8)
    row.innerHTML =
      '<div class="s-time">' + ft(s.startTs).slice(0,8) + ' \u2013 ' + endStr + '</div>' +
      '<div class="s-cls" style="color:' + cc + '">' + (s.class || '?') + '</div>' +
      '<div class="s-dur">' + dur(ms) + '</div>' +
      '<div class="s-peak">\u2191' + s.peakScore.toFixed(2) + '</div>' +
      '<div class="s-ent">' + (s.startEntropy != null ? fmtEnt(s.startEntropy, s.endEntropy) : '') + '</div>'
    row.addEventListener('mouseenter', function(ev) { showTip(ev, s, now) })
    row.addEventListener('mouseleave', function() { tip.style.display = 'none' })
    slist.appendChild(row)
  })
}

function poll() {
  fetch('/api').then(function(r){return r.json()}).then(update).catch(function(){})
}

document.getElementById('host').textContent = location.hostname
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
  console.log(`[oracle] http://localhost:${PORT}`)
  console.log('[oracle] 2-hour session timeline · 3-tick hysteresis · 2s tick')
  console.log('[oracle] sessions: inference / net-burst / mem-pressure / fork-storm / interrupt-burst / entropy-event / active / idle')
})

tick()
setInterval(tick, TICK_MS)
