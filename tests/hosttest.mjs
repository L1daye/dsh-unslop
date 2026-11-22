// dsh-unslop — host-half test with a stub ctx (no DeepSeek Harness). Verifies that apply()
// registers the two host tools plus the four bridged MCP tools, that the MCP client starts, and
// that a bridged call (unslop_read) round-trips through the real server.
//
//   node tests/hosttest.mjs

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Keep the skill install out of the real ~/.dsh
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unslop-home-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import(pathToFileURL(path.resolve(HERE, '..', 'host', 'index.js')).href)

let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const registered = new Map()
const disposers = []
const effects = []
const ctx = {
  tools: { register(def) { registered.set(def.name, def); const d = () => registered.delete(def.name); disposers.push(d); return d } },
  inject(_names, cb) { /* workingDirectory absent — base dir falls back to cwd */ },
  effect(fn, _label) { const cleanup = fn(); effects.push(cleanup) },
}

apply(ctx, { installSkillOnBoot: true })

// Wait for the async MCP client start inside the effect to settle.
const deadline = Date.now() + 15_000
while (Date.now() < deadline && registered.size < 8) await new Promise((r) => setTimeout(r, 100))

ok('host tool unslop_status registered', registered.has('unslop_status'))
ok('host tool unslop_deps registered', registered.has('unslop_deps'))
ok('host tool unslop_surface registered', registered.has('unslop_surface'))
ok('host tool unslop_detect registered', registered.has('unslop_detect'))
ok('mcp tool unslop_read registered', registered.has('mcp__unslop__unslop_read'), [...registered.keys()].join(','))
ok('all eight tools registered', registered.size === 8, String(registered.size))
ok('skill installed to DSH_HOME', fs.existsSync(path.join(tmpHome, 'skills', 'unslop', 'SKILL.md')))
ok('skill keeps the CC BY credit', (() => {
  try { return /@heydamir/.test(fs.readFileSync(path.join(tmpHome, 'skills', 'unslop', 'SKILL.md'), 'utf8')) } catch { return false }
})())

// Round-trip a bridged call
try {
  const def = registered.get('mcp__unslop__unslop_read')
  const result = await def.execute({ name: 'tokens' }, { agent: null })
  const text = (result.content || []).map((b) => b.text).join('\n')
  ok('bridged unslop_read returns tokens', result.ok !== false && text.length > 500, `${text.length} chars`)
  const rendered = def.output.render({ name: 'tokens' }, result)
  ok('bridged tool renders text blocks', Array.isArray(rendered) && rendered[0].type === 'text')
} catch (error) {
  failed += 1
  console.error(`  FAIL bridged call: ${error.message}`)
}

// Status tool shape
try {
  const status = await registered.get('unslop_status').execute({}, { agent: null })
  ok('status reports references count = 6', status.references === 6, String(status.references))
  ok('status reports mcp running', status.mcp.running === true)
} catch (error) {
  failed += 1
  console.error(`  FAIL status tool: ${error.message}`)
}

// Surface switch: core drops the heavy tools from the registry, all restores them.
try {
  const surf = registered.get('unslop_surface')
  const core = await surf.execute({ surface: 'core' }, { agent: null })
  ok('surface core -> 2/4 visible', core.mcp.visible === 2 && core.mcp.total === 4, JSON.stringify(core.mcp))
  ok('core keeps unslop_read', registered.has('mcp__unslop__unslop_read'))
  ok('core drops unslop_snapshot', !registered.has('mcp__unslop__unslop_snapshot'))
  const all = await surf.execute({ surface: 'all' }, { agent: null })
  ok('surface all -> 4/4 visible', all.mcp.visible === 4, JSON.stringify(all.mcp))
  ok('all restores unslop_snapshot', registered.has('mcp__unslop__unslop_snapshot'))
} catch (error) {
  failed += 1
  console.error(`  FAIL surface switch: ${error.message}`)
}

for (const cleanup of effects) { try { cleanup?.() } catch { /* ignore */ } }
try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
