import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { evidenceState, readJson, seal, verify, writeOnce } from './evidence.mjs'
import { evaluateJev } from './evaluator.mjs'
import { decide, hardFacts } from './policy.mjs'
import { comparison } from './report.mjs'

export function shadowEnabled(status) {
  return process.env.PI_PULSE_SHADOW_GATE !== '0' && (status.shadowGate === true || process.env.PI_PULSE_SHADOW_GATE === '1')
}

export async function evaluateBundle(dir, { evaluator = evaluateJev, ...options } = {}) {
  const state = evidenceState(dir)
  const evaluated = await evaluator(state, options)
  if (evaluated.result.bundleHash !== state.bundleHash) throw new Error('Evaluator returned a stale bundle reference')
  // Catch tampering during a network call before persisting a decision.
  if (verify(dir).hash !== state.bundleHash) throw new Error('Evidence changed during evaluation')
  const facts = hardFacts(state)
  const policy = decide({ judgments: evaluated.result.status === 'ok' ? evaluated.result.judgments : {}, facts, threshold: options.threshold })
  const actual = readJson(path.join(dir, 'actual-incubator-outcome.json'))
  const reviewer = readJson(path.join(dir, 'reviewer.json'))
  const report = comparison(actual, reviewer, policy)
  const evaluationDir = path.join(dir, 'evaluations', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  fs.mkdirSync(evaluationDir, { recursive: true })
  writeOnce(evaluationDir, 'request.json', evaluated.request)
  if (evaluated.raw) writeOnce(evaluationDir, 'response.json', evaluated.raw)
  writeOnce(evaluationDir, 'jev-judgments.json', evaluated.result)
  writeOnce(evaluationDir, 'hard-checks.json', facts)
  writeOnce(evaluationDir, 'policy-decision.json', policy)
  writeOnce(evaluationDir, 'shadow-report.json', report)
  seal(evaluationDir, 'manifest.json')
  return { evaluationDir, policy, report, evaluatorStatus: evaluated.result.status }
}
