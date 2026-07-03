// whisper.js — statistical novelty detector for the invisible machine
//
// Ghost watches fixed thresholds. Whisper watches statistical deviation.
// It learns what "normal" looks like for THIS Pi, then scores how weird
// each moment is relative to that personal baseline.
//
// Score 0 = perfectly normal. Score > 2 = elevated. Score > 4 = event.
// Classification names what kind of weird: inference / net-burst / mem-pressure
// / fork-storm / interrupt-burst / entropy-event / active / idle.
//
// Logs events (score >= SCORE_THRESH) to whisper.jsonl.
// Viewer on port 3033. No dependencies — pure Node builtins.

import { readFileSync, appendFileSync } from 'fs'
import { createServer } from 'http'
import { hostname as osHostname } from 'os'

const PORT         = 3033
const TICK_MS      = 2000
const WIN          = 30        // samples in rolling baseline (~60s)
const SCORE_THRESH = 2.5       // novelty score to log + flag
const LOG_FILE     = new URL('./whisper.jsonl', import.meta.url).pathname

// ── Samplers ──────────────────────────────────────────────────────────────────
// (independent copies — whisper runs without ghost)

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

// ── Rolling baseline ──────────────────────────────────────────────────────────

const KEYS = ['entropy', 'tcp', 'threads', 'ctxt', 'intr', 'pgf']
const wins = {}
for (const k of KEYS) wins[k] = []

function pushWin(key, val) {
  if (val === null || val === undefined || isNaN(val)) return
  wins[key].push(val)
  if (wins[key].length > WIN) wins[key].shift()
}

function winStats(arr) {
  if (arr.length < 3) return null
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length
  return { mean, std: Math.sqrt(variance) }
}

// Z-score magnitude. Returns 0 when insufficient data or val is null.
// Uses std+1 to prevent div-by-zero on perfectly flat signals (common at idle).
function zScore(val, arr) {
  if (val === null || arr.length < 3) return 0
  const s = winStats(arr)
  if (!s) return 0
  return Math.abs(val - s.mean) / (s.std + 1)
}

// ── Novelty ───────────────────────────────────────────────────────────────────

// Returns { score, driver, zs, means }
// score = mean z-score across all metrics
// driver = which metric is most anomalous
// zs = per-metric z-scores
// means = per-metric rolling means (for classification context)
function computeNovelty(sample) {
  const zs = {}
  const means = {}
  for (const k of KEYS) {
    zs[k] = zScore(sample[k], wins[k])
    const s = winStats(wins[k])
    means[k] = s ? +s.mean.toFixed(1) : null
  }
  const vals = Object.values(zs)
  const score = vals.reduce((a, b) => a + b, 0) / vals.length
  const driver = KEYS.reduce((best, k) => zs[k] > zs[best] ? k : best, KEYS[0])
  return { score, driver, zs, means }
}

// ── Classification ────────────────────────────────────────────────────────────

// Names the kind of novelty based on which metrics are most anomalous.
// Rules ordered from specific to generic.
function classify(zs) {
  const { ctxt, pgf, intr, entropy: ent, tcp, threads } = zs

  // Model inference fingerprint: ctx + pgf both elevated (hailo-ollama loads data + computes)
  if (ctxt > 2 && pgf > 2) return 'inference'

  // Network burst: TCP count changing + interrupts elevated (packet processing)
  if (tcp > 2 && intr > 2) return 'net-burst'
  if (tcp > 3)              return 'net-burst'

  // Memory pressure: page faults dominant, ctx switches not
  if (pgf > 3 && ctxt < 1) return 'mem-pressure'

  // Thread explosion
  if (threads > 3) return 'fork-storm'

  // Interrupt storm (hardware event, DMA, etc.)
  if (intr > 3 && ctxt < 1) return 'interrupt-burst'

  // Entropy anomaly (refill or drain)
  if (ent > 3) return 'entropy-event'

  // Elevated but not cleanly classifiable
  if (ctxt > 2 || pgf > 2 || intr > 2) return 'active'

  return 'idle'
}

// ── State ─────────────────────────────────────────────────────────────────────

const noveltyHist  = []   // rolling novelty scores for sparkline
const eventLog     = []   // anomaly events (score >= SCORE_THRESH)
const MAX_EVENTS   = 40

let state = {
  ts:      Date.now(),
  score:   0,
  class:   'warming…',
  driver:  null,
  sample:  {},
  means:   {},
  zs:      {},
  samples: 0,   // how many ticks completed
}

