#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const repo = path.resolve(args.repo || process.cwd())
const runNumber = String(args.run || 'manual').replace(/[^a-z0-9_-]+/gi, '-')
const runType = args.type || 'unknown'
const evidenceDir = path.join(repo, 'reports', 'evidence', `run-${runNumber}`)
const summaryPath = path.join(evidenceDir, 'summary.json')
const summaryMdPath = path.join(evidenceDir, 'summary.md')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    out[key] = next && !next.startsWith('--') ? argv[++i] : true
  }
  return out
}

function detectApp(root) {
  const packagePath = path.join(root, 'package.json')
  const hasIndex = fs.existsSync(path.join(root, 'index.html'))
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) } catch {}
  const scripts = pkg?.scripts || {}
  const webScripts = ['dev', 'start', 'preview', 'serve'].filter(name => scripts[name])
  if (hasIndex && pkg) return { appType: 'web-package', entry: 'index.html', packageName: pkg.name || null, scripts: webScripts }
  if (hasIndex) return { appType: 'static-web', entry: 'index.html', packageName: null, scripts: [] }
  if (pkg && webScripts.length > 0) return { appType: 'web-package', entry: null, packageName: pkg.name || null, scripts: webScripts }
  return { appType: 'unknown', entry: null, packageName: pkg?.name || null, scripts: webScripts }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

function createStaticServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const decoded = decodeURIComponent(url.pathname)
    const requested = decoded === '/' ? '/index.html' : decoded
    const filePath = path.resolve(root, `.${requested}`)
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        const fallback = path.join(root, 'index.html')
        if (requested !== '/index.html' && fs.existsSync(fallback)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(fs.readFileSync(fallback))
          return
        }
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': contentType(filePath) })
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${address.port}/` })
    })
  })
}

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(name)
      if (mod.chromium) return { chromium: mod.chromium, package: name }
    } catch {}
  }
  return null
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const visible = Array.from(document.body?.querySelectorAll('canvas,img,svg,button,a,input,textarea,main,section,[role="button"]') || [])
      .filter(el => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0
      })
    return {
      title: document.title || '',
      textLength: (document.body?.innerText || '').trim().length,
      visibleElements: visible.length,
      actionElements: document.querySelectorAll('button,a,[role="button"],input,textarea,select').length,
      bodyChildren: document.body?.children.length || 0,
      location: location.href,
      bodyHash: Array.from((document.body?.innerText || '').trim()).reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0),
    }
  })
}

async function readSemanticContract(page) {
  return page.evaluate(() => {
    const app = window.__PI_PULSE_APP__
    if (!app || typeof app !== 'object') {
      return { present: false, mode: 'degraded', topTierEligible: false, reason: 'window.__PI_PULSE_APP__ not registered' }
    }
    const action = app.primaryAction
    const actionObject = action && typeof action === 'object' ? action : null
    const success = actionObject?.expect || app.successContract?.expect || app.successContract || app.success || null
    return {
      present: true,
      mode: 'semantic',
      version: app.version ?? 1,
      name: typeof app.name === 'string' ? app.name.slice(0, 120) : null,
      type: typeof app.type === 'string' ? app.type.slice(0, 80) : null,
      hasReset: typeof app.reset === 'function',
      hasSnapshot: typeof app.snapshot === 'function',
      hasPrimaryActionFunction: typeof action === 'function',
      primaryActionSelector: typeof action === 'string' ? action : typeof actionObject?.selector === 'string' ? actionObject.selector : null,
      primaryActionLabel: typeof actionObject?.label === 'string' ? actionObject.label.slice(0, 80) : null,
      hasSuccessContract: !!success || typeof app.success === 'function',
      successContract: success && typeof success === 'object' ? {
        selector: typeof success.selector === 'string' ? success.selector : null,
        textIncludes: typeof success.textIncludes === 'string' ? success.textIncludes : null,
        visibleTextIncludes: typeof success.visibleTextIncludes === 'string' ? success.visibleTextIncludes : null,
        text: typeof success.text === 'string' ? success.text : null,
        bodyTextIncludes: typeof success.bodyTextIncludes === 'string' ? success.bodyTextIncludes : null,
        stateAttribute: typeof success.stateAttribute === 'string' ? success.stateAttribute : null,
        localStorage: success.localStorage && typeof success.localStorage === 'object' ? {
          key: typeof success.localStorage.key === 'string' ? success.localStorage.key : null,
          minItems: Number.isFinite(Number(success.localStorage.minItems)) ? Number(success.localStorage.minItems) : null,
        } : null,
        exists: typeof success.exists === 'boolean' ? success.exists : null,
      } : typeof app.success === 'function' ? { function: true } : null,
    }
  })
}

async function resetSemanticContract(page) {
  return page.evaluate(async () => {
    const reset = window.__PI_PULSE_APP__?.reset
    if (typeof reset !== 'function') return { available: false, ok: false }
    try {
      await reset()
      return { available: true, ok: true }
    } catch (err) {
      return { available: true, ok: false, error: err?.message || String(err) }
    }
  })
}

async function readSemanticSnapshot(page, label) {
  return page.evaluate(async (snapshotLabel) => {
    const snapshot = window.__PI_PULSE_APP__?.snapshot
    if (typeof snapshot !== 'function') return { label: snapshotLabel, available: false, ok: false, state: null }
    try {
      return { label: snapshotLabel, available: true, ok: true, state: await snapshot() }
    } catch (err) {
      return { label: snapshotLabel, available: true, ok: false, error: err?.message || String(err), state: null }
    }
  }, label)
}

async function evaluateSuccessContract(page) {
  return page.evaluate(async () => {
    const app = window.__PI_PULSE_APP__
    const action = app?.primaryAction
    const contract = (action && typeof action === 'object' ? action.expect : null) || app?.successContract?.expect || app?.successContract || app?.success
    if (typeof contract === 'function') {
      try {
        const result = await contract()
        return { available: true, passed: Boolean(result), source: 'semantic-function', detail: result }
      } catch (err) {
        return { available: true, passed: false, source: 'semantic-function', error: err?.message || String(err) }
      }
    }
    if (!contract || typeof contract !== 'object') return { available: false, passed: null, source: null, reason: 'no success contract' }

    const checks = []
    if (typeof contract.bodyTextIncludes === 'string') {
      const text = document.body?.innerText || ''
      checks.push({ source: 'bodyTextIncludes', passed: text.includes(contract.bodyTextIncludes), expected: contract.bodyTextIncludes })
    }

    if (typeof contract.stateAttribute === 'string') {
      const raw = contract.stateAttribute.trim()
      const match = raw.match(/^([^=]+)=\"?([^\"]+)\"?$/)
      const selector = match ? `[${match[1]}=\"${match[2]}\"]` : `[${raw}]`
      checks.push({ source: 'stateAttribute', passed: Boolean(document.querySelector(selector)), expected: raw, selector })
    }

    if (contract.localStorage && typeof contract.localStorage === 'object' && typeof contract.localStorage.key === 'string') {
      let count = 0
      let found = false
      try {
        const raw = localStorage.getItem(contract.localStorage.key)
        found = raw != null
        const parsed = raw ? JSON.parse(raw) : null
        count = Array.isArray(parsed) ? parsed.length : parsed && typeof parsed === 'object' ? Object.keys(parsed).length : raw ? 1 : 0
      } catch {
        count = localStorage.getItem(contract.localStorage.key) ? 1 : 0
        found = count > 0
      }
      const minItems = Number.isFinite(Number(contract.localStorage.minItems)) ? Number(contract.localStorage.minItems) : 1
      checks.push({ source: 'localStorage', passed: found && count >= minItems, key: contract.localStorage.key, count, minItems })
    }

    const selector = typeof contract.selector === 'string' ? contract.selector : null
    if (selector) {
      const el = document.querySelector(selector)
      if (contract.exists === false) checks.push({ source: 'selector-absent', passed: !el, selector })
      else if (!el) checks.push({ source: 'selector', passed: false, selector, reason: 'selector not found' })
      else {
        const text = 'value' in el ? String(el.value || '') : String(el.innerText || el.textContent || '')
        if (contract.exists === true) checks.push({ source: 'selector-exists', passed: true, selector })
        if (typeof contract.textIncludes === 'string') checks.push({ source: 'textIncludes', passed: text.includes(contract.textIncludes), selector, expected: contract.textIncludes, actual: text.slice(0, 200) })
        if (typeof contract.visibleTextIncludes === 'string') checks.push({ source: 'visibleTextIncludes', passed: text.includes(contract.visibleTextIncludes), selector, expected: contract.visibleTextIncludes, actual: text.slice(0, 200) })
        if (typeof contract.text === 'string') checks.push({ source: 'text', passed: text.trim() === contract.text, selector, expected: contract.text, actual: text.trim().slice(0, 200) })
        if (contract.exists == null && typeof contract.textIncludes !== 'string' && typeof contract.visibleTextIncludes !== 'string' && typeof contract.text !== 'string') checks.push({ source: 'selector-exists', passed: true, selector })
      }
    }

    if (checks.length === 0) return { available: false, passed: null, source: null, reason: 'success contract has no supported checks' }
    return { available: true, passed: checks.every(check => check.passed), source: 'successContract', checks }
  })
}

