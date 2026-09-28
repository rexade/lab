import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { beginEvidence, captureCandidate, captureReview, evidenceState, finalizeEvidence, readJson, verify, writeOnce } from './lib/shadow/evidence.mjs'
import { buildRequest, evaluateJev, parseResponse } from './lib/shadow/evaluator.mjs'
import { evaluateBundle } from './lib/shadow/gate.mjs'
import { decide, hardFacts, VALUES } from './lib/shadow/policy.mjs'
import { addHumanReview, shadowReport } from './lib/shadow/report.mjs'

const helper = fileURLToPath(new URL('./lib/incubator-run.mjs', import.meta.url))
const checks = (state = 'pass') => ({ version: 2, check: { state, command: 'test', detail: '' }, app: { ran: false, state: 'n/a' } })
const good = { goalProgress: 'PARTIAL', behaviorRegression: 'NO', uxRegression: 'UNKNOWN', scopeDrift: 'NONE', qualityDelta: 'BETTER', evidenceSufficient: 'YES' }
const assessment = { ok: true, verdict: 'better', done: false, problems: ['More of the milestone remains.'] }

function response(values = good) {
  return { model: 'jev-fixture', answers: Object.fromEntries(Object.entries(VALUES).map(([key, options]) => [key, {
    type: 'choice', choice: values[key], confidence: 0.95,
    probabilities: Object.fromEntries(options.map(option => [option, option === values[key] ? 0.98 : 0.02 / (options.length - 1)])),
  }])), usage: { input_tokens: 100, output_tokens: 30 } }
}

function fixture(t, { ui = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shadow-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'product')
  fs.mkdirSync(repo)
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  fs.writeFileSync(path.join(repo, 'app.txt'), 'before\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'reports/\n.env\n')
  if (ui) {
    fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Working app</h1>\n')
    const evidenceDir = path.join(repo, 'reports', 'evidence', 'run-0')
    fs.mkdirSync(evidenceDir, { recursive: true })
    for (const name of ['desktop.png', 'mobile.png']) fs.writeFileSync(path.join(evidenceDir, name), Buffer.from('baseline-image-fixture'))
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify({ blank: false }))
  }
  fs.writeFileSync(path.join(repo, 'BRIEF.md'), '# Product\n## Goal\nUseful exports\n## Done means\n- Export a record\n- Import a record\n')
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  const session = { run: 1, startedAt: new Date().toISOString(), stage: 'building', ratchet: 'on', baseline: git('rev-parse', 'HEAD'), baselineChecks: checks(), milestoneBefore: { source: 'BRIEF.md', goal: 'Useful exports', outcomes: ['Export a record', 'Import a record'] } }
  if (ui) session.baselineChecks.app = { ran: true, state: 'PASS', blank: false, inspectionComplete: true, pageErrors: 0, consoleErrors: 0, evidence: 'run-0', shots: ['desktop.png', 'mobile.png'] }
  const statusPath = path.join(root, 'status.json')
  const status = { project: 'fixture', repo, runLog: path.join(repo, 'reports', 'RUN_LOG.md'), session, shadowGate: true }
  const dir = beginEvidence({ statusPath, status, session, idea: 'An import/export tool', feedback: 'Keep imports working.' })
  fs.writeFileSync(path.join(repo, 'app.txt'), 'after\n')
  fs.writeFileSync(path.join(repo, 'new file.txt'), 'new feature\n')
  fs.writeFileSync(path.join(repo, '.env'), 'TYPESAFE_API_KEY=apikey_fixture_secret\n')
  fs.writeFileSync(path.join(repo, 'BRIEF.md'), '# Lowered goal\n## Done means\n- Start\n')
  return { root, repo, status, statusPath, session, dir, git }
}

