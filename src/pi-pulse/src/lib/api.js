// Every Pi Pulse API call goes through here so an HTML page (a proxy login, the
// SPA fallback, a crashed route) surfaces as an explicit error instead of a
// cryptic "Unexpected token '<'".
export async function readApiJson(response, label = 'API request') {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const contentType = response.headers?.get?.('content-type') || 'unknown content-type'
    const kind = text.trim().startsWith('<') ? 'returned HTML instead of JSON' : 'returned non-JSON'
    throw new Error(`${label} ${kind} (${response.status} ${contentType})`)
  }
}

export async function fetchApiJson(url, options, fetchImpl = fetch) {
  const response = await fetchImpl(url, options)
  const data = await readApiJson(response, url)
  return { response, data }
}

export function postJson(url, body, fetchImpl = fetch) {
  return fetchApiJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }, fetchImpl)
}

// Machine-readable blocks from mutating routes become one human sentence.
export function mutationBlockMessage(data = {}, fallback = 'request failed') {
  if (data.code === 'STALE_SERVICE_SOURCE') return 'Pi Pulse is running stale code; restart it to apply the latest source.'
  if (data.code === 'GLOBAL_RUN_LOCK_ACTIVE') {
    const owner = data.owner?.id ? ` (${data.owner.id})` : ''
    return `Another run is in progress${owner}; the lab runs one at a time.`
  }
  const failed = (data.preflight || data.setup)?.checks?.find(check => !check.ok)
  if (failed) return `${failed.label}: ${failed.detail}`
  return data.error || fallback
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForPulseHealthy({ timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs
  await sleep(600)
  while (Date.now() < deadline) {
    try {
      const { response, data } = await fetchApiJson('/api/health', { cache: 'no-store' }, fetchImpl)
      if (response.ok && data.ok) return data
    } catch {
      // The supervisor is bringing the service back.
    }
    await sleep(450)
  }
  throw new Error('Pi Pulse did not come back within 15s')
}