async function probePrimaryAction(page) {
  return page.evaluate(() => {
    const app = window.__PI_PULSE_APP__
    const action = app?.primaryAction
    const semanticSelector = typeof action === 'string' ? action : action && typeof action === 'object' && typeof action.selector === 'string' ? action.selector : null
    const semanticFunction = typeof action === 'function'

    if (semanticSelector) {
      const el = document.querySelector(semanticSelector)
      if (!el) return { available: false, checked: false, changed: false, label: null, selector: semanticSelector, source: 'semantic-selector', executionPath: 'visible-ui', reason: 'semantic primaryAction selector not found' }
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true'
      const visible = !disabled && rect.width > 12 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0
      return {
        available: visible,
        checked: false,
        changed: false,
        label: (action?.label || el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || el.tagName).trim().slice(0, 80),
        selector: semanticSelector,
        source: 'semantic-selector',
        executionPath: 'visible-ui',
        reason: visible ? null : 'semantic primaryAction selector is not visible or is disabled',
      }
    }

    if (semanticFunction) {
      return { available: true, checked: false, changed: false, label: 'semantic primaryAction function', selector: null, source: 'semantic-function', executionPath: 'semantic-action', reason: null }
    }

    const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'))
      .filter(el => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true'
        return !disabled && rect.width > 12 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0
      })
    const el = candidates[0]
    if (!el) return { available: false, checked: false, changed: false, label: null, selector: null, source: 'degraded-selector', executionPath: 'visible-ui', reason: 'no visible action element' }
    if (!el.dataset.appEvidencePrimary) el.dataset.appEvidencePrimary = 'true'
    return {
      available: true,
      checked: false,
      changed: false,
      label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || el.getAttribute('href') || el.tagName).trim().slice(0, 80),
      selector: '[data-app-evidence-primary="true"]',
      source: 'degraded-selector',
      executionPath: 'visible-ui',
      reason: null,
    }
  })
}

async function executePrimaryAction(page, primaryAction) {
  if (primaryAction.selector) {
    await page.click(primaryAction.selector, { timeout: 5000 })
    return { ok: true, path: 'visible-ui' }
  }
  if (primaryAction.source === 'semantic-function') {
    return page.evaluate(async () => {
      try {
        await window.__PI_PULSE_APP__.primaryAction()
        return { ok: true, path: 'semantic-action' }
      } catch (err) {
        return { ok: false, path: 'semantic-action', error: err?.message || String(err) }
      }
    })
  }
  return { ok: false, path: null, error: 'no executable primary action' }
}

function stateChanged(before, after) {
  if (!before || !after) return false
  return before.location !== after.location ||
    before.textLength !== after.textLength ||
    before.visibleElements !== after.visibleElements ||
    before.actionElements !== after.actionElements ||
    before.bodyChildren !== after.bodyChildren ||
    before.bodyHash !== after.bodyHash
}

function isHarnessInfrastructureError(err) {
  const text = String(err?.message || err || '').toLowerCase()
  return /executable doesn't exist|browser executable|playwright install|host system is missing|missing dependencies|failed to launch|browser closed|spawn .*enoent|chromium/.test(text)
}

