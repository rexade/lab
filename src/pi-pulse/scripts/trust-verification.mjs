import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { breakage, checksAllowCompletion, runChecks } from './lib/session.mjs'

const helper = fileURLToPath(new URL('./lib/incubator-run.mjs', import.meta.url))
const pass = { state: 'PASS', ran: true, inspectionComplete: true, blank: false, pageErrors: 0, consoleErrors: 0 }

test('completion requires positive evidence and rejects failed or incomplete browser behavior', () => {
  for (const state of ['FAIL', 'NEEDS-EVIDENCE', 'unavailable']) {
    const checks = { check: { state: 'pass' }, app: { ...pass, state } }
    assert.equal(checksAllowCompletion(checks), false, state)
    assert.deepEqual(breakage(null, checks), [], 'inconclusive behavior is not an automatic rollback')
  }
  assert.equal(checksAllowCompletion({ check: { state: 'none' }, app: { state: 'n/a', ran: false } }), false)
  assert.equal(checksAllowCompletion({ check: { state: 'pass' }, app: { state: 'n/a', ran: false } }), true)
  assert.equal(checksAllowCompletion({ check: { state: 'none' }, app: pass }), true)
  assert.equal(checksAllowCompletion({ check: { state: 'fail' }, app: pass }), false)
  assert.equal(checksAllowCompletion({ check: { state: 'pass' }, app: { ...pass, inspectionComplete: false } }), false)
})

test('a web app with no browser harness cannot certify completion', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-browser-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  fs.writeFileSync(path.join(repo, 'index.html'), '<h1>App</h1>')
  const checks = runChecks({ repo, label: '1', appEvidenceScript: null })
  assert.equal(checks.app.state, 'unavailable')
  assert.equal(checksAllowCompletion(checks), false)
})

for (const agent of ['claude', 'codex']) {
  test(`${agent} workshop sessions preserve rotation, verify nested code and retain history on rollback`, t => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-core-'))
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
    const statusPath = path.join(repo, 'projects/pi-pulse/status.json')
    const runLog = path.join(repo, 'RUN_LOG.md')
    fs.mkdirSync(path.dirname(statusPath), { recursive: true })
    fs.mkdirSync(path.join(repo, 'src/pi-pulse'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'prompts'))
    for (const type of ['create', 'mutate', 'research', 'harvest']) fs.writeFileSync(path.join(repo, 'prompts', `${type}.md`), `Freeform ${type}`)
    fs.writeFileSync(runLog, '# Runs\n')
    fs.writeFileSync(path.join(repo, 'src/pi-pulse/product.txt'), 'working')
    fs.writeFileSync(statusPath, JSON.stringify({ project: 'pi-pulse', repo, runLog, runner: agent }))
    const call = (command, run, extra = [], input = '') => {
      const result = spawnSync(process.execPath, [helper, command, statusPath, String(run), ...extra], {
        encoding: 'utf8', input, env: { ...process.env, LAB_DIR: repo, PI_PULSE_CORE_RUN: '1', PI_PULSE_AGENT: agent, PI_PULSE_RUN_TYPE: '', PI_PULSE_REVIEW: '1' },
      })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout
    }
    const status = () => JSON.parse(fs.readFileSync(statusPath, 'utf8'))
    assert.match(call('session-begin', 1), /type=CREATE/)
    assert.match(call('session-prompt', 1, ['2026-10-12']), /Freeform create/)
    fs.appendFileSync(path.join(repo, 'src/pi-pulse/product.txt'), '\nbetter')
    call('session-end', 1, ['2026-10-12', '0', agent, '', ''])
    assert.equal(status().lastOutcome, 'kept')
    assert.match(call('review-prompt', 1), /do not invent milestones/)
    call('review-apply', 1, ['0', agent], '**Verdict:** better - clearer\n**Rating:** 4/5\n**Done:** yes\n**Top problems:**\nnone\n**Cut:** nothing')
    assert.equal(status().stage, 'building', 'workshop never graduates through milestone stages')
    assert.equal(status().lastReview.ok, true)
    assert.match(call('session-begin', 2), /type=MUTATE/)
    fs.writeFileSync(path.join(repo, 'src/pi-pulse/package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }))
    fs.appendFileSync(runLog, '\n## Run 2 - 2026-10-12 - MUTATE\n\n**What changed:** broken test\n')
    call('session-end', 2, ['2026-10-12', '0', agent, '', ''])
    assert.equal(status().lastSessionChecks.check.state, 'fail')
    assert.equal(status().lastOutcome, 'reverted')
    assert.equal(fs.existsSync(path.join(repo, 'src/pi-pulse/package.json')), false)
    assert.match(fs.readFileSync(runLog, 'utf8'), /broken test/)
    assert.match(fs.readFileSync(runLog, 'utf8'), /Outcome:\*\* reverted/)
  })
}
