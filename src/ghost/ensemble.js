// ensemble.js — unified view for the ghost / whisper / oracle trio
//
// Three resolution layers watching the same machine:
//   ghost   :3032  threshold events (raw crossings)
//   whisper :3033  statistical novelty (z-score moments)
//   oracle  :3034  episodic memory (coherent sessions)
//
// Fetches all three APIs server-side every 2s.
// Merges their event streams by timestamp into one combined log.
// Serves one page on port 3035. Zero dependencies.

import { createServer } from 'http'
import { hostname as osHostname } from 'os'

const PORT    = 3035
const TICK_MS = 2000
const MAX_EVS = 80

const UPSTREAM = {
  ghost:       'http://127.0.0.1:3032/api',
  whisper:     'http://127.0.0.1:3033/api',
  oracle:      'http://127.0.0.1:3034/api',
  convergence: 'http://127.0.0.1:3036/api',
}

// ── State ─────────────────────────────────────────────────────────────────────

// Seen-sets prevent re-adding the same event on repeated polls.
// Naturally bounded: ghost keeps ≤40, whisper ≤20, oracle ≤200 sessions.
const seenGhost       = new Set()
const seenWhisper     = new Set()
const seenOracle      = new Set()
const seenConvergence = new Set()

let state = {
  ts:          Date.now(),
  host:        osHostname(),
  ghost:       { status: 'offline' },
  whisper:     { status: 'offline' },
  oracle:      { status: 'offline' },
  convergence: { status: 'offline' },
  events:      [],
}

function pushEvent(ev) {
  const key = `${ev.src}:${ev.ts}`
  if (state.events.some(e => `${e.src}:${e.ts}` === key)) return
  state.events.push(ev)
  state.events.sort((a, b) => b.ts - a.ts)
  if (state.events.length > MAX_EVS) state.events.length = MAX_EVS
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1800)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return r.ok ? r.json() : null
  } catch { clearTimeout(timer); return null }
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function doPoll() {
  const [g, w, o, c] = await Promise.all([
    getJson(UPSTREAM.ghost),
    getJson(UPSTREAM.whisper),
    getJson(UPSTREAM.oracle),
    getJson(UPSTREAM.convergence),
  ])

  // Ghost
  if (g) {
    state.ghost = { status: 'ok', latest: g.latest, hist: g.hist, events: g.events }
    for (const ev of (g.events || [])) {
      if (!seenGhost.has(ev.ts)) {
        seenGhost.add(ev.ts)
        pushEvent({ ts: ev.ts, src: 'ghost', msg: ev.msg })
      }
    }
  } else {
    state.ghost = { status: 'offline' }
  }

  // Whisper
  if (w) {
    state.whisper = {
      status:      'ok',
      score:       w.score,
      class:       w.class,
      driver:      w.driver,
      noveltyHist: w.noveltyHist || [],
    }
    for (const ev of (w.events || [])) {
      if (!seenWhisper.has(ev.ts)) {
        seenWhisper.add(ev.ts)
        pushEvent({ ts: ev.ts, src: 'whisper', score: ev.score, class: ev.class, driver: ev.driver })
      }
    }
  } else {
    state.whisper = { status: 'offline' }
  }

  // Oracle — emit an event when a session closes (endTs appears for the first time)
  if (o) {
    state.oracle = {
      status:   'ok',
      live:     o.live,
      sessions: o.sessions || [],
      windowMs: o.windowMs || 7200000,
    }
    for (const s of (o.sessions || [])) {
      if (s.endTs && !seenOracle.has(s.id)) {
        seenOracle.add(s.id)
        pushEvent({
          ts:           s.endTs,
          src:          'oracle',
          class:        s.class,
          startTs:      s.startTs,
          duration:     s.endTs - s.startTs,
          peakScore:    s.peakScore,
          startEntropy: s.startEntropy,
          endEntropy:   s.endEntropy,
        })
      }
    }
  } else {
    state.oracle = { status: 'offline' }
  }

  // Convergence — inject agreement events (with haiku) into the shared log
  if (c) {
    state.convergence = { status: 'ok', cooldownRemaining: c.cooldownRemaining }
    for (const entry of (c.log || [])) {
      if (!seenConvergence.has(entry.ts)) {
        seenConvergence.add(entry.ts)
        pushEvent({
          ts:      entry.ts,
          src:     'convergence',
          sources: entry.sources || [],
          haiku:   entry.haiku   || null,
        })
      } else if (entry.haiku) {
        // Haiku arrived after initial log — patch in-memory event
        const ev = state.events.find(e => e.src === 'convergence' && e.ts === entry.ts)
        if (ev && !ev.haiku) ev.haiku = entry.haiku
      }
    }
  } else {
    state.convergence = { status: 'offline' }
  }

  state.ts = Date.now()
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ensemble</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#b0b0b0;
  --dim:#303030;
  --vdim:#141414;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
  --c-ghost:#505050;
  --c-whisper:#4a8aaa;
  --c-oracle:#4aaa4a;
  --c-conv:#9060c0;
  --c-inference:#4aaa4a;
  --c-net:#4a8aaa;
  --c-mem:#c09000;
  --c-fork:#e05050;
  --c-intr:#e06020;
  --c-entropy:#8a4aaa;
}
html,body{height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased}
body{padding:28px 24px;max-width:760px;margin:0 auto}

