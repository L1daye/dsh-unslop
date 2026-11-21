// dsh-unslop — smoke test. No DeepSeek Harness needed: it spawns the packaged MCP server and
// asserts the protocol handshake and the tool/resource/prompt surface.
//
//   node tests/smoke.mjs
//
// Exit code 0 = every assertion passed.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '..', 'mcp', 'server.mjs')

let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = ''
const waiters = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && waiters.has(message.id)) {
      const { resolve, reject } = waiters.get(message.id)
      waiters.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', () => { /* server logs to stderr; ignore */ })

function request(method, params) {
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method }
  if (params !== undefined) message.params = params
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify(message)}\n`)
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`${method} timed out`)) } }, 10_000)
  })
}

async function main() {
  console.log('unslop MCP server smoke test')
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
    ok('initialize returns serverInfo', init && init.serverInfo && init.serverInfo.name === 'unslop', JSON.stringify(init && init.serverInfo))
    ok('initialize advertises tools/resources/prompts', Boolean(init && init.capabilities && init.capabilities.tools && init.capabilities.resources && init.capabilities.prompts))

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const tools = await request('tools/list')
    const names = (tools.tools || []).map((t) => t.name).sort()
    ok('tools/list has 4 tools', names.length === 4, names.join(','))
    ok('tools include unslop_read', names.includes('unslop_read'))
    ok('tools include unslop_snapshot', names.includes('unslop_snapshot'))

    const resources = await request('resources/list')
    ok('resources/list has 6 references', (resources.resources || []).length === 6, String((resources.resources || []).length))

    const prompts = await request('prompts/list')
    ok('prompts/list has the unslop prompt', (prompts.prompts || []).some((p) => p.name === 'unslop'))

    const read = await request('tools/call', { name: 'unslop_read', arguments: { name: 'signs' } })
    const text = read.content && read.content[0] && read.content[0].text || ''
    ok('unslop_read signs returns the checklist', text.length > 500 && /slop|gradient|spacing/i.test(text), `${text.length} chars`)

    const bad = await request('tools/call', { name: 'unslop_read', arguments: { name: 'nope' } })
    ok('unslop_read rejects an unknown name', bad.isError === true)

    const res = await request('resources/read', { uri: 'unslop://reference/tokens' })
    ok('resources/read returns tokens body', res.contents && res.contents[0] && res.contents[0].text.length > 500)
  } catch (error) {
    failed += 1
    console.error(`  FAIL unexpected error: ${error.message}`)
  } finally {
    child.stdin.end()
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 100)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
