// convergence.js — multi-instrument event detector + haiku logger
//
// Watches ghost / whisper / oracle simultaneously.
// When ≥2 instruments fire within 60s of each other, that's a convergence.
// Each convergence gets logged to convergences.jsonl and, if Ollama responds,
// a haiku is generated — the machine writing poetry about its own moments.
//
// Port 3036. No deps.

import { createServer }                              from 'http'
import { appendFileSync, existsSync, readFileSync,
         writeFileSync }                             from 'fs'
import { fileURLToPath }                             from 'url'
import path                                          from 'path'

const PORT        = 3036
const POLL_MS     = 5_000
const WINDOW_MS   = 60_000   // events within 60s count as convergent
const COOLDOWN_MS = 120_000  // min gap between logged convergences
const MAX_LOG     = 80       // entries kept in convergences.jsonl
const HAILO_URL   = 'http://localhost:8000'
const MODEL       = 'qwen2.5-instruct:1.5b'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const LOG_PATH   = path.join(__dirname, 'convergences.jsonl')

const UPSTREAM = {
  ghost:   'http://127.0.0.1:3032/api',
  whisper: 'http://127.0.0.1:3033/api',
  oracle:  'http://127.0.0.1:3034/api',
}

// ── State ─────────────────────────────────────────────────────────────────────

const seenGhost   = new Set()
const seenWhisper = new Set()
const seenOracle  = new Set()

// Rolling ring of recent events from any source (last WINDOW_MS)
let recent = []          // [{ ts, src, summary }]
let lastConvergence = 0  // timestamp of most recently logged convergence
let status = {
  ghost:   { online: false },
  whisper: { online: false },
  oracle:  { online: false },
}

// In-memory log (last MAX_LOG) — loaded from disk on start, appended live
let log = []  // [{ts, sources, events, haiku, haikuErr}]

// ── Persistence ───────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_PATH)) return []
  try {
    return readFileSync(LOG_PATH, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
  } catch { return [] }
}