function runnerCommand(fx, args, { input, env = {} } = {}) {
  const result = spawnSync(process.execPath, [helper, ...args], {
    encoding: 'utf8', input, env: { ...process.env, TYPESAFE_API_KEY: '', APP_EVIDENCE_SCRIPT: '/missing', PI_PULSE_SHADOW_GATE: '1', ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}

function prepareRunner(fx) {
  fs.mkdirSync(path.dirname(fx.status.runLog), { recursive: true })
  fs.writeFileSync(fx.status.runLog, '# Runs\n')
  fs.writeFileSync(fx.statusPath, JSON.stringify({ ...fx.status, session: { ...fx.session, shadowBundle: fx.dir }, stage: 'building' }))
}

function finish(fx, after = checks(), reviewer = { available: true, assessment, visualComparison: null }) {
  captureCandidate({ dir: fx.dir, repo: fx.repo, session: fx.session, checks: after, fields: { Goal: 'Retrospective claim' }, agentExit: 0 })
  if (reviewer) captureReview(fx.dir, reviewer)
  finalizeEvidence(fx.dir, { outcome: 'kept', commit: 'abc' })
  return evidenceState(fx.dir)
}

test('evidence fixes starting criteria, includes untracked changes, and never stages the real index or captures .env', t => {
  const fx = fixture(t)
  const index = fs.readFileSync(path.join(fx.repo, '.git', 'index'))
  const state = finish(fx)
  assert.equal(state.evidence['goal.json'].goal, 'Useful exports')
  assert.deepEqual(state.evidence['acceptance-criteria.json'].outcomes, ['Export a record', 'Import a record'])
  assert.match(state.evidence['after/product.json'].brief, /Lowered goal/)
  assert.match(state.evidence['diff.patch'], /new feature/)
  assert.match(state.evidence['diff.patch'], /-before/)
  assert.doesNotMatch(state.evidence['diff.patch'], /apikey_|TYPESAFE_API_KEY/)
  assert.deepEqual(fs.readFileSync(path.join(fx.repo, '.git', 'index')), index)
  assert.equal(fx.git('rev-parse', 'HEAD'), fx.session.baseline)
  assert.throws(() => writeOnce(fx.dir, 'goal.json', {}), /EEXIST/)
  fs.writeFileSync(path.join(fx.dir, 'diff.patch'), 'changed later')
  assert.throws(() => evidenceState(fx.dir), /integrity/)
})

test('candidate evidence survives a real rollback, with required failure taking precedence over unavailable review', t => {
  const fx = fixture(t)
  const state = finish(fx, checks('fail'), null)
  fx.git('restore', '--source=HEAD', '--worktree', '--', 'app.txt', 'BRIEF.md')
  fs.unlinkSync(path.join(fx.repo, 'new file.txt'))
  assert.equal(fs.readFileSync(path.join(fx.repo, 'app.txt'), 'utf8'), 'before\n')
  assert.match(state.evidence['diff.patch'], /new feature/)
  verify(fx.dir)
  const decision = decide({ judgments: {}, facts: hardFacts(state) })
  assert.equal(decision.action, 'REJECT')
  assert.match(decision.reasons[0], /required check/)
})

test('policy accepts useful partial work and distinguishes rework, reject, and unknown evidence', t => {
  const state = finish(fixture(t))
  const facts = hardFacts(state)
  assert.deepEqual(facts.missing, [])
  const judge = changes => parseResponse(response({ ...good, ...changes }), state).judgments
  assert.equal(decide({ judgments: judge({}), facts }).action, 'ACCEPT')
  assert.equal(decide({ judgments: judge({ goalProgress: 'NONE' }), facts }).action, 'REJECT')
  assert.equal(decide({ judgments: judge({ behaviorRegression: 'YES' }), facts }).action, 'REJECT')
  assert.equal(decide({ judgments: judge({ scopeDrift: 'MATERIAL' }), facts }).action, 'REWORK')
  assert.equal(decide({ judgments: judge({ qualityDelta: 'WORSE' }), facts }).action, 'REWORK')
  assert.equal(decide({ judgments: judge({ evidenceSufficient: 'NO' }), facts }).action, 'ESCALATE')
  assert.equal(decide({ judgments: judge({ goalProgress: 'UNKNOWN' }), facts }).action, 'ESCALATE')
  const uncertain = judge({})
  uncertain.goalProgress.confidence = 0.2
  assert.equal(decide({ judgments: uncertain, facts }).action, 'ESCALATE')
  const unsupported = judge({})
  unsupported.goalProgress.evidence = ['not-in-the-bundle.json']
  assert.equal(decide({ judgments: unsupported, facts }).action, 'ESCALATE')
  assert.equal(decide({ judgments: judge({}), facts: { ...facts, hasUi: true } }).action, 'ESCALATE')
  const existingFailure = structuredClone(state)
  existingFailure.evidence['before/checks.json'].check.state = 'fail'
  existingFailure.evidence['after/checks.json'].check.state = 'fail'
  assert.equal(hardFacts(existingFailure).regressions.length, 0)
  assert.equal(decide({ judgments: judge({}), facts: hardFacts(existingFailure) }).action, 'ESCALATE')
})

test('missing visual comparison, missing goal, changed check command, and truncated input cannot be accepted', t => {
  const original = finish(fixture(t))
  for (const mutate of [
    state => { state.evidence['after/product.json'].hasUi = true },
    state => { state.evidence['goal.json'].goal = null },
    state => { state.evidence['after/checks.json'].check.command = 'weaker-check' },
    state => { state.truncated.push('diff.patch') },
  ]) {
    const state = structuredClone(original)
    mutate(state)
    const judgments = parseResponse(response(), state).judgments
    assert.equal(decide({ judgments, facts: hardFacts(state) }).action, 'ESCALATE')
  }
})

test('Jev request is observational, keeps outcomes out, and retains honest evidence provenance', async t => {
  const state = finish(fixture(t))
  let calls = 0
  const result = await evaluateJev(state, { apiKey: 'fake-key', fetchImpl: async (url, options) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(options.headers.Authorization, 'Bearer fake-key')
    const request = JSON.parse(options.body)
    assert.equal(request.state.evidence['actual-incubator-outcome.json'], undefined)
    assert.equal(request.questions.action, undefined)
    assert.deepEqual(Object.keys(request.questions), Object.keys(VALUES))
    assert.doesNotMatch(options.body, /fake-key|apikey_fixture_secret/)
    return { ok: true, json: async () => response() }
  } })
  assert.equal(calls, 1)
  assert.equal(result.result.status, 'ok')
  assert.equal(result.result.judgments.goalProgress.evidenceBasis, 'supplied-context')
  assert.ok(result.result.judgments.goalProgress.evidence.every(ref => Object.hasOwn(state.evidence, ref)))
  assert.equal(result.result.judgments.goalProgress.probabilities.PARTIAL, 0.98)
})

test('missing credentials, outages, malformed answers, and timeouts yield UNKNOWN rather than a fabricated pass', async t => {
  const state = finish(fixture(t))
  const invalid = response()
  invalid.answers.goalProgress.choice = 'KEEP'
  for (const options of [
    { apiKey: '', fetchImpl: () => assert.fail('No key must not make a request') },
    { apiKey: 'fake', fetchImpl: async () => ({ ok: false, status: 429 }) },
    { apiKey: 'fake', fetchImpl: async () => ({ ok: true, json: async () => invalid }) },
    { apiKey: 'fake', timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret-network-error')))) },
  ]) {
    const { result } = await evaluateJev(state, options)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.judgments.goalProgress.value, 'UNKNOWN')
    assert.equal(result.judgments.goalProgress.confidence, null)
    assert.doesNotMatch(JSON.stringify(result), /secret-network-error/)
    assert.equal(decide({ judgments: result.judgments, facts: hardFacts(state) }).action, 'ESCALATE')
  }
  const invalidProbability = response()
  invalidProbability.answers.goalProgress.probabilities.PARTIAL = 10
  assert.throws(() => parseResponse(invalidProbability, state), /probabilities/)
})

test('shadow reports compare actual and proposed actions, retain replays, and use explicit human labels for calibration', async t => {
  const fx = fixture(t)
  finish(fx)
  const evaluator = async state => ({ request: buildRequest(state), raw: response({ ...good, behaviorRegression: 'YES' }), result: parseResponse(response({ ...good, behaviorRegression: 'YES' }), state) })
  const first = await evaluateBundle(fx.dir, { evaluator })
  assert.equal(first.policy.action, 'REJECT')
  assert.equal(first.report.actualAction, 'ACCEPT')
  assert.equal(first.report.disagreement, true)
  assert.equal(fx.git('rev-parse', 'HEAD'), fx.session.baseline, 'shadow evaluation does not move Git')
  await evaluateBundle(fx.dir, { evaluator })
  assert.equal(fs.readdirSync(path.join(fx.dir, 'evaluations')).length, 2)
  let report = shadowReport(path.dirname(fx.dir))
  assert.equal(report.sessions, 1, 'replay does not count as another real session')
  assert.equal(report.labeled, 0)
  assert.equal(report.calibration.behaviorRegression[4].labeled, 0, 'incubator decisions are not ground truth')
  addHumanReview(fx.dir, { reviewer: 'fixture reviewer', action: 'REWORK', judgments: { behaviorRegression: 'NO' } })
  report = shadowReport(path.dirname(fx.dir))
  assert.equal(report.labeled, 1)
  assert.equal(report.calibration.behaviorRegression[4].labeled, 1)
  assert.equal(report.calibration.behaviorRegression[4].correct, 0)
  assert.equal(report.rows[0].matchesHuman, false)
})

test('runner capture precedes rollback and unavailable Jev does not change acceptance or lifecycle', async t => {
  const fx = fixture(t)
  prepareRunner(fx)
  runnerCommand(fx, ['session-end', fx.statusPath, '1', '2026-09-28', '3', 'codex', '', ''])
  const before = readJson(fx.statusPath)
  assert.equal(before.lastOutcome, 'failed')
  assert.equal(fs.readFileSync(path.join(fx.repo, 'app.txt'), 'utf8'), 'before\n')
  assert.match(fs.readFileSync(path.join(fx.dir, 'diff.patch'), 'utf8'), /new feature/)
  runnerCommand(fx, ['shadow-end', fx.statusPath, '1'])
  const after = readJson(fx.statusPath)
  assert.equal(after.lastShadow.mode, 'shadow')
  assert.equal(after.lastShadow.evaluatorStatus, 'unavailable')
  assert.equal(after.lastOutcome, before.lastOutcome)
  assert.equal(after.lastGoodCommit, before.lastGoodCommit)
  assert.equal(after.stage, before.stage)
  assert.equal(after.lastShadow.policy.action, 'ESCALATE')
})

test('runner keeps the real commit even when an independent review is worse and shadow proposes escalation', t => {
  const fx = fixture(t)
  prepareRunner(fx)
  runnerCommand(fx, ['session-end', fx.statusPath, '1', '2026-09-28', '0', 'codex', '', ''])
  const kept = readJson(fx.statusPath)
  assert.equal(kept.lastOutcome, 'kept')
  assert.notEqual(kept.lastGoodCommit, fx.session.baseline)
  runnerCommand(fx, ['review-apply', fx.statusPath, '1', '0', 'codex'], { input: '**Verdict:** worse - too much complexity\n**Rating:** 2/5 - needs work\n**Done:** no - import is missing\n**Top problems:**\n1. Simplify exports\n**Cut:** duplicate serializer\n**Visual comparison:** unavailable\n' })
  const reviewed = readJson(fx.statusPath)
  runnerCommand(fx, ['shadow-end', fx.statusPath, '1'])
  const final = readJson(fx.statusPath)
  assert.equal(final.lastOutcome, 'kept')
  assert.equal(final.lastGoodCommit, kept.lastGoodCommit)
  assert.equal(final.stage, reviewed.stage)
  assert.equal(final.lastShadow.report.reviewer.verdict, 'worse')
  assert.equal(final.lastShadow.report.disagreement, true)
  assert.equal(readJson(path.join(fx.dir, 'reviewer.json')).visualComparison, null)
})

test('runner archives both screenshot versions before objective browser rejection', t => {
  const fx = fixture(t, { ui: true })
  prepareRunner(fx)
  const probe = path.join(fx.root, 'probe.mjs')
  fs.writeFileSync(probe, `import fs from 'node:fs'; import path from 'node:path';
const repo = process.argv[process.argv.indexOf('--repo') + 1];
const label = process.argv[process.argv.indexOf('--run') + 1];
const dir = path.join(repo, 'reports', 'evidence', 'run-' + label);
fs.mkdirSync(dir, { recursive: true });
for (const name of ['desktop.png', 'mobile.png']) fs.writeFileSync(path.join(dir, name), 'blank-image-fixture');
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ evidenceMode: 'degraded', gate: 'FAIL', blank: true, inspectionComplete: true, pageErrorCount: 0, consoleErrorCount: 0 }));
`)
  runnerCommand(fx, ['session-end', fx.statusPath, '1', '2026-09-28', '0', 'codex', '', ''], { env: { APP_EVIDENCE_SCRIPT: probe } })
  assert.equal(readJson(fx.statusPath).lastOutcome, 'reverted')
  runnerCommand(fx, ['shadow-end', fx.statusPath, '1'])
  const status = readJson(fx.statusPath)
  assert.equal(status.lastShadow.policy.action, 'REJECT')
  assert.equal(status.lastShadow.report.disagreement, false)
  assert.match(status.lastShadow.policy.reasons[0], /blank/)
  assert.equal(fs.readFileSync(path.join(fx.dir, 'before/screenshots/desktop.png'), 'utf8'), 'baseline-image-fixture')
  assert.equal(fs.readFileSync(path.join(fx.dir, 'after/screenshots/desktop.png'), 'utf8'), 'blank-image-fixture')
  verify(fx.dir)
})
