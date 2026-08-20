// narrator — the Pi speaks about itself
// Samples system vitals, asks the local LLM for one evocative sentence,
// writes to a rolling JSONL log, and serves a minimal dark viewer.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HAILO_URL    = 'http://localhost:8000'
const MODEL        = 'qwen2.5-instruct:1.5b'
const PORT         = 3031
const INTERVAL_MS  = 5 * 60 * 1000   // 5 minutes
const LOCAL_LLM_ENABLED = process.env.NARRATOR_ENABLE_LOCAL_LLM === '1'
const LOG_PATH     = path.join(__dirname, 'narrations.jsonl')
const MAX_STORED   = 50

// ─── System stats ────────────────────────────────────────────────────────────

async function getCpuPercent() {
  const read = () => {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]
    const nums = line.trim().split(/\s+/).slice(1).map(Number)
    const idle  = nums[3] + (nums[4] ?? 0)
    const total = nums.reduce((a, b) => a + b, 0)
    return { idle, total }
  }
  const a = read()
  await new Promise(r => setTimeout(r, 500))
  const b = read()
  const dt = b.total - a.total
  if (dt === 0) return 0
  return Math.round(((dt - (b.idle - a.idle)) / dt) * 100)
}

function getTemp() {
  try {
    const raw = readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()
    return Math.round(parseInt(raw, 10) / 1000)
  } catch { return null }
}

function getMemory() {
  const text = readFileSync('/proc/meminfo', 'utf8')
  const get = key => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return m ? parseInt(m[1], 10) : 0
  }
  const total = get('MemTotal')
  const avail = get('MemAvailable')
  const used  = total - avail
  return { used, total, pct: Math.round((used / total) * 100) }
}

function getDisk() {
  try {
    const out  = execSync('df / --output=size,used,avail,pcent --block-size=1M 2>/dev/null', { timeout: 3000 }).toString()
    const line = out.trim().split('\n').pop().trim()
    const p    = line.split(/\s+/)
    return { total: parseInt(p[0], 10), used: parseInt(p[1], 10), pct: parseInt(p[3], 10) }
  } catch { return null }
}

