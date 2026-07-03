// snapshot.js — ghost-trio incubator snapshot
//
// The quartet runs continuously. This script is the moment of looking.
// Each invocation freezes a moment of machine awareness:
//   - what are the instruments seeing right now?
//   - how many convergences in the last 24h?
//   - what was the last haiku the machine wrote about itself?
//
// Writes one entry to RUN_LOG.md + updates projects/ghost-trio/status.json.
// Called by snapshot.sh (Pi Pulse incubator run button).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const CONV_LOG   = path.join(__dirname, 'convergences.jsonl')
const RUN_LOG    = path.join(__dirname, 'RUN_LOG.md')
const STATUS_OUT = path.join(__dirname, '../../projects/ghost-trio/status.json')

const API = {
  ghost:       'http://127.0.0.1:3032/api',
  whisper:     'http://127.0.0.1:3033/api',
  oracle:      'http://127.0.0.1:3034/api',
  convergence: 'http://127.0.0.1:3036/api',
}

async function tryGet(url) {
  try {
    const ac = new AbortController()
    const t  = setTimeout(() => ac.abort(), 2000)
    const r  = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    return r.ok ? r.json() : null
  } catch { return null }
}

function loadConvergences() {
  if (!existsSync(CONV_LOG)) return []
  try {
    return readFileSync(CONV_LOG, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l))
  } catch { return [] }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_OUT, 'utf8')) }
  catch { return { runCount: 0 } }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

async function main() {
  const prevStatus = readStatus()
  const runNum     = (prevStatus.runCount ?? 0) + 1

  // Parallel fetch — quartet may be offline, that's fine
  const [ghost, whisper, oracle, conv] = await Promise.all([
    tryGet(API.ghost),
    tryGet(API.whisper),
    tryGet(API.oracle),
    tryGet(API.convergence),
  ])

  const online = {
    ghost:       !!ghost,
    whisper:     !!whisper,
    oracle:      !!oracle,
    convergence: !!conv,
  }
  const onlineNames  = Object.entries(online).filter(([, v]) => v).map(([k]) => k)
  const offlineNames = Object.entries(online).filter(([, v]) => !v).map(([k]) => k)

  // Convergence history
  const convLog   = loadConvergences()
  const since24h  = Date.now() - 86_400_000
  const recent24  = convLog.filter(e => e.ts >= since24h)
  const withHaiku = [...convLog].reverse().find(e => e.haiku)
  const lastHaiku = withHaiku?.haiku ?? null

  // Whisper snapshot
  const latestClass  = whisper?.class ?? null
  const latestScore  = typeof whisper?.score === 'number' ? whisper.score.toFixed(2) : null
  const recentWhisperEvs = (whisper?.events ?? []).slice(0, 3)

  // Ghost snapshot
  const ghostEvents = (ghost?.events ?? []).slice(0, 2)

  // Oracle snapshot
  const closedSessions = (oracle?.sessions ?? []).filter(s => s.endTs)
  const lastSession    = closedSessions.at(-1)

  // ── Build run log entry ──────────────────────────────────────────────────────

  const statusLine = onlineNames.length > 0
    ? `Online: ${onlineNames.join(', ')}.`
    : 'All instruments offline.'

  const convLine = recent24.length > 0
    ? `${recent24.length} convergence${recent24.length === 1 ? '' : 's'} in past 24h (${convLog.length} total).`
    : `No convergences in past 24h (${convLog.length} total).`

  const whisperLine = whisper
    ? (latestClass && latestScore
        ? `Whisper: ${latestClass}, novelty ${latestScore}.${recentWhisperEvs.length ? ' Events: ' + recentWhisperEvs.map(e => e.class).join(', ') + '.' : ''}`
        : 'Whisper: warming baseline.')
    : 'Whisper: offline.'

  const ghostLine = ghost
    ? (ghostEvents.length
        ? `Ghost: ${ghostEvents.map(e => e.msg).join('; ')}.`
        : 'Ghost: quiet — no threshold crossings.')
    : 'Ghost: offline.'

  const oracleLine = oracle
    ? (lastSession
        ? `Oracle: last session ${((lastSession.duration ?? 0) / 1000).toFixed(0)}s, class ${lastSession.class ?? '?'}.`
        : 'Oracle: no closed sessions yet.')
    : 'Oracle: offline.'

  const haikuBlock = lastHaiku
    ? `convergence on ${new Date(withHaiku.ts).toISOString().slice(0, 10)}, sources: ${withHaiku.sources.join('+')}\n> ${lastHaiku.replace(/\n/g, '\n> ')}`
    : 'none yet — requires ≥2 instruments online and a convergence event.'

  const nextMove = onlineNames.length < 2
    ? 'Start instruments: `node ghost.js`, `node whisper.js`, `node oracle.js`, `node convergence.js` — then trigger an Ollama inference.'
    : recent24.length === 0
      ? 'Trigger Ollama inference to provoke a convergence. Check ensemble at :3035.'
      : `Let the quartet observe. ${recent24.length} convergence${recent24.length === 1 ? '' : 's'} today — check :3036 for haiku.`

  const entry = [
    `## Run ${runNum} — ${today()} — RESEARCH`,
    ``,
    `**What I found:** ${statusLine} ${convLine}`,
    `**Instruments:** ${ghostLine} ${whisperLine} ${oracleLine}`,
    `**Last haiku:** ${haikuBlock}`,
    `**Next move:** ${nextMove}`,
  ].join('\n')

  // Append to RUN_LOG.md (create with header if first run)
  if (!existsSync(RUN_LOG)) {
    writeFileSync(RUN_LOG,
      '# Ghost Trio — Snapshot Log\n\n' +
      '*Continuous observational quartet. Each snapshot freezes a moment of machine awareness.*\n\n'
    )
  }
  appendFileSync(RUN_LOG, '---\n\n' + entry + '\n')

  // ── Update projects/ghost-trio/status.json ───────────────────────────────────

  const notesParts = [convLine]
  if (lastHaiku) notesParts.push(`Last haiku: "${lastHaiku.split('\n')[0]}"`)
  if (offlineNames.length) notesParts.push(`Offline: ${offlineNames.join(', ')}.`)

  const newStatus = {
    project:     'ghost-trio',
    status:      onlineNames.length > 0 ? 'active' : 'offline',
    phase:       'observing',
    repo:        __dirname,
    runLog:      RUN_LOG,
    runScript:   path.join(__dirname, 'snapshot.sh'),
    runCount:    runNum,
    lastRun:     today(),
    lastRunType: 'RESEARCH',
    notes:       notesParts.join(' '),
  }

  writeFileSync(STATUS_OUT, JSON.stringify(newStatus, null, 2) + '\n')

  console.log(`[snapshot] Run ${runNum} · ${today()}`)
  console.log(`[snapshot] ${statusLine} ${convLine}`)
  if (lastHaiku) console.log(`[snapshot] haiku: "${lastHaiku.split('\n')[0]}"`)
}

main().catch(err => { console.error(err.message); process.exit(1) })
