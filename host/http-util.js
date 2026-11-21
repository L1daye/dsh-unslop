// dsh-unslop — HTTP shell for the management routes the composer chip reads.
//
// One random Bearer token per Harness process, a loopback Host/Origin fence on top of DSH's own
// connection admission, and the shared helpers the route handlers use. Split out of index.js so the
// routes read without scrolling past the tool definitions.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function createHttpAuth(ctx, settings = {}, tokenFile) {
  const token = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    fs.writeFileSync(tokenFile, `${token}` + '\n', { mode: 0o600 })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-unslop: could not write ${tokenFile}: ${error?.message || error}`)
  }
  return { token, settings }
}

export function headerOf(headers, name) {
  const value = headers ? headers[name] || headers[name.toLowerCase()] : null
  return Array.isArray(value) ? value[0] : value || null
}

export function authorityOf(value) {
  if (!value) return null
  try { return new URL(String(value)).host.toLowerCase() } catch { return String(value).toLowerCase() }
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

export function hostAllowed(req, auth) {
  const authority = headerOf(req.headers, 'host')
  if (!authority) return false
  if (isLoopbackHostname(String(authority).split(':')[0])) return true
  return (auth.settings.trustedHosts || []).map((e) => String(e).toLowerCase()).includes(String(authority).toLowerCase())
}

export function originAllowed(req, auth) {
  const origin = headerOf(req.headers, 'origin')
  if (!origin) return true
  const host = authorityOf(origin)
  if (!host) return false
  if (isLoopbackHostname(String(host).split(':')[0])) return true
  return (auth.settings.trustedHosts || []).map((e) => String(e).toLowerCase()).includes(String(host))
}

export function bearerOf(req) {
  const raw = headerOf(req.headers, 'authorization')
  if (!raw) return null
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim())
  return match ? match[1].trim() : null
}

export function constantEquals(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch { /* client gone */ }
}

export function rejectRequest(req, res, auth, options = {}) {
  if (!hostAllowed(req, auth)) return sendJson(res, 403, { ok: false, error: 'host not allowed' })
  if (!originAllowed(req, auth)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
  if (options.token !== false) {
    const presented = bearerOf(req)
    if (!presented || !constantEquals(presented, auth.token)) return sendJson(res, 401, { ok: false, error: 'missing or stale token' })
  }
  return null
}

export function guarded(handler, auth, options = {}) {
  return async (req, res) => {
    if (rejectRequest(req, res, auth, options)) return
    try { await handler(req, res) } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}

export function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) { reject(new Error('body too large')); req.destroy?.() }
    })
    req.on('end', () => {
      if (!body.trim()) return resolve({})
      try { resolve(JSON.parse(body)) } catch (error) { reject(new Error(`body is not JSON: ${String(error?.message || error)}`)) }
    })
    req.on('error', reject)
  })
}
