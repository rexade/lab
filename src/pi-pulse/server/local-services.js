// Local Pi services a generated app may call, same-origin, through Pi Pulse.
// A project opts in by listing names in status.json `localServices`; the
// registry below (not the project) decides the target and which paths are
// reachable, so an app can chat with Ollama but never pull or delete models.
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { HAILO_URL } from './config.js'

export const SERVICE_PATH_SEGMENT = '_services'
const MAX_BODY_BYTES = 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 180000

export const LOCAL_SERVICES = {
  ollama: {
    target: HAILO_URL,
    methods: ['GET', 'POST'],
    paths: [/^\/api\/(tags|chat|generate)$/],
    probe: '/api/tags',
    about: 'Local Ollama language model on the Pi. POST api/chat with {"model", "messages", "stream": false}; GET api/tags lists models. The installed model is small and slow on a Pi: keep prompts short, expect several seconds per reply, and design for it being wrong or unavailable.',
  },
  brain: {
    target: process.env.PI_PULSE_BRAIN_URL || 'http://127.0.0.1:8085',
    methods: ['GET', 'POST'],
    paths: [/^\/ingest$/, /^\/api\/job\/[A-Za-z0-9_-]+$/],
    probe: null,
    about: 'Brain, the owner\'s YouTube summarizer. POST ingest (form field "url") starts a summary job; GET api/job/<id> returns its JSON status and summary. There is no endpoint that lists past summaries.',
  },
}

export function projectServices(cfg = {}) {
  const wanted = Array.isArray(cfg.localServices) ? cfg.localServices : []
  return [...new Set(wanted.map(String))].filter(name => Object.hasOwn(LOCAL_SERVICES, name))
}

// CSP source that lets a page reach only its own service paths. Scheme-less, so
// it follows the page's scheme behind the tunnel; null when the host is unusable.
export function serviceConnectSource(host, slug) {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(String(host || ''))) return null
  return `${host}/${slug}/${SERVICE_PATH_SEGMENT}/`
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// Plain Node req/res (Express's work too), so the lab's browser-evidence server
// can forward the same calls the live play route does.
export function proxyServiceRequest(name, subpath, req, res) {
  const service = Object.hasOwn(LOCAL_SERVICES, name) ? LOCAL_SERVICES[name] : null
  if (!service) return sendJson(res, 404, { ok: false, code: 'UNKNOWN_SERVICE', error: `no local service named ${name}` })
  if (!service.methods.includes(req.method)) return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `${req.method} is not allowed for ${name}` })
  const path = `/${String(subpath || '').replace(/^\/+/, '')}`
  if (path.split('/').some(segment => segment === '..' || segment === '.') || !service.paths.some(pattern => pattern.test(path))) {
    return sendJson(res, 403, { ok: false, code: 'SERVICE_PATH_FORBIDDEN', error: `${path} is not reachable on ${name}` })
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', error: 'request body over 1 MB' })

  const raw = req.originalUrl || req.url || ''
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
  const url = new URL(path + query, service.target)
  const headers = {}
  for (const header of ['content-type', 'accept', 'content-length']) if (req.headers[header]) headers[header] = req.headers[header]

  const upstream = http.request(url, { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS }, reply => {
    const out = {}
    for (const header of ['content-type', 'cache-control']) if (reply.headers[header]) out[header] = reply.headers[header]
    res.writeHead(reply.statusCode || 502, out)
    reply.pipe(res)
  })
  upstream.on('timeout', () => upstream.destroy(new Error('timed out')))
  upstream.on('error', err => {
    if (res.headersSent) return res.destroy()
    sendJson(res, 502, { ok: false, code: 'SERVICE_UNAVAILABLE', error: `${name} is unavailable: ${err.message}` })
  })
  let seen = 0
  req.on('data', chunk => {
    seen += chunk.length
    if (seen > MAX_BODY_BYTES) {
      upstream.destroy(new Error('request body over 1 MB'))
      req.destroy()
    }
  })
  req.pipe(upstream)
}

// Runs outside the builder's sandbox (which has no network), so the builder
// learns what each service really answers before designing against it.
export function probeService(name) {
  const service = LOCAL_SERVICES[name]
  if (!service?.probe) return null
  const result = spawnSync('curl', ['-s', '-m', '4', '-w', '\n%{http_code}', new URL(service.probe, service.target).href], { encoding: 'utf8', timeout: 6000 })
  const lines = String(result.stdout || '').trimEnd().split('\n')
  const code = lines.pop()
  if (result.status !== 0 || !/^2\d\d$/.test(code)) return `GET ${service.probe.slice(1)} failed (${code || 'no answer'}); the service may be down`
  return `GET ${service.probe.slice(1)} answered: ${lines.join(' ').slice(0, 400)}`
}
