// Read-only comparisons of recorded iterations. Never accept a revision or
// file path from the request, and never inspect a parent repository.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PRODUCT_FILES = ['--', '.', ':(exclude)reports', ':(exclude,glob)**/.env*', ':(exclude,glob)**/.npmrc', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key']
const fail = error => ({ ok: false, error })

function git(repo, args, maxBuffer = 512 * 1024) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } })
  return { ok: result.status === 0, text: String(result.stdout || ''), truncated: result.error?.code === 'ENOBUFS' }
}

export function recordedVersions(run = {}) {
  const versions = String(run.Versions || '').trim().match(/^([a-f0-9]{40,64})\.\.([a-f0-9]{40,64})$/i)
  if (versions) return { before: versions[1], after: versions[2], source: 'recorded' }
  // Older kept runs already recorded a commit. Its actual first parent is
  // useful history; runs without a commit are not retroactively invented.
  const kept = String(run.Outcome || '').match(/^kept\s*·\s*([a-f0-9]{7,64})(?:\s|$)/i)
  return kept ? { before: null, after: kept[1], source: 'kept-commit' } : null
}

export function compareRecordedRun(repo, run) {
  const versions = recordedVersions(run)
  if (!versions) return fail('No source snapshot was saved for this historical iteration.')
  try {
    const root = git(repo, ['rev-parse', '--show-toplevel'])
    if (!root.ok || fs.realpathSync(root.text.trim()) !== fs.realpathSync(repo)) return fail('This app does not have its own local version history.')
    const after = git(repo, ['rev-parse', '--verify', `${versions.after}^{commit}`])
    const before = git(repo, ['rev-parse', '--verify', versions.before ? `${versions.before}^{commit}` : `${versions.after}^1`])
    if (!before.ok || !after.ok) return fail('The recorded source versions are no longer available.')
    const base = before.text.trim()
    const candidate = after.text.trim()
    const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames']
    const stat = git(repo, [...flags, '--stat=100', base, candidate, ...PRODUCT_FILES], 64 * 1024)
    const patch = git(repo, [...flags, '--patch', '--unified=3', base, candidate, ...PRODUCT_FILES])
    if ((!stat.ok && !stat.truncated) || (!patch.ok && !patch.truncated)) return fail('The source comparison could not be read.')
    const preview = field => {
      const evidence = String(run[field] || '')
      if (!/^run-[a-z0-9-]+$/i.test(evidence)) return null
      const shots = ['desktop.png', 'mobile.png'].filter(file => fs.existsSync(path.join(repo, 'reports/evidence', evidence, file)))
      return shots.length ? { evidence, shots } : null
    }
    return {
      ok: true, run: Number(run.num), before: base, after: candidate,
      outcome: String(run.Outcome || ''), source: versions.source,
      summary: stat.text.slice(0, 64 * 1024).trim(), patch: patch.text.slice(0, 512 * 1024),
      truncated: stat.truncated || patch.truncated || stat.text.length > 64 * 1024 || patch.text.length > 512 * 1024,
      previews: { before: preview('Before preview'), after: preview('After preview') },
    }
  } catch { return fail('The local version history is unavailable.') }
}
