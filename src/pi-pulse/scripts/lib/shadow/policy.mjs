export const POLICY_VERSION = 'shadow-v1'
export const DEFAULT_THRESHOLD = 0.8
export const VALUES = {
  goalProgress: ['NONE', 'PARTIAL', 'SUBSTANTIAL', 'COMPLETE', 'UNKNOWN'],
  behaviorRegression: ['YES', 'NO', 'UNKNOWN'],
  uxRegression: ['YES', 'NO', 'UNKNOWN'],
  scopeDrift: ['NONE', 'MINOR', 'MATERIAL', 'UNKNOWN'],
  qualityDelta: ['WORSE', 'SAME', 'BETTER', 'UNKNOWN'],
  evidenceSufficient: ['YES', 'NO', 'UNKNOWN'],
}

export function hardFacts(state) {
  const e = state.evidence
  const before = e['before/checks.json']
  const after = e['after/checks.json']
  const regressions = []
  const missing = [...state.truncated.map(ref => `Truncated input: ${ref}`)]
  const sameCheck = before?.check?.command && before.check.command === after?.check?.command
  if (sameCheck && before.check.state === 'pass' && after.check.state === 'fail') regressions.push({ reason: 'A previously passing required check now fails.', evidence: ['before/checks.json', 'after/checks.json'] })
  if (before?.app?.ran && after?.app?.ran) {
    if (before.app.blank === false && after.app.blank === true) regressions.push({ reason: 'The app now renders blank.', evidence: ['before/checks.json', 'after/checks.json'] })
    for (const field of ['pageErrors', 'consoleErrors']) {
      if (Number.isFinite(before.app[field]) && Number.isFinite(after.app[field]) && after.app[field] > before.app[field]) regressions.push({ reason: `New ${field} observed.`, evidence: ['before/checks.json', 'after/checks.json'] })
    }
  }
  if (!before || !after) missing.push('Before/after checks unavailable.')
  if (!sameCheck || after?.check?.state !== 'pass') missing.push('Comparable passing required checks unavailable.')
  if (!e['goal.json']?.goal || !e['acceptance-criteria.json']?.outcomes?.length) missing.push('No goal and criteria fixed before the session.')
  if (!e['candidate.json']?.diff?.complete) missing.push('Candidate diff incomplete.')
  if (e['candidate.json']?.agentExit !== 0) missing.push('Builder did not finish successfully.')
  if (!e['reviewer.json']?.available) missing.push('Independent review unavailable.')
  const hasUi = Boolean(e['before/product.json']?.hasUi || e['after/product.json']?.hasUi)
  if (hasUi) {
    for (const phase of ['before', 'after']) {
      const app = e[`${phase}/checks.json`]?.app
      const metrics = e[`${phase}/metrics.json`]
      if (!app?.ran || app.inspectionComplete !== true || typeof app.blank !== 'boolean' || !['desktop', 'mobile'].every(view => metrics?.screenshots?.includes(`${phase}/screenshots/${view}.png`)) || metrics.missing?.length) missing.push(`${phase} UI inspection incomplete.`)
    }
    if (!e['reviewer.json']?.visualComparison) missing.push('No explicit reviewer comparison of before/after screenshots.')
  }
  return { regressions, missing, hasUi, evidenceRefs: Object.keys(e) }
}

export function decide({ judgments = {}, facts, threshold = DEFAULT_THRESHOLD }) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Invalid policy threshold')
  const result = (action, reasons, evidence = []) => ({ policyVersion: POLICY_VERSION, mode: 'shadow', action, reasons, evidence, threshold, calibrated: false })
  if (facts.regressions.length) return result('REJECT', facts.regressions.map(item => item.reason), [...new Set(facts.regressions.flatMap(item => item.evidence))])
  if (facts.missing.length) return result('ESCALATE', facts.missing)
  const required = Object.keys(VALUES).filter(key => key !== 'uxRegression' || facts.hasUi)
  const uncertain = required.filter(key => {
    const j = judgments[key]
    return !j || !VALUES[key].includes(j.value) || j.value === 'UNKNOWN' || !Number.isFinite(j.confidence) || j.confidence < threshold || j.confidence > 1 || !Array.isArray(j.evidence) || !j.evidence.length || j.evidence.some(ref => !facts.evidenceRefs?.includes(ref))
  })
  if (uncertain.length) return result('ESCALATE', uncertain.map(key => `Uncertain judgment: ${key}`))
  const refs = [...new Set(required.flatMap(key => judgments[key].evidence))]
  if (judgments.evidenceSufficient.value !== 'YES') return result('ESCALATE', ['Evaluator found insufficient evidence.'], refs)
  if (judgments.behaviorRegression.value === 'YES') return result('REJECT', ['Behavior regression supported by the evidence.'], refs)
  if (judgments.goalProgress.value === 'NONE') return result('REJECT', ['No progress toward the starting goal.'], refs)
  if ((facts.hasUi && judgments.uxRegression.value === 'YES') || judgments.qualityDelta.value === 'WORSE' || judgments.scopeDrift.value === 'MATERIAL') return result('REWORK', ['Candidate needs correction before promotion.'], refs)
  return result('ACCEPT', ['Useful progress with sufficient evidence and no identified regression.'], refs)
}