function recordEvent(ts, score, cls, driver, sample, means) {
  const entry = {
    ts,
    score:   +score.toFixed(3),
    class:   cls,
    driver,
    metrics: Object.fromEntries(KEYS.map(k => [k, sample[k]])),
    means:   Object.fromEntries(KEYS.map(k => [k, means[k]])),
  }
  try { appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n') } catch (_) {}
  eventLog.unshift(entry)
  if (eventLog.length > MAX_EVENTS) eventLog.pop()
}

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

  state.samples++
  state.ts     = Date.now()
  state.sample = sample

  // Need at least 5 samples before computing meaningful z-scores
  const minLen = Math.min(...KEYS.map(k => wins[k].length))
  if (minLen < 5) {
    state.class = 'warming…'
    return
  }

  const { score, driver, zs, means } = computeNovelty(sample)
  const cls = classify(zs)

  state.score  = score
  state.class  = cls
  state.driver = driver
  state.zs     = zs
  state.means  = means

  noveltyHist.push(+score.toFixed(3))
  if (noveltyHist.length > 60) noveltyHist.shift()

  if (score >= SCORE_THRESH) {
    recordEvent(Date.now(), score, cls, driver, sample, means)
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

function apiData() {
  return {
    ...state,
    noveltyHist,
    events: eventLog.slice(0, 20),
    threshold: SCORE_THRESH,
    logFile: LOG_FILE,
    hostname: osHostname(),
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>whisper</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#b0b0b0;
  --dim:#303030;
  --vdim:#141414;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;

  /* novelty score colors */
  --c-idle:#1e3a1e;
  --c-idle-hi:#2d6a2d;
  --c-active:#5c4a00;
  --c-active-hi:#c09000;
  --c-event:#5a1818;
  --c-event-hi:#e05050;

  /* class colors */
  --cc-inference:#4aaa4a;
  --cc-net:#4a8aaa;
  --cc-mem:#c09000;
  --cc-fork:#e05050;
  --cc-intr:#e06020;
  --cc-entropy:#8a4aaa;
  --cc-active:#b0b0b0;
  --cc-idle:#303030;
}
html,body{
  height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased;
}
body{padding:32px 28px;max-width:680px;margin:0 auto}

/* header */
#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:48px}
.title{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--vdim)}
#ts{font-size:10px;color:var(--vdim);letter-spacing:.04em}

/* novelty score — primary visual */
#score-wrap{text-align:center;margin-bottom:40px}
#score{
  font-size:64px;
  font-weight:400;
  letter-spacing:-.02em;
  line-height:1;
  transition:color .4s ease;
  color:var(--c-idle-hi);
}
#score.elevated{color:var(--c-active-hi)}
#score.anomaly{color:var(--c-event-hi)}

#class-label{
  margin-top:10px;
  font-size:10px;letter-spacing:.25em;text-transform:uppercase;
  transition:color .4s ease;
  color:var(--c-idle-hi);
}
#class-label.elevated{color:var(--c-active-hi)}
#class-label.anomaly{color:var(--c-event-hi)}

/* driver badge */
#driver{
  margin-top:6px;
  font-size:9px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--dim);
}

/* sparkline */
#spark-wrap{margin-bottom:36px}
.section{
  font-size:9px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);padding-bottom:7px;border-bottom:1px solid #111;margin-bottom:12px
}
#spark{
  font-size:11px;letter-spacing:0;color:var(--dim);
  white-space:nowrap;overflow:hidden;
}

