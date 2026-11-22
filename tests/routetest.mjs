// dsh-unslop — HTTP route test with a stub ctx + fake req/res. Verifies the two routes the composer
// chip depends on: token bootstrap and surface read/switch, including bearer auth and the loopback fence.
//
//   node tests/routetest.mjs

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unslop-route-'))
process.env.DSH_HOME = tmpHome
const { apply } = await import(pathToFileURL(path.resolve(HERE, '..', 'host', 'index.js')).href)

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) } }

const routes = new Map()
const tools = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  inject(names, cb) {
    if (names.includes('webServer')) cb({ webServer: { register(def) { routes.set(def.path, def.handler); return () => {} } }, effect: (fn) => fn() })
    if (names.includes('workingDirectory')) cb({ workingDirectory: null })
  },
  effect(fn) { const c = fn(); return c },
  logger: { warn() {} },
}
apply(ctx, { installSkillOnBoot: false })

const deadline = Date.now() + 15000
while (Date.now() < deadline && (routes.size < 3 || tools.size < 8)) await new Promise((r) => setTimeout(r, 100))
ok('routes registered', routes.has('/unslop/api/token') && routes.has('/unslop/api/surface'), [...routes.keys()].join(','))
ok('mcp tools registered before surface checks', tools.size === 8, String(tools.size))

function call(handler, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = headers
    const res = {
      _status: 200, _body: '',
      writeHead(status) { this._status = status },
      end(chunk) { this._body += chunk || ''; let json = null; try { json = JSON.parse(this._body) } catch {} resolve({ status: this._status, json }) },
    }
    handler(req, res)
    if (body !== undefined) { req.emit('data', typeof body === 'string' ? body : JSON.stringify(body)); req.emit('end') }
    else req.emit('end')
  })
}

const loopback = { host: '127.0.0.1:11648' }
try {
  const tok = await call(routes.get('/unslop/api/token'), { headers: loopback })
  ok('token route 200 + token', tok.status === 200 && typeof tok.json.token === 'string' && tok.json.token.length > 20)

  const noAuth = await call(routes.get('/unslop/api/surface'), { headers: loopback })
  ok('surface without bearer -> 401', noAuth.status === 401)

  const auth = { ...loopback, authorization: `Bearer ${tok.json.token}` }
  const get1 = await call(routes.get('/unslop/api/surface'), { headers: auth })
  ok('surface GET -> 200', get1.status === 200 && get1.json.ok === true)
  ok('surface GET reports mcp counts', get1.json.mcp && get1.json.mcp.total === 4, JSON.stringify(get1.json.mcp))

  const setCore = await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { surface: 'core' } })
  ok('surface POST core -> visible 2', setCore.status === 200 && setCore.json.mcp.visible === 2, JSON.stringify(setCore.json.mcp))
  ok('surface POST core persists name', setCore.json.surface === 'core')

  const setAll = await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { surface: 'all' } })
  ok('surface POST all -> visible 4', setAll.json.mcp.visible === 4)

  const badHost = await call(routes.get('/unslop/api/surface'), { headers: { host: 'evil.example.com', authorization: `Bearer ${tok.json.token}` } })
  ok('non-loopback host -> 403', badHost.status === 403)
} catch (error) {
  failed++; console.error(`  FAIL route exception: ${error.message}`)
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