function appendLog(entry) {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  log.push(entry)
  // Trim in-memory; rebuild file if too long
  if (log.length > MAX_LOG) {
    log = log.slice(log.length - MAX_LOG)
    writeFileSync(LOG_PATH, log.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return r.ok ? r.json() : null
  } catch { clearTimeout(timer); return null }
}

// ── Summarise each source's latest event ─────────────────────────────────────

function ghostSummary(ev) {
  return ev.msg || 'threshold crossing'
}

function whisperSummary(ev) {
  const parts = []
  if (ev.class) parts.push(ev.class)
  if (ev.score != null) parts.push(`score ${Number(ev.score).toFixed(2)}`)
  if (ev.driver) parts.push(ev.driver)
  return parts.join(' · ') || 'novelty spike'
}

function oracleSummary(ev) {
  const parts = []
  if (ev.class) parts.push(ev.class)
  if (ev.duration) parts.push(`${(ev.duration / 1000).toFixed(0)}s session`)
  if (ev.peakScore != null) parts.push(`peak ${Number(ev.peakScore).toFixed(2)}`)
  return parts.join(' · ') || 'session closed'
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function doPoll() {
  const [g, w, o] = await Promise.all([
    getJson(UPSTREAM.ghost),
    getJson(UPSTREAM.whisper),
    getJson(UPSTREAM.oracle),
  ])

  status.ghost.online   = !!g
  status.whisper.online = !!w
  status.oracle.online  = !!o

  const now    = Date.now()
  const cutoff = now - WINDOW_MS
  const newEvs = []

  // Ghost events
  if (g) {
    for (const ev of (g.events || [])) {
      if (!seenGhost.has(ev.ts)) {
        seenGhost.add(ev.ts)
        const rec = { ts: ev.ts, src: 'ghost', summary: ghostSummary(ev) }
        recent.push(rec)
        newEvs.push(rec)
      }
    }
  }

  // Whisper events
  if (w) {
    for (const ev of (w.events || [])) {
      if (!seenWhisper.has(ev.ts)) {
        seenWhisper.add(ev.ts)
        const rec = { ts: ev.ts, src: 'whisper', summary: whisperSummary(ev) }
        recent.push(rec)
        newEvs.push(rec)
      }
    }
  }

  // Oracle sessions (closed)
  if (o) {
    for (const s of (o.sessions || [])) {
      if (s.endTs && !seenOracle.has(s.id)) {
        seenOracle.add(s.id)
        const rec = { ts: s.endTs, src: 'oracle', summary: oracleSummary(s) }
        recent.push(rec)
        newEvs.push(rec)
      }
    }
  }

  // Trim recent to window
  recent = recent.filter(e => e.ts >= cutoff)

  // Convergence check: ≥2 distinct sources in window, and cooldown expired
  if (newEvs.length > 0 && (now - lastConvergence) >= COOLDOWN_MS) {
    const srcs = new Set(recent.map(e => e.src))
    if (srcs.size >= 2) {
      lastConvergence = now
      const entry = {
        ts:      now,
        sources: [...srcs].sort(),
        events:  recent.slice().sort((a, b) => a.ts - b.ts),
        haiku:   null,
        haikuErr: null,
      }
      appendLog(entry)
      console.log(`[convergence] ★ detected — sources: ${entry.sources.join('+')}`)

      // Generate haiku asynchronously — don't block the poll loop
      genHaiku(entry).then(haiku => {
        if (haiku) {
          entry.haiku = haiku
          // Rewrite the last line of the log file with the haiku
          rewriteLastLogEntry(entry)
          console.log(`[convergence] haiku: ${haiku.replace(/\n/g, ' / ')}`)
        }
      }).catch(() => {})
    }
  }
}

function rewriteLastLogEntry(entry) {
  try {
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n')
    // Find the line for this entry (by ts)
    const idx = lines.findLastIndex(l => {
      try { return JSON.parse(l).ts === entry.ts } catch { return false }
    })
    if (idx >= 0) {
      lines[idx] = JSON.stringify(entry)
      writeFileSync(LOG_PATH, lines.join('\n') + '\n')
    }
    // Update in-memory
    const mi = log.findLastIndex(e => e.ts === entry.ts)
    if (mi >= 0) log[mi] = entry
  } catch (err) {
    console.error('[convergence] rewrite err:', err.message)
  }
}

// ── Haiku ─────────────────────────────────────────────────────────────────────

async function genHaiku(entry) {
  const lines = entry.events.map(e => `  ${e.src}: ${e.summary}`)
  const prompt = [
    `You are a Raspberry Pi 5 that just noticed something.`,
    `Three observation layers watched and these events converged within one minute:`,
    ...lines,
    ``,
    `Write a haiku (5-7-5 syllables) about this moment of convergence.`,
    `Write from the machine's perspective. Use physical sensation — heat, hum, current, weight.`,
    `Output only the haiku. Three lines. No title, no explanation.`,
  ].join('\n')

  try {
    const r = await fetch(`${HAILO_URL}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal:  AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    const text = data.response?.trim() ?? ''
    // Extract first three non-empty lines (the haiku)
    const haikuLines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3)
    return haikuLines.length === 3 ? haikuLines.join('\n') : (haikuLines.join('\n') || null)
  } catch (err) {
    console.error('[convergence] haiku err:', err.message)
    return null
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ts:        Date.now(),
      cooldownRemaining: Math.max(0, COOLDOWN_MS - (Date.now() - lastConvergence)),
      online:    status,
      recent:    recent.slice(-20),
      log:       log.slice(-20).reverse(),
    }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>convergence</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#b0b0b0;
  --dim:#303030;
  --vdim:#141414;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
  --ghost:#505050;
  --whisper:#4a8aaa;
  --oracle:#4aaa4a;
  --converge:#9060c0;
  --haiku:#8a7060;
}
html,body{height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased}
body{padding:28px 24px;max-width:640px;margin:0 auto}

#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:28px}
.title{font-size:10px;letter-spacing:.32em;text-transform:uppercase;color:#252525}
#ts{font-size:9px;color:#252525;letter-spacing:.05em}

/* status strip */
#strip{display:flex;gap:14px;margin-bottom:24px;align-items:center}
.src{font-size:8px;letter-spacing:.18em;text-transform:uppercase;
  display:flex;align-items:center;gap:5px;opacity:.4;transition:opacity .3s}
.src.online{opacity:1}
.dot{width:4px;height:4px;border-radius:50%;background:currentColor}
.src.ghost{color:var(--ghost)}
.src.whisper{color:var(--whisper)}
.src.oracle{color:var(--oracle)}
#coolbar{margin-left:auto;font-size:8px;color:#252525;letter-spacing:.05em}

/* section header */
.sec{font-size:8px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--dim);padding-bottom:6px;border-bottom:1px solid #111;margin-bottom:14px}

/* convergence cards */
#log{margin-bottom:0}
.card{border:1px solid #111;border-radius:2px;background:#0a0a0a;
  padding:14px 16px;margin-bottom:12px;position:relative}
.card.fresh{border-color:#1e1428}
.card-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.card-ts{font-size:8px;color:var(--dim);letter-spacing:.04em}
.card-srcs{display:flex;gap:6px}
.src-tag{font-size:7px;letter-spacing:.14em;text-transform:uppercase;
  padding:1px 5px;border-radius:1px}
.src-tag.ghost{color:var(--ghost);border:1px solid #222}
.src-tag.whisper{color:var(--whisper);border:1px solid #1a2a33}
.src-tag.oracle{color:var(--oracle);border:1px solid #1a2a1a}

/* event list */
.evs{margin-bottom:12px}
.ev{font-size:9px;color:var(--dim);letter-spacing:.04em;padding:2px 0;
  display:flex;gap:8px}
.ev-src{flex-shrink:0;width:52px;color:#404040}
.ev-msg{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* haiku */
.haiku{border-left:2px solid #201828;padding:8px 12px;
  font-size:10px;line-height:1.9;letter-spacing:.08em;color:#7a6878;
  font-style:italic;white-space:pre-wrap}
.haiku.pending{color:#252525;font-style:normal;letter-spacing:.18em;font-size:8px}

/* empty */
.empty{font-size:10px;color:#1e1e1e;padding:20px 0;letter-spacing:.07em}

/* footer */
#ft{margin-top:22px;display:flex;justify-content:space-between;
  font-size:8px;color:#1a1a1a;letter-spacing:.06em}
</style>
</head>
<body>

<div id="hd">
  <div class="title">convergence</div>
  <div id="ts">&mdash;</div>
</div>

<div id="strip">
  <div class="src ghost" id="s-ghost"><div class="dot"></div>ghost</div>
  <div class="src whisper" id="s-whisper"><div class="dot"></div>whisper</div>
  <div class="src oracle" id="s-oracle"><div class="dot"></div>oracle</div>
  <div id="coolbar">cooldown &mdash;</div>
</div>

<div class="sec">convergence log &middot; machine moments</div>
<div id="log"><div class="empty">waiting for &#x22EF; &#x2265;2 instruments</div></div>

<div id="ft">
  <div>convergence &middot; :3036</div>
  <div>60s window &middot; 2min cooldown &middot; haiku on ollama</div>
</div>

<script>
var FRESH_MS = 30000

function fmt(ts) {
  var d = new Date(ts)
  return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'})
}
function fmtDate(ts) {
  var d = new Date(ts)
  var hms = d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'})
  var date = d.toLocaleDateString('en-GB', {month:'short',day:'numeric'})
  return date + ' ' + hms
}
function srcTag(s) {
  return '<span class="src-tag ' + s + '">' + s + '</span>'
}

function render(data) {
  document.getElementById('ts').textContent = fmt(data.ts)

  var on = data.online || {}
  ;['ghost','whisper','oracle'].forEach(function(k) {
    var el = document.getElementById('s-' + k)
    if (on[k] && on[k].online) el.classList.add('online')
    else el.classList.remove('online')
  })

  var cd = data.cooldownRemaining || 0
  var cb = document.getElementById('coolbar')
  if (cd > 500) {
    cb.textContent = 'cooldown ' + Math.ceil(cd / 1000) + 's'
  } else {
    cb.textContent = 'ready'
  }

  var logEl = document.getElementById('log')
  var entries = data.log || []
  if (!entries.length) {
    logEl.innerHTML = '<div class="empty">waiting for &#x22EF; &#x2265;2 instruments</div>'
    return
  }

  var now = Date.now()
  var html = ''
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    var fresh = (now - e.ts) < FRESH_MS

    // Collect distinct sources
    var srcSet = {}
    ;(e.sources || []).forEach(function(s) { srcSet[s] = true })
    var srcTags = Object.keys(srcSet).map(srcTag).join('')

    // Events list
    var evHtml = ''
    ;(e.events || []).slice(-6).forEach(function(ev) {
      evHtml += '<div class="ev"><span class="ev-src">' + ev.src + '</span>' +
                '<span class="ev-msg">' + (ev.summary || '') + '</span></div>'
    })

    // Haiku
    var haikuHtml = ''
    if (e.haiku) {
      haikuHtml = '<div class="haiku">' + e.haiku.replace(/</g,'&lt;').replace(/\n/g,'<br>') + '</div>'
    } else {
      haikuHtml = '<div class="haiku pending">&#x2026; waiting for haiku</div>'
    }

    html += '<div class="card' + (fresh ? ' fresh' : '') + '">' +
            '<div class="card-top">' +
            '<div class="card-ts">' + fmtDate(e.ts) + '</div>' +
            '<div class="card-srcs">' + srcTags + '</div>' +
            '</div>' +
            '<div class="evs">' + evHtml + '</div>' +
            haikuHtml +
            '</div>'
  }
  logEl.innerHTML = html
}

function poll() {
  fetch('/api').then(function(r) { return r.json() }).then(render).catch(function() {})
}

poll()
setInterval(poll, 3000)
</script>
</body>
</html>`

// ── Boot ──────────────────────────────────────────────────────────────────────

log = loadLog()
console.log(`[convergence] loaded ${log.length} prior entries from log`)

const server = createServer(handleRequest)
server.listen(PORT, () => {
  console.log(`[convergence] http://localhost:${PORT}`)
  console.log(`[convergence] window: ${WINDOW_MS / 1000}s  cooldown: ${COOLDOWN_MS / 1000}s  model: ${MODEL}`)
})

// Start polling immediately, then every POLL_MS
doPoll()
setInterval(doPoll, POLL_MS)