/* header */
#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:28px}
.title{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--vdim)}
#ts{font-size:10px;color:var(--vdim);letter-spacing:.04em}

/* status pods */
#strip{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:22px}
.pod{background:#0c0c0c;border:1px solid #111;border-radius:2px;padding:11px 13px}
.pod.offline{border-color:#1a1010;opacity:.45}
.pod-label{font-size:7px;letter-spacing:.28em;text-transform:uppercase;
  margin-bottom:7px;display:flex;align-items:center;gap:6px}
.pod-label .dot{width:4px;height:4px;border-radius:50%;flex-shrink:0}
.pod-label .dot.ghost{background:var(--c-ghost)}
.pod-label .dot.whisper{background:var(--c-whisper)}
.pod-label .dot.oracle{background:var(--c-oracle)}
.pod-label .dot.offline{background:#333}
.pod-val{font-size:17px;letter-spacing:-.01em;line-height:1;margin-bottom:4px}
.pod-sub{font-size:9px;color:var(--dim);letter-spacing:.05em;min-height:14px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pod-spark{font-size:10px;letter-spacing:0;color:var(--dim);margin-top:5px;
  white-space:nowrap;overflow:hidden}

/* section header */
.section{font-size:9px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);padding-bottom:7px;border-bottom:1px solid #111;margin-bottom:10px}

/* 30-min oracle timeline */
#tl-wrap{margin-bottom:20px}
#tl{display:flex;height:12px;border-radius:1px;overflow:hidden;background:#0d0d0d;width:100%}
.seg{height:100%;flex-shrink:0;cursor:default;transition:opacity .15s}
.seg:hover{opacity:.65}
.seg.inference{background:var(--c-inference)}
.seg.net-burst{background:var(--c-net)}
.seg.mem-pressure{background:var(--c-mem)}
.seg.fork-storm{background:var(--c-fork)}
.seg.interrupt-burst{background:var(--c-intr)}
.seg.entropy-event{background:var(--c-entropy)}
.seg.active{background:#282828}
.seg.idle{background:#111}
.seg.warming{background:#111}
#ax{display:flex;justify-content:space-between;
  font-size:8px;color:var(--vdim);letter-spacing:.03em;
  margin-top:4px;padding:0 1px;margin-bottom:22px}

/* tooltip */
#tip{position:fixed;background:#0e0e0e;border:1px solid #1e1e1e;
  padding:8px 12px;font-size:9px;letter-spacing:.05em;line-height:1.8;
  color:var(--fg);pointer-events:none;display:none;z-index:20;white-space:nowrap}

/* combined event log */
#evlog{margin-bottom:0}
.ev{display:grid;grid-template-columns:58px 54px 1fr;gap:10px;
  padding:5px 0;border-bottom:1px solid #0d0d0d;align-items:baseline}
.ev:last-child{border-bottom:none}
.ev-ts{font-size:8px;color:var(--dim);white-space:nowrap;letter-spacing:.03em}
.ev-src{font-size:7px;letter-spacing:.12em;text-transform:uppercase;
  padding:1px 5px;border-radius:1px;white-space:nowrap;text-align:center;align-self:center}
.ev-src.ghost{color:var(--c-ghost);border:1px solid #222}
.ev-src.whisper{color:var(--c-whisper);border:1px solid #1a2a33}
.ev-src.oracle{color:var(--c-oracle);border:1px solid #1a2a1a}
.ev-src.convergence{color:var(--c-conv);border:1px solid #2a1a3a}
.ev-body{font-size:9px;letter-spacing:.04em;line-height:1.4}
.ev.fresh .ev-body{animation:flash .9s ease-out}
@keyframes flash{from{color:#ccc}to{color:var(--fg)}}
.empty{font-size:10px;color:var(--vdim);padding:16px 0;letter-spacing:.07em}

/* footer */
#ft{margin-top:24px;display:flex;justify-content:space-between;
  font-size:9px;color:var(--vdim);letter-spacing:.06em}
</style>
</head>
<body>

<div id="hd">
  <div class="title">ensemble</div>
  <div id="ts">&mdash;</div>
</div>

<div id="strip">
  <div class="pod" id="pod-ghost">
    <div class="pod-label"><div class="dot ghost" id="dot-ghost"></div>ghost</div>
    <div class="pod-val" id="g-entropy">&mdash;</div>
    <div class="pod-sub" id="g-last">&mdash;</div>
    <div class="pod-spark" id="g-spark"></div>
  </div>
  <div class="pod" id="pod-whisper">
    <div class="pod-label"><div class="dot whisper" id="dot-whisper"></div>whisper</div>
    <div class="pod-val" id="w-score">&mdash;</div>
    <div class="pod-sub" id="w-class">&mdash;</div>
    <div class="pod-spark" id="w-spark"></div>
  </div>
  <div class="pod" id="pod-oracle">
    <div class="pod-label"><div class="dot oracle" id="dot-oracle"></div>oracle</div>
    <div class="pod-val" id="o-class">&mdash;</div>
    <div class="pod-sub" id="o-dur">&mdash;</div>
    <div class="pod-spark" id="o-sub2"></div>
  </div>
</div>

<div id="tl-wrap">
  <div class="section">oracle &middot; 30-min timeline</div>
  <div id="tl"></div>
  <div id="ax">
    <span id="ax-s">&mdash;</span>
    <span id="ax-m">&mdash;</span>
    <span>now</span>
  </div>
</div>

<div class="section">combined events &middot; ghost / whisper / oracle</div>
<div id="evlog"><div class="empty">waiting for trio&hellip;</div></div>

<div id="ft">
  <div id="host">ensemble</div>
  <div>2s &middot; ghost:3032 &middot; whisper:3033 &middot; oracle:3034 &middot; convergence:3036</div>
</div>
<div id="tip"></div>

<script>
var CC = {
  inference:'#4aaa4a','net-burst':'#4a8aaa','mem-pressure':'#c09000',
  'fork-storm':'#e05050','interrupt-burst':'#e06020','entropy-event':'#8a4aaa',
  active:'#888',idle:'#303030'
}
CC['warming\u2026'] = '#303030'
var B = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'

function spark(arr, len) {
  len = len || 24
  if (!arr || !arr.length) return '\u00b7'.repeat(len)
  var sl = arr.slice(-len)
  var mn = Math.min.apply(null, sl), mx = Math.max.apply(null, sl), r = mx - mn || 1
  var s = ''
  for (var i = 0; i < sl.length; i++)
    s += B[Math.min(7, Math.max(0, Math.floor(((sl[i]-mn)/r)*7)))]
  while (s.length < len) s = '\u00b7' + s
  return s
}
function ft(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
}
function ftShort(ts) {
  return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})
}
function dur(ms) {
  if (ms < 60000) return Math.round(ms/1000)+'s'
  var m = Math.floor(ms/60000), s = Math.round((ms%60000)/1000)
  return s > 0 ? m+'m'+s+'s' : m+'m'
}
function fmtEnt(s, e) {
  if (s == null || e == null) return ''
  return s === e ? s+'b' : s+(e<s?'\u2193':'\u2191')+e+'b'
}

// Tooltip for timeline segments
var tip = document.getElementById('tip')
function showTip(ev, s, now) {
  var ms = (s.endTs || now) - s.startTs
  var cc = CC[s.class] || '#b0b0b0'
  tip.innerHTML =
    '<span style="color:'+cc+'">'+(s.class||'?')+'</span><br>'+
    ft(s.startTs)+' \u2192 '+ft(s.endTs||now)+'<br>'+
    'duration: '+dur(ms)+'<br>'+
    'peak: '+(s.peakScore||0).toFixed(2)+
    (s.startEntropy!=null?'<br>entropy: '+fmtEnt(s.startEntropy,s.endEntropy):'')
  tip.style.display = 'block'
  posTip(ev)
}
function posTip(ev) {
  var x = ev.clientX+12, y = ev.clientY-8
  if (x+230 > window.innerWidth) x = ev.clientX-240
  tip.style.left = x+'px'; tip.style.top = y+'px'
}
document.addEventListener('mousemove', function(ev) {
  if (tip.style.display !== 'none') posTip(ev)
})

var lastEvTop = 0
var emptyShown = true

function update(d) {
  document.getElementById('ts').textContent = ft(d.ts)
  document.getElementById('host').textContent = d.host || location.hostname

  // ── Ghost pod ──────────────────────────────────────────────────────────
  var g = d.ghost
  var gp = document.getElementById('pod-ghost')
  var gd = document.getElementById('dot-ghost')
  if (g.status === 'ok') {
    gp.classList.remove('offline')
    gd.className = 'dot ghost'
    var e = g.latest && g.latest.entropy != null ? g.latest.entropy+'b' : '\u2014'
    document.getElementById('g-entropy').textContent = e
    var gl = g.events && g.events[0]
    document.getElementById('g-last').textContent = gl ? gl.msg.slice(0,34) : 'quiet'
    document.getElementById('g-spark').textContent = g.hist ? spark(g.hist.entropy, 24) : ''
  } else {
    gp.classList.add('offline')
    gd.className = 'dot offline'
    document.getElementById('g-entropy').textContent = 'offline'
    document.getElementById('g-last').textContent = ':3032'
    document.getElementById('g-spark').textContent = ''
  }

  // ── Whisper pod ────────────────────────────────────────────────────────
  var w = d.whisper
  var wp = document.getElementById('pod-whisper')
  var wd = document.getElementById('dot-whisper')
  if (w.status === 'ok') {
    wp.classList.remove('offline')
    wd.className = 'dot whisper'
    document.getElementById('w-score').textContent =
      typeof w.score === 'number' ? w.score.toFixed(2) : '\u2014'
    var wcEl = document.getElementById('w-class')
    wcEl.textContent = (w.driver ? '\u2191'+w.driver+' \u00b7 ' : '')+(w.class||'\u2014')
    wcEl.style.color = CC[w.class] || '#505050'
    document.getElementById('w-spark').textContent = spark(w.noveltyHist, 24)
  } else {
    wp.classList.add('offline')
    wd.className = 'dot offline'
    document.getElementById('w-score').textContent = 'offline'
    document.getElementById('w-class').textContent = ':3033'
    document.getElementById('w-class').style.color = ''
    document.getElementById('w-spark').textContent = ''
  }

  // ── Oracle pod ─────────────────────────────────────────────────────────
  var o = d.oracle
  var op = document.getElementById('pod-oracle')
  var od = document.getElementById('dot-oracle')
  if (o.status === 'ok') {
    op.classList.remove('offline')
    od.className = 'dot oracle'
    var lv = o.live
    var oc = lv ? (lv.class || '\u2014') : '\u2014'
    var ocEl = document.getElementById('o-class')
    ocEl.textContent = oc
    ocEl.style.color = CC[oc] || '#4aaa4a'
    // Find active session for duration
    var now = d.ts
    var cur = (o.sessions || []).filter(function(s) { return !s.endTs || s.endTs >= now - 4000 })
    var curS = cur.length ? cur[cur.length-1] : null
    document.getElementById('o-dur').textContent = curS
      ? dur(now - curS.startTs)+' \u25b6' : ''
    document.getElementById('o-sub2').textContent = o.sessions
      ? o.sessions.length+' sessions' : ''
  } else {
    op.classList.add('offline')
    od.className = 'dot offline'
    document.getElementById('o-class').textContent = 'offline'
    document.getElementById('o-class').style.color = ''
    document.getElementById('o-dur').textContent = ':3034'
    document.getElementById('o-sub2').textContent = ''
  }

  // ── Oracle 30-min timeline ─────────────────────────────────────────────
  var TL_MS = 30 * 60 * 1000
  var tlEl = document.getElementById('tl')
  tlEl.innerHTML = ''
  if (o.status === 'ok' && (o.sessions||[]).length) {
    var now2 = d.ts
    var wStart = now2 - TL_MS
    o.sessions.forEach(function(s) {
      var ss = Math.max(s.startTs, wStart)
      var se = Math.min(s.endTs || now2, now2)
      if (se <= ss) return
      var pct = ((se-ss)/TL_MS)*100
      if (pct < 0.06) return
      var seg = document.createElement('div')
      var cls = (s.class||'idle').replace(/[\s.\u2026]+/g,'-')
      seg.className = 'seg '+cls
      seg.style.width = pct+'%'
      seg.addEventListener('mouseenter', function(ev) { showTip(ev,s,now2) })
      seg.addEventListener('mouseleave', function() { tip.style.display='none' })
      tlEl.appendChild(seg)
    })
    document.getElementById('ax-s').textContent = ftShort(wStart)
    document.getElementById('ax-m').textContent = ftShort(wStart+TL_MS/2)
  }

  // ── Combined event log ─────────────────────────────────────────────────
  var evs = d.events || []
  var newTop = evs.length ? evs[0].ts : 0
  if (emptyShown && !evs.length) return
  if (!emptyShown && newTop === lastEvTop) return
  emptyShown = !evs.length
  lastEvTop = newTop
  var el = document.getElementById('evlog')
  if (!evs.length) {
    el.innerHTML = '<div class="empty">waiting for trio\u2026</div>'
    return
  }
  el.innerHTML = ''
  var isFirst = true
  evs.slice(0, 32).forEach(function(ev) {
    var row = document.createElement('div')
    row.className = 'ev'+(isFirst?' fresh':'')
    isFirst = false

    var body = ''
    if (ev.src === 'ghost') {
      body = ev.msg || ''
    } else if (ev.src === 'whisper') {
      var cc = CC[ev.class]||'#b0b0b0'
      body = '<span style="color:'+cc+'">'+(ev.class||'?')+'</span>'
           + (typeof ev.score==='number' ? ' \u00b7 '+ev.score.toFixed(2) : '')
           + (ev.driver ? ' \u00b7 \u2191'+ev.driver : '')
    } else if (ev.src === 'oracle') {
      var cc2 = CC[ev.class]||'#b0b0b0'
      body = '<span style="color:'+cc2+'">'+(ev.class||'?')+'</span>'
           + ' \u00b7 '+dur(ev.duration||0)
           + (ev.peakScore ? ' \u00b7 pk\u00a0'+(ev.peakScore).toFixed(2) : '')
           + (ev.startEntropy!=null ? ' \u00b7 '+fmtEnt(ev.startEntropy,ev.endEntropy) : '')
    } else if (ev.src === 'convergence') {
      var srcStr = (ev.sources||[]).join('+')
      var hk = ev.haiku ? ev.haiku.split('\n')[0] : ''
      body = '<span style="color:#9060c0">' + srcStr + '</span>'
           + (hk ? ' \u00b7 <em style="color:#7a6878;font-size:9px">' + hk + '</em>'
                 : ' \u00b7 <span style="color:#2a2a2a">\u2026</span>')
    }

    row.innerHTML =
      '<div class="ev-ts">'+ft(ev.ts).slice(0,8)+'</div>'+
      '<div class="ev-src '+ev.src+'">'+ev.src+'</div>'+
      '<div class="ev-body">'+body+'</div>'
    el.appendChild(row)
  })
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
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    })
    res.end(JSON.stringify(state))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
  }
}).listen(PORT, () => {
  console.log(`[ensemble] http://localhost:${PORT}`)
  console.log('[ensemble] polling ghost:3032 · whisper:3033 · oracle:3034 every 2s')
  console.log('[ensemble] merged event stream · 30-min oracle timeline · status pods')
})

doPoll()
setInterval(doPoll, TICK_MS)
