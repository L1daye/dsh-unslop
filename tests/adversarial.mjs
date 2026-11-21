// dsh-unslop — adversarial / edge-case test suite. Tries hard to break the plugin and reports any
// FAIL as a candidate bug. Three areas: MCP server protocol, host half (stub ctx), HTTP routes (auth).
//
//   node tests/adversarial.mjs
//
// Exit 1 if any assertion fails.

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SERVER = path.join(ROOT, 'mcp', 'server.mjs')

let pass = 0, fail = 0
const failures = []
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) } }

// ===================== A. MCP server protocol =====================
async function mcpSuite() {
  console.log('\n== A. MCP server protocol ==')
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''; const waiters = new Map(); let nextId = 1; const notes = []; const frames = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      frames.push(m)
      if (m.id !== undefined && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); m.error ? w.reject(Object.assign(new Error(m.error.message || 'err'), { code: m.error.code })) : w.resolve(m.result) }
      else if (m.method) notes.push(m.method)
    }
  })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {})
  const req = (method, params, timeout = 15000) => { const id = nextId++; const msg = { jsonrpc: '2.0', id, method }; if (params !== undefined) msg.params = params; return new Promise((res, rej) => { waiters.set(id, { resolve: res, reject: rej }); child.stdin.write(JSON.stringify(msg) + '\n'); setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error('timeout ' + method)) } }, timeout) }) }
  const raw = (s) => child.stdin.write(s)
  const tool = async (name, args) => { const r = await req('tools/call', { name, arguments: args }); return { ok: r.isError !== true, text: (r.content || []).map((b) => b.text).join('\n') } }

  try {
    const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv', version: '0' } })
    ok('initialize returns serverInfo', init.serverInfo && init.serverInfo.name === 'unslop')
    ok('initialize advertises tools/resources/prompts', !!(init.capabilities.tools && init.capabilities.resources && init.capabilities.prompts))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

    // unknown method => JSON-RPC error -32601
    let unknownErr = null
    try { await req('no/such/method', {}) } catch (e) { unknownErr = e }
    ok('unknown method -> protocol error -32601', unknownErr && unknownErr.code === -32601, unknownErr && String(unknownErr.code))

    // ping
    const ping = await req('ping', {})
    ok('ping -> {}', ping && typeof ping === 'object')

    // tools/list shape
    const tl = await req('tools/list')
    ok('tools/list has 4 tools', (tl.tools || []).length === 4)

    // unknown tool -> isError (not crash)
    const unk = await tool('does_not_exist', {})
    ok('unknown tool -> isError result', unk.ok === false && /unknown tool/i.test(unk.text))

    // unslop_read: missing name
    ok('unslop_read missing name -> isError', (await tool('unslop_read', {})).ok === false)
    // unslop_read: prototype pollution attempt
    ok('unslop_read "__proto__" -> isError (no pollution)', (await tool('unslop_read', { name: '__proto__' })).ok === false)
    ok('unslop_read "constructor" -> isError', (await tool('unslop_read', { name: 'constructor' })).ok === false)
    // unslop_read: path traversal
    ok('unslop_read path traversal -> isError', (await tool('unslop_read', { name: '../../etc/passwd' })).ok === false)
    ok('unslop_read "signs.md" accepted', (await tool('unslop_read', { name: 'signs.md' })).ok === true)
    // all six refs readable
    const refs = ['signs', 'tokens', 'visuals', 'refs', 'effects', 'rtl']
    let allRead = true
    for (const r of refs) { const x = await tool('unslop_read', { name: r }); if (!x.ok || x.text.length < 200) allRead = false }
    ok('all 6 references read (len>200)', allRead)

    // resources/read traversal must NOT leak files
    let leak = null
    try { await req('resources/read', { uri: 'unslop://reference/../../../../etc/passwd' }) } catch (e) { leak = e }
    ok('resources/read traversal -> error (no file leak)', leak !== null)
    let badUri = null
    try { await req('resources/read', { uri: 'file:///etc/passwd' }) } catch (e) { badUri = e }
    ok('resources/read foreign uri -> error', badUri !== null)

    // prompts
    const pl = await req('prompts/list')
    ok('prompts/list has unslop', (pl.prompts || []).some((p) => p.name === 'unslop'))
    const pg = await req('prompts/get', { name: 'unslop', arguments: { target: 'x' } })
    ok('prompts/get returns a message', pg.messages && pg.messages.length >= 1)

    // snapshot with missing args -> isError
    ok('unslop_snapshot missing args -> isError', (await tool('unslop_snapshot', {})).ok === false)
    // story with no out -> must fail gracefully (isError), not hang/crash
    const story = await tool('unslop_story', { storyHtml: 'x.html' })
    ok('unslop_story no out -> graceful isError', story.ok === false)

    // snapshot when Playwright absent must be isError with guidance (out confined under ROOT/plugin dir)
    const snapOut = path.join(ROOT, 'adv_' + Date.now() + '.html')
    const snap = await tool('unslop_snapshot', { url: 'about:blank', out: snapOut })
    ok('unslop_snapshot w/o Playwright -> graceful isError', snap.ok === false && /playwright/i.test(snap.text), snap.text.slice(0, 80))
    try { fs.rmSync(snapOut, { force: true }) } catch {}
    try { fs.rmSync(snapOut.replace(/\.html?$/, '') + '.live.png', { force: true }) } catch {}

    // path confinement: out / local input must stay under the project root
    ok('snapshot out traversal -> rejected', (await tool('unslop_snapshot', { url: 'about:blank', out: '../../evil.html' })).text.match(/escapes project root/))
    ok('snapshot local url escape -> rejected', (await tool('unslop_snapshot', { url: '/etc/passwd', out: 'x.html' })).text.match(/escapes project root/))
    ok('snapshot out=URL -> rejected (local required)', (await tool('unslop_snapshot', { url: 'https://x', out: 'http://y/z.html' })).ok === false)
    ok('story input traversal -> rejected', (await tool('unslop_story', { storyHtml: '../x.html' })).text.match(/escapes project root/))

    // invalid JSON line then valid ping => server survives
    raw('this is not json\n')
    const ping2 = await req('ping', {})
    ok('server survives malformed JSON line', ping2 !== undefined)

    // CRLF-terminated message still parses
    const idCrlf = 9999
    raw(JSON.stringify({ jsonrpc: '2.0', id: idCrlf, method: 'ping' }) + '\r\n')
    const crlf = await new Promise((res) => { const t = setTimeout(() => res(null), 3000); waiters.set(idCrlf, { resolve: () => { clearTimeout(t); res({ ok: true }) }, reject: () => { clearTimeout(t); res(null) } }) })
    ok('CRLF-terminated message parsed', crlf && crlf.ok === true)

    // concurrency: 15 parallel unslop_read, ids must all match & content correct
    const conc = await Promise.all(Array.from({ length: 15 }, (_, k) => tool('unslop_read', { name: k % 2 ? 'signs' : 'tokens' })))
    ok('15 concurrent calls all resolve ok', conc.every((x) => x.ok === true))
    ok('concurrent signs/tokens content distinct', conc.every((x, k) => (k % 2 ? /slop/i.test(x.text) : /Tokens|spacing/i.test(x.text))))

    // large argument (100KB name) handled without crash
    const big = await tool('unslop_read', { name: 'a'.repeat(100000) })
    ok('100KB arg -> isError (no crash)', big.ok === false)

    // --- hardening regressions (from the audits) ---
    frames.length = 0
    raw('null\n')
    await new Promise((r) => setTimeout(r, 150))
    const p3 = await req('ping', {})
    ok('null line -> Invalid Request, server survives', p3 !== undefined)
    ok('null line produced a -32600 frame', frames.some((f) => f.error && f.error.code === -32600))

    frames.length = 0
    raw(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }) + '\n')
    await new Promise((r) => setTimeout(r, 200))
    ok('notification tools/list -> no reply frame', !frames.some((f) => f.result !== undefined && (f.id === undefined || f.id === null)))

    frames.length = 0
    raw('garbage{{{\n')
    await new Promise((r) => setTimeout(r, 150))
    ok('parse error -> -32700', frames.some((f) => f.error && f.error.code === -32700))

    let resUnk = null, prUnk = null
    try { await req('resources/read', { uri: 'unslop://reference/nope' }) } catch (e) { resUnk = e }
    ok('unknown resource -> -32002', resUnk && resUnk.code === -32002, resUnk && String(resUnk.code))
    try { await req('prompts/get', { name: 'nope' }) } catch (e) { prUnk = e }
    ok('unknown prompt -> -32602', prUnk && prUnk.code === -32602, prUnk && String(prUnk.code))
  } catch (e) {
    fail++; failures.push('A exception: ' + e.message); console.error('  FAIL A exception: ' + e.message)
  } finally {
    child.stdin.end(); child.kill('SIGTERM')
  }
}

