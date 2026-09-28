import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, verify, writeOnce } from './evidence.mjs'
import { VALUES } from './policy.mjs'

export function comparison(actual, reviewer, policy) {
  const actualAction = actual.outcome === 'kept' ? 'ACCEPT' : actual.outcome === 'reverted' ? 'REJECT' : null
  return {
    mode: 'shadow', actualOutcome: actual.outcome, actualAction, proposedAction: policy.action,
    disagreement: actualAction ? actualAction !== policy.action : null,
    reviewer: reviewer.available ? { verdict: reviewer.assessment.verdict, done: reviewer.assessment.done, problems: reviewer.assessment.problems } : null,
  }
}

export function addHumanReview(dir, review) {
  const manifest = verify(dir)
  if (!review || typeof review.reviewer !== 'string' || !review.reviewer.trim() || !['ACCEPT', 'REWORK', 'REJECT', 'ESCALATE'].includes(review.action)) throw new Error('A reviewer name and valid action are required')
  for (const [key, value] of Object.entries(review.judgments || {})) {
    if (!VALUES[key]?.includes(value)) throw new Error('Invalid human judgment')
  }
  const name = `human-reviews/${randomUUID()}.json`
  writeOnce(dir, name, { ...review, bundleHash: manifest.hash, at: new Date().toISOString() })
  return path.join(dir, name)
}

function directories(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(dir, entry.name)) : []
}

export function shadowReport(root) {
  const rows = []
  const errors = []
  const missingEvidence = {}
  const highConfidenceNoRegression = Object.fromEntries(['behaviorRegression', 'uxRegression'].map(key => [key, { aboveConfidence: 0.9, labeled: 0, correct: 0 }]))
  const unknown = Object.fromEntries(Object.keys(VALUES).map(key => [key, 0]))
  const calibration = Object.fromEntries(Object.keys(VALUES).map(key => [key, Array.from({ length: 5 }, (_, index) => ({ minConfidence: index / 5, maxConfidence: (index + 1) / 5, labeled: 0, correct: 0 }))]))
  for (const dir of directories(root)) {
    try {
      const manifest = verify(dir)
      const evaluations = directories(path.join(dir, 'evaluations')).sort()
      if (!evaluations.length) continue
      // The first evaluation is the contemporaneous comparison; later replays stay separate.
      const evaluation = evaluations[0]
      verify(evaluation)
      const result = readJson(path.join(evaluation, 'jev-judgments.json'))
      if (result.bundleHash !== manifest.hash) throw new Error('Evaluation references a different bundle')
      const report = readJson(path.join(evaluation, 'shadow-report.json'))
      const facts = readJson(path.join(evaluation, 'hard-checks.json'))
      for (const reason of facts.missing) missingEvidence[reason] = (missingEvidence[reason] || 0) + 1
      const labelDir = path.join(dir, 'human-reviews')
      const labels = fs.existsSync(labelDir) ? fs.readdirSync(labelDir).filter(name => name.endsWith('.json')).map(name => readJson(path.join(labelDir, name))).filter(label => label.bundleHash === manifest.hash).sort((a, b) => a.at.localeCompare(b.at)) : []
      const human = labels.at(-1) || null
      for (const key of Object.keys(VALUES)) {
        const judgment = result.judgments[key]
        if (judgment.value === 'UNKNOWN') unknown[key]++
        const label = human?.judgments?.[key]
        if (!label || label === 'UNKNOWN' || judgment.value === 'UNKNOWN' || !Number.isFinite(judgment.confidence)) continue
        const bin = calibration[key][Math.min(4, Math.floor(judgment.confidence * 5))]
        bin.labeled++
        if (judgment.value === label) bin.correct++
        if (highConfidenceNoRegression[key] && judgment.value === 'NO' && judgment.confidence > 0.9 && ['YES', 'NO'].includes(label)) {
          highConfidenceNoRegression[key].labeled++
          if (label === 'NO') highConfidenceNoRegression[key].correct++
        }
      }
      rows.push({ sessionId: path.basename(dir), evaluation, ...report, judgments: result.judgments, evidenceGaps: facts.missing, human, matchesHuman: human ? report.proposedAction === human.action : null })
    } catch { errors.push({ sessionId: path.basename(dir), error: 'Incomplete or invalid shadow artifacts.' }) }
  }
  return { sessions: rows.length, labeled: rows.filter(row => row.human).length, disagreements: rows.filter(row => row.disagreement).length, unknown, missingEvidence, highConfidenceNoRegression, calibration, rows, errors }
}