/* z-score table */
#zscores{margin-bottom:36px}
.zrow{
  display:grid;grid-template-columns:80px 80px 1fr 60px;
  align-items:center;gap:8px;
  padding:5px 0;border-bottom:1px solid #0e0e0e;
}
.zrow:last-child{border-bottom:none}
.zk{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.zv{font-size:10px;color:var(--fg);text-align:right}
.zbar-bg{height:2px;background:#111;border-radius:1px;overflow:hidden}
.zbar-fill{height:100%;background:var(--dim);border-radius:1px;transition:width .4s ease}
.zbar-fill.hi{background:var(--c-active-hi)}
.zbar-fill.crit{background:var(--c-event-hi)}
.zmean{font-size:8px;color:var(--vdim);text-align:right}

/* events */
#events{margin-bottom:0}
.ev{
  display:grid;grid-template-columns:64px 44px 100px 1fr;gap:10px;
  padding:6px 0;border-bottom:1px solid #0e0e0e;
}
.ev:last-child{border-bottom:none}
.ev-ts{font-size:9px;color:var(--dim);white-space:nowrap;letter-spacing:.04em;padding-top:1px}
.ev-score{font-size:9px;text-align:right;padding-top:1px}
.ev-cls{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding-top:1px}
.ev-driver{font-size:9px;color:var(--dim);padding-top:1px}
.ev.fresh .ev-score,.ev.fresh .ev-cls{animation:flash .8s ease-out}
@keyframes flash{from{opacity:1}50%{opacity:.3}to{opacity:1}}
.empty{font-size:10px;color:var(--vdim);padding:14px 0;letter-spacing:.06em}

/* footer */
#ft{margin-top:28px;display:flex;justify-content:space-between;
  font-size:9px;color:var(--vdim);letter-spacing:.06em}
</style>
</head>
<body>

<div id="hd">
  <div class="title">whisper</div>
  <div id="ts">—</div>
</div>

<div id="score-wrap">
  <div id="score">—</div>
  <div id="class-label">—</div>
  <div id="driver"></div>
</div>

<div id="spark-wrap">
  <div class="section">novelty · 60 samples · 2 min</div>
  <div id="spark">·</div>
</div>

<div id="zscores">
  <div class="section">z-scores</div>
  <div id="ztable"></div>
</div>

<div id="events">
  <div class="section">events · score ≥ 2.5</div>
  <div id="log"><div class="empty">watching…</div></div>
</div>

<div id="ft">
  <div>2s · 30-sample baseline · statistical novelty</div>
  <div id="host"></div>
</div>

<script>
var KEYS = ['entropy','tcp','threads','ctxt','intr','pgf']
var LABELS = {entropy:'entropy',tcp:'tcp',threads:'threads',ctxt:'ctx sw',intr:'intr',pgf:'pgf'}
var CLASS_COLORS = {
  inference:'#4aaa4a', 'net-burst':'#4a8aaa', 'mem-pressure':'#c09000',
  'fork-storm':'#e05050', 'interrupt-burst':'#e06020', 'entropy-event':'#8a4aaa',
  active:'#b0b0b0', idle:'#303030', 'warming…':'#303030'
}
var B = '▁▂▃▄▅▆▇█'

function spark(arr, len) {
  len = len || 48
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

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
}

function scoreClass(score) {
  if (score >= 2.5) return 'anomaly'
  if (score >= 1.0) return 'elevated'
  return ''
}

// Build z-score table once
var ztable = document.getElementById('ztable')
KEYS.forEach(function(k) {
  var d = document.createElement('div')
  d.className = 'zrow'
  d.id = 'zrow-' + k
  d.innerHTML =
    '<div class="zk">' + LABELS[k] + '</div>' +
    '<div class="zv" id="zv-' + k + '">—</div>' +
    '<div class="zbar-bg"><div class="zbar-fill" id="zbar-' + k + '" style="width:0%"></div></div>' +
    '<div class="zmean" id="zmean-' + k + '">—</div>'
  ztable.appendChild(d)
})

var logEl = document.getElementById('log')
var scoreEl = document.getElementById('score')
var classEl = document.getElementById('class-label')
var driverEl = document.getElementById('driver')
var sparkEl = document.getElementById('spark')
var lastEvTs = 0
var emptyShown = true

function update(data) {
  document.getElementById('ts').textContent = fmtTime(data.ts)
  document.getElementById('host').textContent = data.hostname || location.hostname

  // Score
  var sc = data.score || 0
  var scStr = (typeof data.score === 'number') ? data.score.toFixed(2) : '—'
  scoreEl.textContent = scStr
  scoreEl.className = scoreClass(sc)
  classEl.textContent = data.class || '—'
  classEl.className = scoreClass(sc)
  classEl.style.color = CLASS_COLORS[data.class] || '#303030'
  driverEl.textContent = data.driver ? ('↑ ' + data.driver) : ''

  // Novelty sparkline
  sparkEl.textContent = spark(data.noveltyHist || [], 48)

  // Z-score bars
  var zs = data.zs || {}
  var means = data.means || {}
  KEYS.forEach(function(k) {
    var z = zs[k] || 0
    var pct = Math.min(100, (z / 6) * 100)  // 6 = off the charts
    var fill = document.getElementById('zbar-' + k)
    fill.style.width = pct + '%'
    fill.className = 'zbar-fill' + (z >= 4 ? ' crit' : z >= 2 ? ' hi' : '')
    document.getElementById('zv-' + k).textContent = z.toFixed(1)
    var m = means[k]
    document.getElementById('zmean-' + k).textContent = m !== null && m !== undefined ? ('μ ' + m) : '—'
  })

  // Events
  var evs = data.events || []
  if (evs.length && (emptyShown || evs[0].ts !== lastEvTs)) {
    emptyShown = false
    lastEvTs = evs[0] ? evs[0].ts : 0
    logEl.innerHTML = ''
    var isFirst = true
    evs.slice(0, 15).forEach(function(ev) {
      var d = document.createElement('div')
      d.className = 'ev' + (isFirst ? ' fresh' : '')
      isFirst = false
      var cc = CLASS_COLORS[ev.class] || '#b0b0b0'
      d.innerHTML =
        '<div class="ev-ts">' + fmtTime(ev.ts) + '</div>' +
        '<div class="ev-score" style="color:' + (ev.score >= 4 ? '#e05050' : '#c09000') + '">'
          + ev.score.toFixed(2) + '</div>' +
        '<div class="ev-cls" style="color:' + cc + '">' + (ev.class || '?') + '</div>' +
        '<div class="ev-driver">' + (ev.driver || '') + '</div>'
      logEl.appendChild(d)
    })
  }
}

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
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })
    res.end(JSON.stringify(apiData()))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
  }
}).listen(PORT, () => {
  console.log(`[whisper] http://localhost:${PORT}`)
  console.log('[whisper] baseline window: ' + WIN + ' samples (' + (WIN*TICK_MS/1000) + 's)')
  console.log('[whisper] event threshold: score >= ' + SCORE_THRESH)
  console.log('[whisper] logging events to: ' + LOG_FILE)
})

tick()
setInterval(tick, TICK_MS)
