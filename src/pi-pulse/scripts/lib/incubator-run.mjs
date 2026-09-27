#!/usr/bin/env node
// Node side of scripts/run-incubator.sh. Each subcommand is one step of a run;
// the shell script owns process control, this file owns JSON and RUN_LOG.md
// parsing so the two agents (Codex, Claude) share one implementation.
//
//   config          <status.json>                         -> KEY=value lines
//   recent-runs     <RUN_LOG.md> <RECENT_RUNS.md>
//   latest-note     <USER_FEEDBACK.md>                    -> the newest steering note
//   repair-block    <status.json>                         -> prompt block or ''
//   quality-fallback <log> <run#> <stdoutFile> <appEvidenceJson> <exitCode>
//   update-status   <status.json> <runType> <today> <exitCode> <run#> <log> <recoveryRequired> <appEvidenceJson> <agent> <claudeModel>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestSteeringNote, resolveClaudeModel, resolveClaudePermissionMode, rotationFor } from '../../server-core.js'

const [command, ...args] = process.argv.slice(2)

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

// The runner appends `## Run N - DATE - TYPE`; agents may append their own
// block with the same number. The last matching section is authoritative.
function latestRunBlock(text, runNumber) {
  const sections = text.split(/(?=^## Run \d+)/m).filter(section => section.trimStart().startsWith(`## Run ${runNumber} `))
  return sections[sections.length - 1] || ''
}

function latestRunFields(logPath, runNumber) {
  try {
    const block = latestRunBlock(fs.readFileSync(logPath, 'utf8'), runNumber)
    const fields = {}
    for (const line of block.split('\n')) {
      const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/)
      if (match) fields[match[1].trim()] = match[2].trim()
    }
    return fields
  } catch { return {} }
}

function readEvidence(filePath) {
  if (!filePath) return null
  try { return readJson(filePath) } catch { return null }
}

function gate(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[_.\s]+/g, '-')
  if (raw.startsWith('PASS')) return 'PASS'
  if (raw.startsWith('FAIL')) return 'FAIL'
  if (raw.includes('NEEDS-EVIDENCE') || raw.includes('NEED-EVIDENCE') || raw.includes('INSUFFICIENT-EVIDENCE')) return 'NEEDS-EVIDENCE'
  return null
}

function score(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/)
  return match ? Math.max(0, Math.min(5, Number(match[1]))) : null
}

// Pi Pulse reads status.json while runs are in flight; a torn write would read
// as corrupt and pause the slot's schedule, so replace it atomically.
function writeJsonAtomic(filePath, value) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

// Recovery mode keys off the newest note. Files that predate `## <timestamp>`
// sections are read as one legacy note.
export function feedbackForRecovery(text = '') {
  const note = latestSteeringNote(text)
  if (note) return note.slice(-1200)
  return /^## (?:Seed\s*$|\d{4}-\d{2}-\d{2})/im.test(text) ? '' : String(text).trim().slice(-1200)
}

function resolveAgent(status) {
  const requested = process.env.PI_PULSE_AGENT
  if (requested === 'codex' || requested === 'claude') return requested
  return status.runner === 'claude' ? 'claude' : 'codex'
}

function bypassFor(agent) {
  // Autonomous runs never bypass the sandbox, whatever the service env says.
  if (process.env.PI_PULSE_SCHEDULED_RUN === '1') return ''
  const flag = agent === 'claude' ? process.env.CLAUDE_BYPASS : process.env.CODEX_BYPASS
  return flag === '1' ? '1' : ''
}