async function gatherStats() {
  const cpu  = await getCpuPercent()
  const temp = getTemp()
  const mem  = getMemory()
  const disk = getDisk()
  const load = os.loadavg()
  return { cpu, temp, mem, disk, load }
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

async function narrate(stats) {
  if (!LOCAL_LLM_ENABLED) return null
  const { cpu, temp, mem, disk, load } = stats
  const readings = [
    `CPU ${cpu}%`,
    temp  != null ? `temperature ${temp}°C` : null,
    `memory ${mem.pct}%`,
    disk  != null ? `disk ${disk.pct}%` : null,
    `1-min load ${load[0].toFixed(2)}`,
  ].filter(Boolean).join(', ')

  const prompt = `Telemetry: ${readings}.\nYou are this machine. One sentence, 12 words max, first person: express your state as physical sensation — warmth, hum, weight — not as percentages. Output the sentence only.`

  try {
    const r = await fetch(`${HAILO_URL}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: MODEL, prompt, stream: false }),
      signal:  AbortSignal.timeout(45_000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    return (data.response?.trim() ?? '').split('\n')[0].trim().slice(0, 100) || null
  } catch (err) {
    console.error('[narrator] LLM error:', err.message)
    return null
  }
}

// ─── Log ─────────────────────────────────────────────────────────────────────

function readAll() {
  if (!existsSync(LOG_PATH)) return []
  try {
    return readFileSync(LOG_PATH, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
  } catch { return [] }
}

function append(entry) {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  const all = readAll()
  if (all.length > MAX_STORED) {
    writeFileSync(LOG_PATH, all.slice(-MAX_STORED).map(JSON.stringify).join('\n') + '\n')
  }
}

// ─── HTML viewer ─────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>narrator</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;
  --fg:#ebebeb;
  --accent:#22c7c7;
  --mono:ui-monospace,'JetBrains Mono','Fira Code',monospace;
  --serif:Georgia,'Times New Roman',serif;
}
html,body{height:100%;background:var(--bg);color:var(--fg);
  font-family:var(--mono);-webkit-font-smoothing:antialiased;overflow:hidden}

#shell{display:flex;flex-direction:column;height:100vh}

/* header */
#hd{display:flex;align-items:center;justify-content:space-between;
  padding:20px 32px 0;flex-shrink:0}
.hl{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#3a3a3a}
.hr{font-size:11px;color:#2a2a2a;letter-spacing:.04em}
#cd{color:var(--accent);opacity:.6}

/* main */
#mn{flex:1;display:flex;flex-direction:column;justify-content:center;
  align-items:center;padding:48px 10vw;overflow:hidden;gap:0}

#lt{font-family:var(--serif);
  font-size:clamp(1.25rem,3vw,1.9rem);
  line-height:1.65;text-align:center;color:var(--fg);
  letter-spacing:.01em;
  opacity:0;transform:translateY(10px);
  transition:opacity 1s ease,transform 1s ease;
  max-width:680px}
#lt.vis{opacity:1;transform:translateY(0)}
#lt.fresh{animation:gl 3.5s ease-out forwards}
@keyframes gl{
  0%{text-shadow:0 0 60px rgba(34,199,199,.5),0 0 120px rgba(34,199,199,.22)}
  100%{text-shadow:0 0 40px rgba(34,199,199,.08),0 0 80px rgba(34,199,199,.04)}
}

#dot{width:5px;height:5px;border-radius:50%;
  background:var(--accent);opacity:.22;
  animation:br 3.2s ease-in-out infinite;
  margin-top:22px;flex-shrink:0}
@keyframes br{
  0%,100%{opacity:.15;transform:scale(1)}
  50%{opacity:.5;transform:scale(1.4)}
}

#sep{width:36px;height:1px;background:rgba(255,255,255,.05);
  margin:28px auto 18px;flex-shrink:0;display:none}

#hs{display:flex;flex-direction:column;align-items:center;
  gap:11px;max-width:580px;width:100%;overflow:hidden}
.he{font-family:var(--serif);
  font-size:clamp(.7rem,1.5vw,.85rem);
  text-align:center;line-height:1.55;color:var(--fg)}
.he:nth-child(1){opacity:.24}
.he:nth-child(2){opacity:.12}
.he:nth-child(3){opacity:.06}
.he:nth-child(n+4){opacity:.02}

#em{display:none;font-size:11px;color:#252525;letter-spacing:.1em;text-transform:uppercase}
#em.vis{display:block}

/* footer */
#ft{padding:0 32px 20px;display:flex;align-items:flex-end;
  justify-content:space-between;flex-shrink:0;min-height:40px}
.fs{font-size:10px;color:#1e1e1e;letter-spacing:.06em;line-height:1.9}
.fts{font-size:10px;color:#1e1e1e;letter-spacing:.04em;text-align:right}
</style>
</head>
<body>
<div id="shell">
  <div id="hd">
    <div class="hl">narrator<span style="color:#1a1a1a;margin:0 8px">/</span><span id="hn" style="color:#2e2e2e">—</span></div>
    <div class="hr">next in <span id="cd">—:——</span></div>
  </div>
  <div id="mn">
    <div id="lt"></div>
    <div id="dot"></div>
    <div id="sep"></div>
    <div id="hs"></div>
    <div id="em">waiting for first narration…</div>
  </div>
  <div id="ft">
    <div class="fs" id="fst"></div>
    <div class="fts" id="fts"></div>
  </div>
</div>
<script>
var IMS = ${INTERVAL_MS};
var nextAt = Date.now() + IMS;
var lastTs = 0;
var data   = [];

function fmtTs(ts) {
  return new Date(ts).toLocaleTimeString('en-US',
    {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
function fmtStats(s) {
  if (!s) return '';
  var p = [];
  if (s.cpu  != null) p.push('cpu '  + s.cpu + '%');
  if (s.temp != null) p.push(s.temp  + '\\u00b0C');
  if (s.mem  && s.mem.pct  != null) p.push('mem '  + s.mem.pct  + '%');
  if (s.disk && s.disk.pct != null) p.push('disk ' + s.disk.pct + '%');
  if (s.load && s.load[0]  != null) p.push('load ' + s.load[0].toFixed(2));
  return p.join('  \\u00b7  ');
}

function render(fresh) {
  var lEl  = document.getElementById('lt');
  var hEl  = document.getElementById('hs');
  var eEl  = document.getElementById('em');
  var sEl  = document.getElementById('sep');
  var dEl  = document.getElementById('dot');
  var fstE = document.getElementById('fst');
  var ftsE = document.getElementById('fts');

  if (!data.length) {
    lEl.classList.remove('vis');
    eEl.classList.add('vis');
    dEl.style.display = 'block';
    sEl.style.display = 'none';
    return;
  }
  eEl.classList.remove('vis');

  var latest = data[0];
  var rest   = data.slice(1, 5);

  lEl.textContent = latest.text;
  lEl.classList.add('vis');
  if (fresh) {
    lEl.classList.remove('fresh');
    void lEl.offsetWidth;
    lEl.classList.add('fresh');
  }

  hEl.innerHTML = '';
  rest.forEach(function(n) {
    var d = document.createElement('div');
    d.className   = 'he';
    d.textContent = n.text;
    hEl.appendChild(d);
  });

  if (rest.length) { sEl.style.display='block'; dEl.style.display='none'; }
  else             { sEl.style.display='none';  dEl.style.display='block'; }

  fstE.textContent = fmtStats(latest.stats);
  ftsE.textContent = fmtTs(latest.ts);
}

function tick() {
  var rem = Math.max(0, nextAt - Date.now());
  var m   = Math.floor(rem / 60000);
  var s   = Math.floor((rem % 60000) / 1000);
  document.getElementById('cd').textContent = m + ':' + (s < 10 ? '0' : '') + s;
}

function poll() {
  fetch('/api').then(function(r){return r.json();}).then(function(d){
    if (!d.length) { render(false); return; }
    var newest = d[0].ts;
    var isNew  = newest !== lastTs && lastTs !== 0;
    if (newest !== lastTs) {
      data   = d;
      lastTs = newest;
      if (isNew) nextAt = Date.now() + IMS;
      render(isNew);
    }
  }).catch(function(){});
}

document.getElementById('hn').textContent = location.hostname;
poll();
setInterval(poll,  10000);
setInterval(tick,  1000);
tick();
</script>
</body>
</html>`

// ─── Run loop ─────────────────────────────────────────────────────────────────

async function run() {
  const t = new Date().toISOString().slice(11, 19)
  console.log(`[${t}] sampling...`)

  let stats
  try {
    stats = await gatherStats()
    console.log(`[${t}] cpu=${stats.cpu}% temp=${stats.temp}°C mem=${stats.mem.pct}% load=${stats.load[0].toFixed(2)}`)
  } catch (err) {
    console.error(`[${t}] stats error:`, err.message)
    return
  }

  const text = await narrate(stats)
  if (text) {
    append({ ts: Date.now(), text, stats })
    console.log(`[${t}] → ${text}`)
  } else {
    console.log(`[${t}] LLM unavailable — no narration`)
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/api' || url === '/api/narrations') {
    const entries = readAll().slice(-20).reverse()
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })
    res.end(JSON.stringify(entries))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
  }
}).listen(PORT, () => {
  console.log(`[narrator] http://localhost:${PORT}`)
  console.log(`[narrator] interval: ${INTERVAL_MS / 60000}min  log: ${LOG_PATH}`)
})

// Fire immediately, then on interval
run()
setInterval(run, INTERVAL_MS)
