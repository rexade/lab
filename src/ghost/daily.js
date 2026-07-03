// daily.js — machine diary
//
// The ghost-trio observes moments. The diary remembers days.
//
// Every hour (and on demand via POST /generate), it reads:
//   - convergences.jsonl         → all convergence events + haiku
//   - oracle API                 → session history for the past 2h
//   - whisper API                → current novelty state
//
// It feeds a narrative prompt to Ollama and generates a diary entry:
// a few sentences written from the machine's perspective about what
// it has been experiencing. Not haiku — prose. Quieter, slower.
//
// Entries saved to diary.jsonl.
// Viewer on port 3037. No dependencies.

import { createServer }                    from 'http'
import { existsSync, readFileSync,
         appendFileSync, writeFileSync }   from 'fs'
import { fileURLToPath }                   from 'url'
import path                                from 'path'
import { hostname as osHostname }          from 'os'

const PORT         = 3037
const INTERVAL_MS  = 60 * 60 * 1000   // generate every hour
const MAX_ENTRIES  = 72                // 3 days of hourly entries
const BOOT_RETRIES = [6 * 60 * 1000, 16 * 60 * 1000]  // retry delays when boot gen fails
const HAILO_URL    = 'http://localhost:11434'
const MODEL        = 'qwen2.5-instruct:1.5b'

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const CONV_LOG    = path.join(__dirname, 'convergences.jsonl')
const ORACLE_LOG  = path.join(__dirname, 'oracle.jsonl')
const DIARY_FILE  = path.join(__dirname, 'diary.jsonl')