function writeSummary(summary) {
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
  const success = summary.semanticSuccess
  const lines = [
    `# App Evidence Run ${runNumber}`,
    '',
    `**App evidence gate:** ${summary.gate}`,
    `**Top-tier eligible:** ${summary.topTierEligible ? 'yes' : 'no'}`,
    `**Evidence mode:** ${summary.evidenceMode}`,
    `**Semantic contract:** ${summary.semanticContract?.present ? 'registered' : 'missing'}`,
    `**App type:** ${summary.appType}`,
    `**Run type:** ${summary.runType}`,
    summary.url ? `**URL:** ${summary.url}` : null,
    summary.desktopScreenshot ? `**Desktop screenshot:** ${summary.desktopScreenshot}` : null,
    summary.mobileScreenshot ? `**Mobile screenshot:** ${summary.mobileScreenshot}` : null,
    `**Console errors:** ${summary.consoleErrorCount ?? 0}`,
    `**Page errors:** ${summary.pageErrorCount ?? 0}`,
    `**Blank page:** ${summary.blank ? 'yes' : 'no'}`,
    `**Primary action:** ${summary.primaryAction?.checked ? summary.primaryAction.changed ? 'changed state' : 'no visible change' : summary.primaryAction?.available ? 'not checked' : 'not available'}`,
    success?.available ? `**Success contract:** ${success.passed ? 'passed' : 'failed'} (${success.source || 'semantic'})` : '**Success contract:** not available',
    summary.afterActionScreenshot ? `**After-action screenshot:** ${summary.afterActionScreenshot}` : null,
    '',
    '## Notes',
    ...(summary.notes?.length ? summary.notes.map(note => `- ${note}`) : ['- No notes.']),
  ].filter(Boolean)
  fs.writeFileSync(summaryMdPath, `${lines.join('\n')}\n`)
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const detected = detectApp(repo)
  const summary = {
    ok: false,
    gate: 'NEEDS-EVIDENCE',
    runNumber,
    runType,
    repo,
    evidenceDir,
    summaryPath,
    summaryMdPath,
    ...detected,
    url: null,
    desktopScreenshot: null,
    mobileScreenshot: null,
    afterActionScreenshot: null,
    consoleErrorCount: 0,
    pageErrorCount: 0,
    blank: true,
    evidenceMode: 'none',
    topTierEligible: false,
    semanticContract: { present: false, mode: 'degraded', topTierEligible: false, reason: 'not inspected' },
    semanticReset: null,
    semanticSnapshots: [],
    semanticSuccess: { available: false, passed: null, source: null, reason: 'not checked' },
    primaryAction: { available: false, checked: false, changed: false, label: null, selector: null, source: null, executionPath: null, reason: null },
    notes: [],
  }

  if (detected.appType === 'unknown') {
    summary.gate = 'NEEDS-EVIDENCE'
    summary.notes.push('No index.html or web package script was detected; app evidence was not applicable to this run.')
    writeSummary(summary)
    console.log(`${summary.gate} ${summaryMdPath}`)
    return
  }

  if (!fs.existsSync(path.join(repo, 'index.html'))) {
    summary.notes.push('Web package detected, but v1 harness only launches existing index.html without installing or running dependencies.')
    writeSummary(summary)
    console.log(`${summary.gate} ${summaryMdPath}`)
    return
  }

  const playwright = await loadPlaywright()
  if (!playwright) {
    summary.notes.push('Playwright is not installed; screenshots and browser checks could not run.')
    summary.notes.push('Install or expose Playwright to turn this NEEDS-EVIDENCE result into a machine browser gate.')
    writeSummary(summary)
    console.log(`${summary.gate} ${summaryMdPath}`)
    return
  }

  let server
  let browser
  try {
    const launched = await createStaticServer(repo)
    server = launched.server
    summary.url = launched.url
    browser = await playwright.chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const consoleEvents = []
    const pageErrors = []
    page.on('console', msg => consoleEvents.push({ type: msg.type(), text: msg.text(), timestamp: Date.now() }))
    page.on('pageerror', err => pageErrors.push({ message: err.message, timestamp: Date.now() }))
    await page.goto(launched.url, { waitUntil: 'networkidle', timeout: 20000 })

    summary.semanticContract = await readSemanticContract(page)
    summary.evidenceMode = summary.semanticContract.present ? 'semantic' : 'degraded'
    summary.notes.push(summary.semanticContract.present ? `Opened with ${playwright.package}; semantic contract registered.` : `Opened with ${playwright.package} in degraded browser mode.`)
    if (summary.semanticContract.hasReset) summary.semanticReset = await resetSemanticContract(page)
    if (summary.semanticContract.hasSnapshot) summary.semanticSnapshots.push(await readSemanticSnapshot(page, 'before'))

    await page.screenshot({ path: path.join(evidenceDir, 'desktop.png'), fullPage: true })
    const desktopState = await inspectPage(page)
    const primaryAction = await probePrimaryAction(page)
    if (primaryAction.available) {
      const actionResult = await executePrimaryAction(page, primaryAction)
      primaryAction.checked = actionResult.ok
      primaryAction.executionResult = actionResult
      await page.waitForTimeout(500)
      const afterActionState = await inspectPage(page)
      primaryAction.changed = stateChanged(desktopState, afterActionState)
      summary.semanticSuccess = await evaluateSuccessContract(page)
      if (summary.semanticContract.hasSnapshot) summary.semanticSnapshots.push(await readSemanticSnapshot(page, 'after'))
      await page.screenshot({ path: path.join(evidenceDir, 'after-action.png'), fullPage: true })
      fs.writeFileSync(path.join(evidenceDir, 'after-action-state.json'), JSON.stringify(afterActionState, null, 2) + '\n')
      summary.afterActionScreenshot = path.join(evidenceDir, 'after-action.png')
      summary.afterActionState = afterActionState
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(evidenceDir, 'mobile.png'), fullPage: true })
    const mobileState = await inspectPage(page)
    fs.writeFileSync(path.join(evidenceDir, 'console.json'), JSON.stringify(consoleEvents, null, 2) + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'page-errors.json'), JSON.stringify(pageErrors, null, 2) + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'page-state.json'), JSON.stringify({ desktop: desktopState, mobile: mobileState }, null, 2) + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'semantic-contract.json'), JSON.stringify(summary.semanticContract, null, 2) + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'semantic-snapshots.json'), JSON.stringify(summary.semanticSnapshots, null, 2) + '\n')

    summary.desktopScreenshot = path.join(evidenceDir, 'desktop.png')
    summary.mobileScreenshot = path.join(evidenceDir, 'mobile.png')
    summary.consoleErrorCount = consoleEvents.filter(item => item.type === 'error').length
    summary.pageErrorCount = pageErrors.length
    summary.blank = [desktopState, mobileState].some(state => state.textLength < 12 && state.visibleElements < 2)
    summary.pageState = { desktop: desktopState, mobile: mobileState }
    summary.primaryAction = primaryAction
    summary.topTierEligible = summary.semanticContract.present &&
      primaryAction.source === 'semantic-selector' &&
      primaryAction.executionPath === 'visible-ui' &&
      primaryAction.checked &&
      primaryAction.changed &&
      summary.semanticSuccess.available &&
      summary.semanticSuccess.passed === true

    if (summary.blank) summary.notes.push('Desktop or mobile viewport looked blank or nearly blank.')
    if (!summary.semanticContract.present) summary.notes.push('No window.__PI_PULSE_APP__ semantic contract was registered; evidence is degraded and not 4.5+ eligible.')
    if (summary.semanticContract.present && !summary.semanticContract.hasSuccessContract) summary.notes.push('Semantic contract is missing a success contract for the primary action.')
    if (summary.primaryAction.available && !summary.primaryAction.changed) summary.notes.push('Primary visible action was exercised but no visible state change was detected.')
    if (summary.semanticSuccess.available && !summary.semanticSuccess.passed) summary.notes.push('Semantic success contract failed after the primary action.')
    if (summary.primaryAction.source === 'semantic-function') summary.notes.push('Primary action used a semantic function; top-tier UI proof requires a visible selector path.')
    if (summary.consoleErrorCount > 0) summary.notes.push('Console errors were observed.')
    if (summary.pageErrorCount > 0) summary.notes.push('Uncaught page errors were observed.')
    summary.ok = !summary.blank && (!summary.primaryAction.available || summary.primaryAction.changed) && summary.consoleErrorCount === 0 && summary.pageErrorCount === 0 && (!summary.semanticSuccess.available || summary.semanticSuccess.passed === true)
    summary.gate = summary.ok ? 'PASS' : 'FAIL'
  } catch (err) {
    if (isHarnessInfrastructureError(err)) {
      summary.gate = 'NEEDS-EVIDENCE'
      summary.evidenceMode = 'unavailable'
      summary.blank = false
      summary.notes.push(`Browser evidence unavailable: ${err.message}`)
      summary.notes.push('This is an evidence infrastructure failure, not proof that the app is broken.')
    } else {
      summary.gate = 'FAIL'
      summary.notes.push(`Browser evidence failed: ${err.message}`)
    }
  } finally {
    await browser?.close().catch(() => {})
    await new Promise(resolve => server?.close(resolve) || resolve())
  }

  writeSummary(summary)
  console.log(`${summary.gate} ${summaryMdPath}`)
}

main().catch(err => {
  const infra = isHarnessInfrastructureError(err)
  const summary = {
    ok: false,
    gate: infra ? 'NEEDS-EVIDENCE' : 'FAIL',
    runNumber,
    runType,
    repo,
    evidenceDir,
    summaryPath,
    summaryMdPath,
    appType: 'unknown',
    blank: !infra,
    consoleErrorCount: 0,
    pageErrorCount: 0,
    evidenceMode: infra ? 'unavailable' : 'none',
    topTierEligible: false,
    primaryAction: { available: false, checked: false, changed: false },
    semanticContract: { present: false, reason: 'harness crashed before inspection' },
    semanticSuccess: { available: false, passed: null },
    notes: [infra ? `App evidence unavailable: ${err.message}` : `App evidence harness crashed: ${err.message}`],
  }
  writeSummary(summary)
  console.error(err.stack || err.message)
  process.exitCode = 1
})