const commands = {
  config([statusPath]) {
    let status
    try {
      status = readJson(statusPath)
    } catch (err) {
      console.error(`[incubator] cannot read status file ${statusPath}: ${err.message}`)
      process.exit(2)
    }
    const missing = ['project', 'repo', 'runLog'].filter(key => !status[key])
    if (missing.length) {
      console.error(`[incubator] ${statusPath} is missing required field(s): ${missing.join(', ')}`)
      process.exit(2)
    }
    const agent = resolveAgent(status)
    const runTypes = rotationFor(status)
    const godot = status.godotAi || {}
    const values = {
      agent,
      project: status.project,
      repo: status.repo,
      runLog: status.runLog,
      promptDir: status.promptDir || path.join(status.repo, 'prompts'),
      recentRuns: status.recentRuns || path.join(path.dirname(status.runLog), 'RECENT_RUNS.md'),
      feedbackPath: status.feedbackPath || path.join(status.repo, 'reports', 'USER_FEEDBACK.md'),
      runTypes: runTypes.join(' '),
      runCount: Math.max(0, Math.floor(Number(status.runCount) || 0)),
      bypass: bypassFor(agent),
      codexModel: status.codexModel || process.env.CODEX_MODEL || '',
      claudeModel: agent === 'claude' ? resolveClaudeModel(status.claudeModel) : '',
      claudePermissionMode: agent === 'claude' ? resolveClaudePermissionMode(status.claudePermissionMode) : '',
      godotAiEnabled: godot.enabled ? '1' : '',
      godotAiMcpUrl: godot.mcpUrl || '',
      godotAiStatusUrl: godot.statusUrl || 'http://127.0.0.1:8020/godot-ai/status',
      godotAiVersion: godot.serverVersion || '',
      godotAiLog: godot.log || path.join(status.repo, 'reports', 'godot-ai', 'editor.log'),
    }
    for (const [key, value] of Object.entries(values)) console.log(`${key}=${oneLine(value)}`)
  },

  'latest-note'([feedbackPath]) {
    let text = ''
    try { text = fs.readFileSync(feedbackPath, 'utf8') } catch {}
    const note = feedbackForRecovery(text)
    if (note) console.log(note)
  },

  'recent-runs'([logPath, recentPath]) {
    let text = ''
    try { text = fs.readFileSync(logPath, 'utf8') } catch {}
    const runs = text.split(/(?=^## Run \d)/m).map(s => s.trim()).filter(s => s.startsWith('## Run'))
    const recent = runs.slice(-4)
    fs.mkdirSync(path.dirname(recentPath), { recursive: true })
    fs.writeFileSync(recentPath, [
      '# Recent Runs\n\n',
      '*Auto-generated. Last 4 runs. Full history in RUN_LOG.md.*\n\n---\n\n',
      recent.length ? recent.join('\n\n---\n\n') : '*(no runs yet)*\n',
    ].join(''))
  },

  'repair-block'([statusPath]) {
    try {
      const status = readJson(statusPath)
      const gate = String(status.lastAppEvidenceGate || '').toUpperCase()
      const mode = status.lastAppEvidenceMode || null
      const topTier = status.lastAppEvidenceTopTier === true
      const primary = status.lastAppEvidencePrimaryAction || {}
      const success = status.lastAppEvidenceSemanticSuccess || {}
      const summary = status.lastAppEvidenceSummary || ''
      const evidencePath = status.lastAppEvidencePath || ''
      const evidenceUnavailable = mode === 'unavailable'
      const applies = gate && !evidenceUnavailable && (gate !== 'PASS' || mode === 'degraded' || !topTier)
      if (!applies) return

      const lines = [
        '',
        'APP EVIDENCE REPAIR REQUIRED:',
        `- Previous app evidence gate: ${gate || 'unknown'}.`,
        mode ? `- Previous evidence mode: ${mode}; top-tier eligible: ${topTier ? 'yes' : 'no'}.` : null,
        evidencePath ? `- Evidence summary: ${evidencePath}.` : null,
        summary ? `- Evidence note: ${summary.slice(0, 500)}` : null,
        primary?.source ? `- Previous primary action source: ${primary.source}; selector: ${primary.selector || 'none'}; changed: ${primary.changed ? 'yes' : 'no'}; visible/available: ${primary.available ? 'yes' : 'no'}.` : null,
        success?.available ? `- Previous semantic success contract: ${success.passed ? 'passed' : 'failed'}.` : '- Previous semantic success contract: missing.',
        '- Before adding features, fix the app evidence failure/degraded state.',
        '- For web/static/React apps, register window.__PI_PULSE_APP__ with a visible primaryAction.selector, a machine-checkable expect success contract, and reset/snapshot where practical.',
        '- If a hidden or secondary control was selected as primary, make the real first user action explicit with data-primary-action and keep hidden/debug controls out of the primary path.',
        '- If contrast/readability feedback exists, fix visible color contrast before tuning content or adding UI.',
        '- Do not claim Quality gate: PASS unless app evidence passes. Do not claim 4.5+ unless top-tier eligible semantic evidence passes.',
      ].filter(Boolean)
      console.log(lines.join('\n'))
    } catch {}
  },

  // Agents sometimes skip the required quality fields; append a conservative
  // block so the UI and scheduler never read a missing gate as success.
  'quality-fallback'([logPath, runNumber, stdoutFile, appEvidencePath, exitCode]) {
    try {
      const text = fs.readFileSync(logPath, 'utf8')
      const block = latestRunBlock(text, runNumber)
      if (!block || /^\*\*Quality gate:\*\*/m.test(block)) return
      const evidence = readEvidence(appEvidencePath)
      const evidenceGate = String(evidence?.gate || '').toUpperCase()
      const fallbackGate = exitCode === '0'
        ? evidenceGate === 'FAIL' ? 'FAIL' : 'NEEDS-EVIDENCE'
        : 'FAIL'
      const rating = fallbackGate === 'FAIL' ? '2/5' : evidenceGate === 'PASS' ? '3/5' : '1/5'
      const confidence = evidence ? (evidenceGate === 'PASS' ? '3/5' : '4/5') : '1/5'
      const appEvidenceLine = evidence?.summaryMdPath || evidence?.summaryPath || appEvidencePath || 'not available'
      const risk = fallbackGate === 'FAIL'
        ? 'Runner fallback found missing quality fields and app evidence failed or the runner failed.'
        : 'Runner fallback found missing quality fields; product quality cannot be trusted until the next run reports acceptance evidence.'
      fs.appendFileSync(logPath, [
        '',
        '**Acceptance check:** Runner fallback - required quality fields were missing from this run summary.',
        `**Evidence:** Full stdout saved to ${stdoutFile}; app evidence: ${appEvidenceLine}`,
        '**North star:** UNCLEAR - runner fallback could not read a first-class north star.',
        '**Strategy:** Repair the missing run contract before trusting product-quality claims.',
        '**Why this run type:** Fallback generated after the selected runner omitted required fields.',
        '**Expected quality delta:** Restore measurable run strategy and evidence fields.',
        '**Actual quality delta:** none measured - required fields were missing.',
        '**Plateau/regression verdict:** UNCLEAR - missing strategy and quality fields.',
        `**Quality gate:** ${fallbackGate}`,
        `**Quality rating:** ${rating}`,
        `**Evidence confidence:** ${confidence}`,
        `**Risk / regression:** ${risk}`,
        '**Next move:** Run a focused mutate pass that addresses the app evidence failure and writes the required quality fields.',
        '',
      ].join('\n'))
    } catch (err) {
      console.error(`[incubator] warning: could not append missing quality fallback: ${err.message}`)
    }
  },

  // Process health (lastRunnerStatus) and product quality (lastQualityGate) are
  // recorded separately; app evidence can only lower a self-reported gate/rating.
  'update-status'([statusPath, runType, today, exitCode, runNumber, logPath, recoveryRequired, appEvidencePath, agent, model]) {
    try {
      const status = readJson(statusPath)
      const runnerOk = exitCode === '0'
      const fields = latestRunFields(logPath, runNumber)
      const appEvidence = readEvidence(appEvidencePath)
      const appEvidenceGate = gate(appEvidence?.gate)
      const appEvidenceApplies = !!appEvidence && appEvidence.appType && appEvidence.appType !== 'unknown'
      let qualityGate = runnerOk ? (gate(fields['Quality gate']) || 'NEEDS-EVIDENCE') : 'FAIL'
      if (runnerOk && appEvidenceApplies && appEvidenceGate === 'FAIL') qualityGate = 'FAIL'
      if (runnerOk && appEvidenceApplies && qualityGate === 'PASS' && appEvidenceGate !== 'PASS') qualityGate = 'NEEDS-EVIDENCE'
      status.runner = status.runner || agent
      status.runCount = Number(runNumber)
      status.lastRun = today
      status.lastRunType = runType.toUpperCase()
      status.lastRunnerStatus = runnerOk ? 'ok' : 'failed'
      status.lastQualityGate = qualityGate
      status.lastQualityRating = score(fields['Quality rating'])
      if (status.lastQualityRating != null && appEvidenceApplies && appEvidenceGate !== 'PASS') {
        status.lastQualityRating = Math.min(status.lastQualityRating, appEvidenceGate === 'FAIL' ? 2 : 3)
      }
      if (status.lastQualityRating != null && appEvidenceApplies && appEvidenceGate === 'PASS' && appEvidence?.topTierEligible !== true) {
        status.lastQualityRating = Math.min(status.lastQualityRating, 4)
      }
      status.lastEvidenceConfidence = score(fields['Evidence confidence'])
      status.lastQualitySummary = (fields['Evidence'] || fields['Acceptance check'] || fields['Risk / regression'] || (runnerOk ? 'Latest run did not report a quality gate.' : fields['Failure']) || '').slice(0, 360) || null
      status.lastNorthStar = (fields['North star'] || '').slice(0, 500) || null
      status.lastRunStrategy = (fields['Strategy'] || '').slice(0, 500) || null
      status.lastWhyRunType = (fields['Why this run type'] || '').slice(0, 500) || null
      status.lastExpectedQualityDelta = (fields['Expected quality delta'] || '').slice(0, 500) || null
      status.lastActualQualityDelta = (fields['Actual quality delta'] || '').slice(0, 500) || null
      status.lastPlateauRegressionVerdict = (fields['Plateau/regression verdict'] || '').slice(0, 300) || null
      delete status.lastNeedsHuman
      status.lastRecoveryRequired = recoveryRequired === '1'
      status.lastRecoveryMode = fields['Recovery mode'] || (status.lastRecoveryRequired ? 'yes - negative feedback trigger' : null)
      status.lastAppEvidencePath = appEvidence?.summaryMdPath || appEvidence?.summaryPath || null
      status.lastAppEvidenceGate = appEvidenceGate
      status.lastAppEvidenceTopTier = appEvidence?.topTierEligible === true
      status.lastAppEvidenceMode = appEvidence?.evidenceMode || null
      status.lastAppEvidencePrimaryAction = appEvidence?.primaryAction || null
      status.lastAppEvidenceSemanticSuccess = appEvidence?.semanticSuccess || null
      status.lastAppEvidenceSummary = appEvidence?.notes?.join(' ').slice(0, 360) || null
      status.lastRunStatus = runnerOk ? (qualityGate === 'PASS' ? 'ok' : qualityGate === 'FAIL' ? 'quality-failed' : 'needs-evidence') : 'failed'
      if (agent === 'claude') {
        if (model) status.claudeModel = model
        else delete status.claudeModel
      }
      writeJsonAtomic(statusPath, status)
    } catch (err) {
      console.error(`[${agent || 'incubator'}-incubator] warning: could not update status: ${err.message}`)
    }
  },
}

// Run as a CLI only when executed directly; tests import the pure helpers.
// Node reports the main module by its real path, so compare real paths.
function invokedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}

if (invokedDirectly()) {
  if (!Object.hasOwn(commands, command)) {
    console.error(`usage: incubator-run.mjs <${Object.keys(commands).join('|')}> ...`)
    process.exit(64)
  }
  commands[command](args)
}