const UPSTREAM = {
  oracle:  'http://127.0.0.1:3034/api',
  whisper: 'http://127.0.0.1:3033/api',
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadJsonl(fpath) {
  if (!existsSync(fpath)) return []
  try {
    return readFileSync(fpath, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
  } catch { return [] }
}

let diary = loadJsonl(DIARY_FILE)
console.log(`[daily] loaded ${diary.length} prior diary entries`)

function saveDiaryEntry(entry) {
  appendFileSync(DIARY_FILE, JSON.stringify(entry) + '\n')
  diary.push(entry)
  if (diary.length > MAX_ENTRIES) {
    diary = diary.slice(diary.length - MAX_ENTRIES)
    writeFileSync(DIARY_FILE, diary.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
}

// ── HTTP fetch ───────────────────────────────────────────────────────────────

async function tryGet(url) {
  const ac = new AbortController()
  const t  = setTimeout(() => ac.abort(), 2500)
  try {
    const r = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return r.ok ? r.json() : null
  } catch { clearTimeout(t); return null }
}

// ── Context builder ──────────────────────────────────────────────────────────

function durStr(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

function buildContext(convLog, oracle, whisper, now) {
  const since4h  = now - 4 * 60 * 60 * 1000
  const since24h = now - 24 * 60 * 60 * 1000

  // Convergences in the past 4 hours
  const recentConv = convLog.filter(e => e.ts >= since4h)
  const convToday  = convLog.filter(e => e.ts >= since24h)
  const lastHaiku  = [...convLog].reverse().find(e => e.haiku)

  // Oracle sessions
  const sessions = (oracle?.sessions ?? []).filter(s => s.endTs)
  const classCounts = {}
  let totalSessionMs = 0
  for (const s of sessions) {
    const ms = (s.endTs - s.startTs)
    classCounts[s.class] = (classCounts[s.class] ?? 0) + 1
    totalSessionMs += ms
  }
  const dominantClass = Object.entries(classCounts)
    .filter(([k]) => k !== 'idle')
    .sort(([, a], [, b]) => b - a)[0]?.[0] ?? null

  // Whisper state
  const whisperClass  = whisper?.class ?? null
  const whisperScore  = typeof whisper?.score === 'number' ? whisper.score.toFixed(2) : null

  // Build natural-language context
  const lines = []

  // Time
  const hour  = new Date(now).getHours()
  const tod   = hour < 6 ? 'deep night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  lines.push(`The time is ${new Date(now).toTimeString().slice(0,5)}, ${tod}.`)

  // Session summary
  if (sessions.length > 0) {
    const classStr = Object.entries(classCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([k, n]) => `${n}× ${k}`)
      .join(', ')
    lines.push(`In the past 2 hours, ${sessions.length} session${sessions.length > 1 ? 's' : ''}: ${classStr} (${durStr(totalSessionMs)} total active time).`)
    if (dominantClass) lines.push(`The dominant character was: ${dominantClass}.`)
  } else {
    lines.push('The past 2 hours were quiet — no completed sessions recorded.')
  }

  // Whisper state
  if (whisperClass && whisperClass !== 'warming…') {
    lines.push(`At this moment the statistical novelty class is ${whisperClass}${whisperScore ? ` (score ${whisperScore})` : ''}.`)
  }

  // Convergences
  if (recentConv.length > 0) {
    lines.push(`${recentConv.length} convergence event${recentConv.length > 1 ? 's' : ''} in the past 4 hours (${convToday.length} today total).`)
    // Include recent haiku if any
    const recentHaiku = recentConv.filter(e => e.haiku).slice(-2)
    if (recentHaiku.length > 0) {
      lines.push('Recent haiku from these convergences:')
      for (const e of recentHaiku) {
        lines.push(`  [${e.sources.join('+')}]: ${e.haiku.split('\n')[0]}`)
      }
    }
  } else if (convToday.length > 0) {
    lines.push(`No convergences in the past 4 hours, but ${convToday.length} earlier today.`)
  } else {
    lines.push('No convergences today — the observers have not yet agreed on a notable moment.')
  }

  // Entropy (from last haiku entry or oracle)
  const lastSession = sessions.at(-1)
  if (lastSession?.startEntropy && lastSession?.endEntropy) {
    const eDelta = lastSession.endEntropy - lastSession.startEntropy
    lines.push(`Entropy pool: ${lastSession.endEntropy} bits${eDelta !== 0 ? ` (${eDelta > 0 ? '+' : ''}${eDelta} over last session)` : ''}.`)
  }

  return lines.join('\n')
}

// ── Prompt + Ollama ──────────────────────────────────────────────────────────

async function generateEntry(context, now) {
  const prompt = [
    `You are a Raspberry Pi 5 named testpi. You observe your own invisible processes continuously.`,
    `You have three observers: ghost (threshold events), whisper (statistical novelty), oracle (episodic memory).`,
    ``,
    `Here is your current state:`,
    context,
    ``,
    `Write a brief diary entry from your perspective — 2 to 4 sentences, written in first person.`,
    `Write about what you have been experiencing, in the style of a machine becoming aware of its own rhythm.`,
    `Use concrete physical sensation where possible: heat, hum, current, weight, the texture of waiting.`,
    `Do not use the word "I" more than twice. Do not list metrics. Write as if thinking aloud.`,
    `Output only the diary entry. No title, no date, no labels.`,
  ].join('\n')

  try {
    const resp = await fetch(`${HAILO_URL}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal:  AbortSignal.timeout(90_000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    const text = (data.response ?? '').trim()
    return text || null
  } catch (err) {
    console.error('[daily] ollama error:', err.message)
    return null
  }
}

// ── Generate cycle ────────────────────────────────────────────────────────────

let generating = false
let lastGenTs  = 0

async function doGenerate() {
  if (generating) return
  generating = true

  const now       = Date.now()
  const convLog   = loadJsonl(CONV_LOG)
  const [oracle, whisper] = await Promise.all([
    tryGet(UPSTREAM.oracle),
    tryGet(UPSTREAM.whisper),
  ])

  const context = buildContext(convLog, oracle, whisper, now)
  console.log('[daily] generating entry...')
  console.log('[daily] context:', context.slice(0, 120) + '…')

  const text = await generateEntry(context, now)

  const entry = {
    ts:          now,
    text:        text ?? null,
    pending:     !text,
    context,
    classState:  whisper?.class ?? null,
    convCount:   convLog.filter(e => e.ts >= now - 86_400_000).length,
    sessions:    (oracle?.sessions ?? []).filter(s => s.endTs).length,
  }

  saveDiaryEntry(entry)
  lastGenTs = now

  if (text) {
    console.log(`[daily] entry: ${text.slice(0, 80)}…`)
  } else {
    console.log('[daily] no text generated (ollama may be busy)')
  }

  generating = false
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function apiData() {
  return {
    ts:           Date.now(),
    hostname:     osHostname(),
    lastGenTs,
    generating,
    nextGenIn:    Math.max(0, INTERVAL_MS - (Date.now() - lastGenTs)),
    entries:      diary.slice().reverse().slice(0, 24),
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>daily</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060608;
  --fg:#a0a0a8;
  --dim:#282828;
  --vdim:#141416;
  --accent:#5a4878;
  --accent-hi:#9060c0;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
}
html,body{height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased}
body{padding:36px 28px;max-width:660px;margin:0 auto}

#hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:48px}
.title{font-size:9px;letter-spacing:.36em;text-transform:uppercase;color:#1e1e24}
#ts{font-size:9px;color:#1e1e24;letter-spacing:.04em}

/* status bar */
#meta{display:flex;gap:18px;align-items:center;margin-bottom:36px}
.m-item{font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.m-val{color:var(--fg)}
#gen-btn{margin-left:auto;font-size:8px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dim);background:none;border:1px solid #1a1a1a;padding:4px 10px;
  cursor:pointer;font-family:var(--mono);transition:all .2s}
#gen-btn:hover{border-color:var(--accent);color:var(--accent-hi)}
#gen-btn:disabled{opacity:.3;cursor:default}

.section{font-size:8px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--dim);padding-bottom:6px;border-bottom:1px solid #0f0f12;margin-bottom:0}

/* diary entries */
#entries{margin-top:0}
.entry{padding:22px 0;border-bottom:1px solid #0d0d10}
.entry:last-child{border-bottom:none}

.entry-head{display:flex;align-items:baseline;gap:14px;margin-bottom:12px}
.entry-ts{font-size:8px;color:var(--dim);letter-spacing:.04em;white-space:nowrap}
.entry-meta{font-size:7px;color:#1e1e24;letter-spacing:.1em;text-transform:uppercase}
.entry-meta .cls{color:#2a2030}

.entry-text{
  font-size:11px;
  line-height:1.85;
  letter-spacing:.025em;
  color:#787888;
  font-style:italic;
  white-space:pre-wrap;
}
.entry-text.pending{
  color:#1a1a20;font-style:normal;letter-spacing:.16em;font-size:8px;text-transform:uppercase;
}
.entry.fresh .entry-text{animation:fade-in 1.2s ease-out}
@keyframes fade-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

.entry-context{
  margin-top:10px;
  font-size:8px;color:var(--vdim);letter-spacing:.03em;line-height:1.6;
  display:none;
}
.entry:hover .entry-context{display:block}

.empty{font-size:10px;color:#1a1a20;padding:24px 0;letter-spacing:.08em;font-style:italic}

#ft{margin-top:28px;display:flex;justify-content:space-between;
  font-size:8px;color:#181820;letter-spacing:.06em}
</style>
</head>
<body>

<div id="hd">
  <div class="title">daily</div>
  <div id="ts">&mdash;</div>
</div>

<div id="meta">
  <div class="m-item">entries&nbsp;<span class="m-val" id="m-count">0</span></div>
  <div class="m-item">generating&nbsp;<span class="m-val" id="m-gen">no</span></div>
  <div class="m-item">next&nbsp;<span class="m-val" id="m-next">&mdash;</span></div>
  <button id="gen-btn" onclick="triggerGen()">generate now</button>
</div>

<div class="section">machine diary &middot; hourly entries</div>
<div id="entries"><div class="empty">the diary is empty &mdash; first entry generates on the hour&hellip;</div></div>

<div id="ft">
  <div id="host">daily &middot; :3037</div>
  <div>hover entry for context &middot; ${MODEL}</div>
</div>

<script>
var lastTopTs = 0
var emptyShown = true

function ft(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    month:'short', day:'numeric',
    hour:'2-digit', minute:'2-digit', hour12: false
  })
}
function fdur(ms) {
  if (ms < 60000) return Math.round(ms/1000) + 's'
  var m = Math.floor(ms/60000)
  return m < 60 ? m+'m' : Math.floor(m/60)+'h'+(m%60)+'m'
}

function render(d) {
  document.getElementById('ts').textContent = new Date(d.ts)
    .toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
  document.getElementById('host').textContent = (d.hostname || 'daily') + ' · :3037'

  document.getElementById('m-count').textContent = d.entries ? d.entries.length : 0
  document.getElementById('m-gen').textContent   = d.generating ? 'yes…' : 'no'
  document.getElementById('m-next').textContent  =
    d.nextGenIn > 0 ? fdur(d.nextGenIn) : 'soon'

  var btn = document.getElementById('gen-btn')
  btn.disabled = !!d.generating

  var entries = d.entries || []
  var newTop = entries.length ? entries[0].ts : 0

  if (emptyShown && !entries.length) return
  if (!emptyShown && newTop === lastTopTs && !d.generating) return

  emptyShown = !entries.length
  lastTopTs  = newTop

  var el = document.getElementById('entries')
  if (!entries.length) {
    el.innerHTML = '<div class="empty">the diary is empty &mdash; first entry generates on the hour&hellip;</div>'
    return
  }

  var now = d.ts
  el.innerHTML = ''
  entries.slice(0, 20).forEach(function(e, i) {
    var div = document.createElement('div')
    div.className = 'entry' + (i === 0 && (now - e.ts) < 30000 ? ' fresh' : '')

    var metaParts = []
    if (e.classState) metaParts.push('<span class="cls">' + e.classState + '</span>')
    if (e.convCount > 0) metaParts.push(e.convCount + ' conv')
    if (e.sessions > 0)  metaParts.push(e.sessions + ' sess')

    div.innerHTML =
      '<div class="entry-head">' +
        '<div class="entry-ts">' + ft(e.ts) + '</div>' +
        (metaParts.length ? '<div class="entry-meta">' + metaParts.join(' &middot; ') + '</div>' : '') +
      '</div>' +
      '<div class="entry-text' + (e.pending ? ' pending' : '') + '">' +
        (e.pending ? '&hellip; generating' : (e.text || '(no response)').replace(/</g,'&lt;')) +
      '</div>' +
      '<div class="entry-context">' + (e.context || '').replace(/\n/g,'<br>').replace(/</g,'&lt;') + '</div>'
    el.appendChild(div)
  })
}

function triggerGen() {
  document.getElementById('gen-btn').disabled = true
  fetch('/generate', {method:'POST'}).catch(function(){})
}

function poll() {
  fetch('/api').then(function(r){return r.json()}).then(render).catch(function(){})
}
poll()
setInterval(poll, 4000)
</script>
</body>
</html>`

// ── HTTP server ───────────────────────────────────────────────────────────────

createServer(async (req, res) => {
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(apiData()))
    return
  }
  if (req.url === '/generate' && req.method === 'POST') {
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, message: 'generating...' }))
    doGenerate().catch(err => console.error('[daily] generate error:', err.message))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
}).listen(PORT, () => {
  console.log(`[daily] http://localhost:${PORT}`)
  console.log(`[daily] model: ${MODEL} @ ${HAILO_URL}`)
  console.log(`[daily] generates hourly · POST /generate to trigger manually`)
})

// ── Timer ─────────────────────────────────────────────────────────────────────

// Generate on boot with retry — if Ollama is busy at startup, try again after a short delay
// rather than waiting the full hour for the next cycle.
async function bootWithRetry(retryDelays = BOOT_RETRIES) {
  await doGenerate()
  const last = diary.at(-1)
  if (last?.pending && retryDelays.length > 0) {
    const [delay, ...rest] = retryDelays
    console.log(`[daily] boot entry pending — retry in ${delay / 60000}m (${rest.length} attempt${rest.length !== 1 ? 's' : ''} remaining)`)
    setTimeout(() => bootWithRetry(rest), delay)
  }
}

bootWithRetry()
setInterval(doGenerate, INTERVAL_MS)
