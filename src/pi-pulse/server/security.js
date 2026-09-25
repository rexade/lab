// Control-plane write guard and generated-app isolation.
// Pi Pulse can start runners, delete slots, restart itself, and reboot the Pi,
// so every non-GET /api request passes through requireTrustedWrite.
import {
  GENERATED_APP_CSP,
  PROXY_WRITE_HEADER_NAMES,
  REQUIRE_WRITE_AUTH,
  TRUST_CLOUDFLARE_ACCESS,
  WRITE_AUTH_TOKEN,
} from './config.js'

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

export function isWriteMethod(method) {
  return WRITE_METHODS.includes(method)
}

function bearerToken(req) {
  const auth = String(req.get('authorization') || '')
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function hasCloudflareAccessIdentity(req) {
  return Boolean(req.get('cf-access-authenticated-user-email') || req.get('cf-access-jwt-assertion'))
}

function isProxiedWrite(req) {
  return PROXY_WRITE_HEADER_NAMES.some(name => req.get(name))
}

function hasTrustedWriteIdentity(req) {
  if (WRITE_AUTH_TOKEN) {
    const supplied = req.get('x-pi-pulse-admin-token') || bearerToken(req)
    if (supplied === WRITE_AUTH_TOKEN) return true
  }
  if (TRUST_CLOUDFLARE_ACCESS && hasCloudflareAccessIdentity(req)) return true
  if (TRUST_CLOUDFLARE_ACCESS) return false
  return !REQUIRE_WRITE_AUTH && !isProxiedWrite(req)
}

export function requireTrustedWrite(req, res, next) {
  if (!isWriteMethod(req.method)) return next()
  if (hasTrustedWriteIdentity(req)) return next()
  return res.status(401).json({
    ok: false,
    code: 'WRITE_AUTH_REQUIRED',
    error: 'write routes require Cloudflare Access identity or PI_PULSE_ADMIN_TOKEN',
  })
}

export function generatedAppSecurityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', GENERATED_APP_CSP)
  res.setHeader('X-Pi-Pulse-App-Isolation', 'restricted-csp')
  next()
}

function requestPathFromHeader(value, req) {
  if (!value) return ''
  try {
    return new URL(String(value), `http://${req.get('host') || '127.0.0.1'}`).pathname
  } catch {
    return ''
  }
}

// Generated incubator apps are served same-origin, so a page under a play route
// could otherwise POST to the control plane with the operator's credentials.
export function createGeneratedAppWriteGuard(isGeneratedAppPath) {
  return function rejectGeneratedAppControlWrite(req, res, next) {
    if (!isWriteMethod(req.method)) return next()
    const refPath = requestPathFromHeader(req.get('referer'), req)
    if (!refPath || !isGeneratedAppPath(refPath)) return next()
    return res.status(403).json({
      ok: false,
      code: 'APP_CONTROL_API_FORBIDDEN',
      error: 'generated app routes cannot call Pi Pulse control-plane writes',
    })
  }
}
