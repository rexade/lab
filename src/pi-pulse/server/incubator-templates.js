// Pure naming, role, and prompt templates for incubator projects.
// No filesystem access here: callers decide where the output lands.
import { shellQuote } from './util.js'

export function slugifyProjectName(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
  return slug || 'incubator-' + new Date().toISOString().slice(0, 10)
}

const INCUBATOR_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'be', 'build', 'can', 'create', 'demo', 'for',
  'from', 'give', 'ha', 'i', 'in', 'install', 'it', 'make', 'me', 'my', 'of', 'one',
  'please', 'show', 'showcase', 'small', 'that', 'the', 'this', 'to', 'tool', 'u', 'use',
  'using', 'want', 'with', 'would',
])

function titleCaseWords(words) {
  return words
    .filter(Boolean)
    .map(word => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ')
}

export function normalizedIncubatorTitle(value) {
  const words = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
  return words.length ? titleCaseWords(words) : null
}

function explicitIncubatorTitle(text) {
  const match = String(text || '').match(/\b(?:called|named|title(?:d)?|name it|kalla den|som heter)\s+["']?([a-z0-9][a-z0-9 _-]{1,48})/i)
  if (!match) return null
  return match[1].replace(/["'.:;!?].*$/, '').trim()
}

export function suggestedIncubatorTitle(idea) {
  const text = String(idea || '').trim()
  const explicit = normalizedIncubatorTitle(explicitIncubatorTitle(text))
  if (explicit) return explicit

  const lower = text.toLowerCase()
  if (/\btaste\b|\bpreference\b|\bpicker\b/.test(lower)) return 'Taste Trainer'
  if (/\bpi[-\s]?pulse\b/.test(lower) && (/\breport\b|\binvestigat|\baudit\b/.test(lower))) return 'Pulse Audit'
  if (/\blauncher\b/.test(lower) && /\b(tv|android|nvidia|shield)\b/.test(lower)) return 'Shield Launcher'
  if (/\bcamera\b/.test(lower) && /\bwindow\b/.test(lower)) return 'Window Camera'
  if (/\bpoem\b|\bpoetry\b|\bdikt\b/.test(lower)) return 'Poem Machine'
  if (/\bartifact\b/.test(lower) && (/\binteractive\b|\bdigital\b/.test(lower))) return 'Interactive Artifact'

  const words = lower
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(?:i want to|i would like to|can you|could you|please|jag skulle vilja|kan du)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !INCUBATOR_TITLE_STOP_WORDS.has(word))

  const typeWord = words.find(word => ['game', 'launcher', 'report', 'audit', 'trainer', 'camera', 'dashboard', 'tracker', 'editor', 'generator', 'simulator'].includes(word))
  const subjectWords = words.filter(word => word !== typeWord).slice(0, typeWord ? 2 : 3)
  const titleWords = typeWord ? [...subjectWords, typeWord] : subjectWords
  return titleCaseWords(titleWords.length ? titleWords : ['New', 'Incubator'])
}

export function inferIncubatorRole(value = {}) {
  const text = [
    value.id,
    value.project,
    value.displayName,
    value.incubatorTitle,
    value.phase,
    value.current_focus,
    value.notes,
  ].filter(Boolean).join(' ').toLowerCase()
  if (/\btaste\b|\bpreference\b|\bpicker\b|\btrain\b/.test(text)) return 'signal-feeder'
  if (/\baudit\b|\breport\b|\binvestigat/.test(text) && /\bpi[-\s]?pulse\b|\bincubator\b/.test(text)) return 'signal-feeder'
  if (/\bimpossible\b|\bbullshit\b|\bbenchmark\b|\bhard evidence\b|\bcompletion rate\b|\bcrashes\b|\bruntime\b|\bscheduler\b|\bpacking\b|\branking\b|\banomaly\b|\bcompression\b|\bocr\b|\bdatabase\b|\bquery engine\b/.test(text)) return 'signal-feeder'
  return 'product'
}

export function incubatorQualityInstructions(seedIdea = '', incubatorRole = 'product') {
  const seed = seedIdea ? `
Seed idea:
${seedIdea}
` : ''
  const signalFeeder = incubatorRole === 'signal-feeder'
  const roleBlock = signalFeeder ? `
Incubator role: signal feeder for Pi Pulse.
- Treat the app as an instrument that should produce reusable learning for future incubators, not only as a standalone product.
- Keep the user-facing workflow small enough to generate clear signal.
- Prefer measurable outcomes, before/after comparisons, preference labels, or failure patterns over vague impressions.
- Every run must add these extra fields to reports/RUN_LOG.md when there is a lesson:
**Pi Pulse lesson:** [one portable lesson future incubators should reuse]
**Learning evidence:** [metric, user observation, screenshot, test, or app-evidence result]
**Applies to future apps:** yes/no - [scope]
` : `
Incubator role: product app.
- Optimize for a real user's first-screen clarity, main workflow, and durable product quality.
`
  return `${seed}${roleBlock}
Quality contract:
- Read reports/USER_FEEDBACK.md if present and convert the latest note into one acceptance check.
- Treat runner success as process health only; product quality needs its own gate.
- Verify with command/test output, file inspection, screenshot/browser/manual UI check, or an explicit not-applicable reason.
- For static, React, or web app projects, PASS requires app runtime evidence under reports/evidence/run-[number]/ or a clear not-applicable reason for non-UI work.
- For 4.5+ UI quality, register window.__PI_PULSE_APP__ with a visible primaryAction.selector, a machine-checkable expect success contract, and preferably reset/snapshot hooks.
- If app evidence is missing, blank, degraded, lacks a semantic success contract, or has runtime errors, write NEEDS-EVIDENCE or FAIL instead of PASS.
- If evidence is thin, write NEEDS-EVIDENCE. If steering is missed or the app/main flow breaks, write FAIL.
- Do not make manual/human validation the required next move unless the user explicitly asked for it. If a human-feel question remains, create a better automated proxy, A/B receipt, screenshot proof, replay, benchmark slice, or semantic contract in the next autonomous run.
- Research runs must infer a defensible north star themselves from the current artifact, prior steering, market/common product taste, and evidence. Do not ask the user to define the north star; state it, explain the tradeoff, and choose the next measurable bet.
- Every run must declare first-class strategy fields: North star, Strategy, Why this run type, Expected quality delta, Actual quality delta, and Plateau/regression verdict. These fields drive future loop policy, so do not bury them in prose.
- Negative feedback triggers recovery mode: if the latest user note says the app is ugly, confusing, broken, crashed, insufficient, degraded, not working, or worse than an existing alternative, do not add features. Fix the smallest user-visible failure in the first screen or main workflow, simplify/delete weak material, and do not write PASS unless the complaint path is verified.

Append these fields to reports/RUN_LOG.md every run:
**North star:** [the strongest inferred product/benchmark/taste target for this project]
**Strategy:** [one sentence: what this run is trying to prove or improve]
**Why this run type:** [why CREATE/MUTATE/RESEARCH/HARVEST is the right move now]
**Expected quality delta:** [what should improve, with metric/observable if possible]
**Actual quality delta:** [what actually moved, or "none measured"]
**Plateau/regression verdict:** IMPROVED | PLATEAU | REGRESSION | UNCLEAR - [short reason]
**Recovery mode:** yes/no - [complaint addressed, or "not triggered"]
**Acceptance check:** [one concrete criterion]
**Evidence:** [commands, files, screenshots/manual checks, or explicit not-applicable reason]
**App evidence:** [reports/evidence/run-[number]/summary.md, or not applicable]
**Quality gate:** PASS | NEEDS-EVIDENCE | FAIL
**Quality rating:** [0-5]/5
**Evidence confidence:** [0-5]/5
**Risk / regression:** [what got worse, is unverified, or could break]
**Next move:** [one small follow-up]
**Needs human:** none | [the one action no run can do, such as credentials or a service restart]
`
}

export function promptForIncubatorRunType(project, runType, seedIdea = '', incubatorRole = 'product') {
  const normalized = String(runType || 'mutate').toLowerCase()
  const quality = incubatorQualityInstructions(seedIdea, incubatorRole)
  if (normalized === 'create') {
    return `Create the first tiny local prototype for ${project}.

Rules:
- Build the smallest usable version first.
- Keep it local and simple.
- Prefer plain files and clear state over backend complexity unless the idea truly needs it.
- Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
  }
  if (normalized === 'research') {
    return `Research the next best move for ${project}.

Use the repo, reports/RUN_LOG.md, reports/RECENT_RUNS.md, and reports/USER_FEEDBACK.md if present. Identify what is unclear, what should be tested next, and what would make the project more useful. Do not modify source files. Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
  }
  return `Improve ${project} by one focused step.

Before changing anything, read reports/USER_FEEDBACK.md if it exists and treat the latest notes as steering input.

Choose one useful mutation that makes the project more real, testable, or personally aligned. Append a concise summary plus the quality fields to reports/RUN_LOG.md.
${quality}`
}

export function safeRunTypeName(runType) {
  return String(runType || 'mutate').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'mutate'
}

// The launcher is the per-slot entrypoint (status.launcher/runScript). It only
// pins the status path; agent choice is read from status.json by the runner.
export function incubatorLauncherScript({ runnerScript, statusPath }) {
  const defaultStatus = String(statusPath).replace(/[\\"$`]/g, '\\$&')
  return `#!/usr/bin/env bash
# Generated by Pi Pulse (writeIncubatorLauncher). Rewritten automatically when stale.
set -euo pipefail

exec bash ${shellQuote(runnerScript)} "\${1:-${defaultStatus}}" "\${2:-}"
`
}