// ===================== B + C. host half & routes via stub ctx =====================
async function hostSuite() {
  console.log('\n== B. host half (stub ctx) ==')
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-home-'))
  process.env.DSH_HOME = tmpHome
  const { apply } = await import(pathToFileURL(path.join(ROOT, 'host', 'index.js')).href)

  const tools = new Map(); const routes = new Map()
  const ctx = {
    tools: { register(def) { if (tools.has(def.name)) throw new Error('dup ' + def.name); tools.set(def.name, def); return () => tools.delete(def.name) } },
    inject(names, cb) {
      if (names.includes('webServer')) cb({ webServer: { register(def) { routes.set(def.path, def.handler); return () => {} } }, effect: (fn) => fn() })
      if (names.includes('workingDirectory')) cb({ workingDirectory: null })
    },
    effect(fn) { return fn() },
    logger: { warn() {} },
  }
  // weird config must not throw
  try { apply(ctx, { projectDir: 123, callTimeoutMs: 'x', mcpArgs: 'bad', trustedHosts: 'no', installSkillOnBoot: false }); ok('apply tolerates bad config types', true) }
  catch (e) { ok('apply tolerates bad config types', false, e.message) }

  const deadline = Date.now() + 15000
  while (Date.now() < deadline && (routes.size < 3 || tools.size < 7)) await new Promise((r) => setTimeout(r, 100))
  ok('7 tools registered', tools.size === 7, [...tools.keys()].join(','))
  ok('3 routes registered', routes.size === 3, [...routes.keys()].join(','))

  // corrupt bridge.json -> status surface defaults to all (no throw)
  const bridgeDir = path.join(tmpHome, 'plugins-data', 'unslop'); fs.mkdirSync(bridgeDir, { recursive: true })
  fs.writeFileSync(path.join(bridgeDir, 'bridge.json'), '{ this is not json ')
  try { const st = await tools.get('unslop_status').execute({}, { agent: null }); ok('corrupt bridge.json -> status defaults to all', st.surface === 'all', String(st.surface)) }
  catch (e) { ok('corrupt bridge.json -> status defaults to all', false, e.message) }

  // surface invalid tier throws
  let threw = false
  try { await tools.get('unslop_surface').execute({ surface: 'bogus' }, { agent: null }) } catch { threw = true }
  ok('unslop_surface invalid tier throws', threw)

  // surface glob allow list: unslop_* should keep all 4
  const surf = tools.get('unslop_surface')
  const g = await surf.execute({ allow: ['unslop_*'] }, { agent: null })
  ok('allow ["unslop_*"] keeps 4 mcp tools', g.mcp.visible === 4, JSON.stringify(g.mcp))
  const off = await surf.execute({ enabled: false }, { agent: null })
  ok('enabled:false hides all mcp tools', off.mcp.visible === 0)
  const back = await surf.execute({ surface: 'all' }, { agent: null })
  ok('surface all restores 4', back.mcp.visible === 4)

  // deps probe (no install) does not throw
  const deps = await tools.get('unslop_deps').execute({}, { agent: null })
  ok('unslop_deps probe returns booleans', typeof deps.playwright === 'boolean' && typeof deps.ffmpeg === 'boolean')

  // ===================== C. routes =====================
  console.log('\n== C. HTTP routes / auth ==')
  const call = (handler, { method = 'GET', headers = {}, body, socket } = {}) => new Promise((resolve) => {
    const req = new EventEmitter(); req.method = method; req.headers = headers; if (socket) req.socket = socket
    const res = { _s: 200, _b: '', writeHead(s) { this._s = s }, end(chunk) { this._b += chunk || ''; let j = null; try { j = JSON.parse(this._b) } catch {} resolve({ status: this._s, json: j }) } }
    handler(req, res)
    if (body !== undefined) { req.emit('data', typeof body === 'string' ? body : JSON.stringify(body)); req.emit('end') } else req.emit('end')
  })
  const loop = { host: '127.0.0.1:11648' }
  const tokRes = await call(routes.get('/unslop/api/token'), { headers: loop })
  ok('token: loopback -> 200 + token', tokRes.status === 200 && typeof tokRes.json.token === 'string' && tokRes.json.token.length > 20)
  ok('token: non-loopback host -> 403', (await call(routes.get('/unslop/api/token'), { headers: { host: 'evil.com' } })).status === 403)
  const auth = { ...loop, authorization: `Bearer ${tokRes.json.token}` }
  ok('surface: no bearer -> 401', (await call(routes.get('/unslop/api/surface'), { headers: loop })).status === 401)
  ok('surface: wrong bearer -> 401', (await call(routes.get('/unslop/api/surface'), { headers: { ...loop, authorization: 'Bearer deadbeefdeadbeef' } })).status === 401)
  ok('surface: evil origin -> 403', (await call(routes.get('/unslop/api/surface'), { headers: { ...auth, origin: 'http://evil.com' } })).status === 403)
  ok('surface GET -> 200 total 4', (await call(routes.get('/unslop/api/surface'), { headers: auth })).json.mcp.total === 4)
  ok('surface POST invalid tier -> 400', (await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { surface: 'nope' } })).status === 400)
  ok('surface POST invalid JSON -> 500', (await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: 'not json' })).status === 500)
  const tooBig = 'x'.repeat(9000)
  ok('surface POST body>8KB -> 5xx (not hang)', (await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { allow: [tooBig] } })).status >= 500)
  ok('surface POST allow[] -> 200', (await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { allow: ['unslop_read'] } })).json.ok === true)
  await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { surface: 'all' } })
  ok('status route -> 200 running', (await call(routes.get('/unslop/api/status'), { headers: auth })).json.mcp.running === true)
  ok('surface: non-loopback peer -> 403', (await call(routes.get('/unslop/api/surface'), { headers: auth, socket: { remoteAddress: '10.1.2.3' } })).status === 403)
  ok('surface: loopback peer -> 200', (await call(routes.get('/unslop/api/surface'), { headers: auth, socket: { remoteAddress: '127.0.0.1' } })).status === 200)
  ok('surface POST "__proto__" -> 400', (await call(routes.get('/unslop/api/surface'), { method: 'POST', headers: auth, body: { surface: '__proto__' } })).status === 400)

  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

await mcpSuite()
await hostSuite()
console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(' - ' + f) }
process.exit(fail === 0 ? 0 : 1)
