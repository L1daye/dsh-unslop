// dsh-unslop — Host half.
//
// A thin dsh adapter over the standalone unslop MCP server (mcp/server.mjs). It owns:
//   - the MCP client (host/mcp-client.js) that spawns `node mcp/server.mjs`, whose four tools
//     (unslop_references / unslop_read / unslop_snapshot / unslop_story) it registers as
//     mcp__unslop__<tool>, filtered by the tool surface in <DSH_HOME>/plugins-data/unslop/bridge.json
//   - three direct host tools: unslop_status (probe), unslop_deps (Playwright/ffmpeg helper) and
//     unslop_surface (read/switch the tool surface)
//   - the workflow skill, installed into <DSH_HOME>/skills/unslop/ (SKILL.md + references + scripts)
//   - the authenticated management routes the composer chip reads:
//       GET  /unslop/api/token     bootstrap token (loopback + connection admission only)
//       GET  /unslop/api/surface   current surface + visible/total
//       POST /unslop/api/surface   { surface } | { enabled, allow }
//       GET  /unslop/api/status    light status for the chip / page
//
// No external binary to download: everything ships in this package and runs on the Node the
// Harness already uses. The heavy tools (snapshot needs Playwright+Chromium, story needs ffmpeg)
// are optional and probed on demand, not required to load.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createUnslopClient } from './mcp-client.js'
import { createHttpAuth, guarded, readJsonBody, sendJson } from './http-util.js'
import { scanPath, normalizeImpeccable, scoreItems } from '../mcp/detect.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const SKILL_SRC = path.join(PACKAGE_DIR, 'skills', 'unslop')
const SERVER = path.join(PACKAGE_DIR, 'mcp', 'server.mjs')
const NODE = process.execPath

const IS_WINDOWS = process.platform === 'win32'
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? path.resolve(process.env.DSH_HOME.trim())
  : path.join(HOME, '.dsh')
const SKILL_ROOT = path.join(DSH_HOME, 'skills', 'unslop')
const INSTALL_ROOT = path.join(DSH_HOME, 'plugins-data', 'unslop')
const BRIDGE_FILE = path.join(INSTALL_ROOT, 'bridge.json')
const TOKEN_FILE = path.join(INSTALL_ROOT, 'http.token')
const BASELINE_FILE = path.join(INSTALL_ROOT, 'detect-baseline.json')

const SERVER_NAME = 'unslop'
const TOOL_PREFIX = 'mcp__unslop__'

// Three tool surfaces the chip offers. `all` is the server's own list; `core` is only the read-only
// research tools (cheap on context); `off` disables every mcp__unslop__* tool for the session.
export const SURFACES = {
  off: { enabled: false, allow: [] },
  core: { enabled: true, allow: ['unslop_references', 'unslop_read'] },
  all: { enabled: true, allow: [] },
}
const SURFACE_ORDER = ['off', 'core', 'all']

// ---- tiny OS helpers --------------------------------------------------------------------
const whichCache = new Map()
function which(name) {
  const cached = whichCache.get(name)
  if (cached && Date.now() - cached.at < 60_000) return cached.value
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  let found = null
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try { if (fs.statSync(candidate).isFile()) { found = candidate; break } } catch { /* miss */ }
    }
    if (found) break
  }
  whichCache.set(name, { at: Date.now(), value: found })
  return found
}

function hasPlaywright() {
  const markers = [
    path.join(INSTALL_ROOT, 'node_modules', 'playwright'),
    path.join(INSTALL_ROOT, 'node_modules', 'playwright-core'),
    path.join(PACKAGE_DIR, 'node_modules', 'playwright'),
    path.join(PACKAGE_DIR, 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
  ]
  for (const marker of markers) {
    try { if (fs.statSync(marker).isDirectory()) return true } catch { /* miss */ }
  }
  return false
}

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, signal, env } = options
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { cwd: cwd || undefined, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message || error), ms: 0, error: String(error?.message || error) })
      return
    }
    let settled = false
    const finish = (code, errorMessage) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: stdout.slice(0, 120_000), stderr: stderr.slice(0, 120_000), ms: Date.now() - started, ...(errorMessage ? { error: errorMessage } : {}) })
    }
    const kill = () => { try { child.kill('SIGTERM') } catch { /* gone */ } }
    const onAbort = () => kill()
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    const timer = timeoutMs > 0 ? setTimeout(() => { kill(); finish(null, `timed out after ${timeoutMs} ms`) }, timeoutMs) : null
    timer?.unref?.()
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (e) => finish(null, String(e?.message || e)))
    child.on('close', (code) => finish(code))
  })
}

// ---- skill install: copy the whole skills/unslop tree, compose a dsh preamble into SKILL.md --
const SKILL_PREAMBLE = `<!-- dsh-unslop: this copy is installed and kept in sync by the DSH plugin. In DeepSeek
Harness the tools appear as mcp__unslop__*; if they are missing, call unslop_status, then
unslop_deps to see how to install Playwright/Chromium (only needed for snapshot and story). The
core audit -> direction -> nine passes workflow needs no external tool. Read the references with
the unslop_read tool (names: signs, tokens, visuals, refs, effects, rtl) rather than opening files.
For a quantified before/after, call unslop_detect {path, action:"baseline"} before fixing and
{action:"compare"} after; it uses the impeccable CLI if installed, else a built-in rule engine.
unslop by Damir Sokolovsky (@heydamir), CC BY 4.0 — keep this credit. -->
`

function composeSkill(source) {
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(source)
  if (!match) return `${SKILL_PREAMBLE}\n${source}`
  return `${match[1]}\n${SKILL_PREAMBLE}\n${source.slice(match[1].length)}`
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function installSkill(report = []) {
  try {
    if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) {
      report.push('skill sources are missing from the package')
      return { ok: false, dir: SKILL_ROOT, report }
    }
    fs.mkdirSync(SKILL_ROOT, { recursive: true })
    copyDir(SKILL_SRC, SKILL_ROOT)
    const installed = path.join(SKILL_ROOT, 'SKILL.md')
    fs.writeFileSync(installed, composeSkill(fs.readFileSync(installed, 'utf8')))
    report.push(`wrote ${SKILL_ROOT}`)
    return { ok: true, dir: SKILL_ROOT, report }
  } catch (error) {
    report.push(`cannot write the skill: ${String(error?.message || error)}`)
    return { ok: false, dir: SKILL_ROOT, report }
  }
}

// ---- surface: bridge.json is the single switch, read before registering MCP tools -------------
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function readSurface() {
  const parsed = readJsonFile(BRIDGE_FILE)
  const enabled = !(parsed && parsed.enabled === false)
  const allow = parsed && Array.isArray(parsed.allow) ? parsed.allow.filter((entry) => typeof entry === 'string') : []
  let name = 'all'
  if (!enabled) name = 'off'
  else if (allow.length === 0) name = 'all'
  else {
    for (const [key, value] of Object.entries(SURFACES)) {
      if (!value.enabled || key === 'off') continue
      if (value.allow.slice().sort().join(',') === allow.slice().sort().join(',')) { name = key; break }
    }
  }
  return { surface: name, enabled, allow }
}

function writeSurface(patch) {
  const next = { enabled: patch.enabled !== false, allow: Array.isArray(patch.allow) ? patch.allow : [] }
  fs.mkdirSync(INSTALL_ROOT, { recursive: true })
  fs.writeFileSync(BRIDGE_FILE, `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  return readSurface()
}

function compileAllow(allow) {
  return allow.map((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp('^' + escaped + '$', 'i')
  })
}

function allowedNames(surface) {
  if (!surface.enabled) return () => false
  const matchers = compileAllow(surface.allow)
  if (matchers.length === 0) return () => true
  return (name) => matchers.some((matcher) => matcher.test(name))
}

// ---- base directory ---------------------------------------------------------------------
export const inject = ['tools']

let workingDirectoryService = null

export function resolveBaseDirInfo(settings, exec) {
  try {
    const session = exec && exec.agent ? exec.agent.session : null
    if (session && workingDirectoryService && typeof workingDirectoryService.get === 'function') {
      const dir = workingDirectoryService.get(session)
      if (typeof dir === 'string' && dir) return { dir, source: 'session' }
    }
  } catch { /* service absent */ }
  if (settings && settings.projectDir) return { dir: settings.projectDir, source: 'projectDir' }
  return { dir: process.cwd(), source: 'cwd' }
}
export function resolveBaseDir(settings, exec) {
  return resolveBaseDirInfo(settings, exec).dir
}

// ---- tools ------------------------------------------------------------------------------
function statusTool(settings, hooks) {
  return {
    name: 'unslop_status',
    description:
      'Report the unslop plugin: Node version, whether the MCP server is running and how many tools it serves on the current surface, whether the workflow skill is installed, and whether the optional heavy tools (Playwright for snapshot, ffmpeg for story) are available. Read-only.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        const lines = [
          `unslop: MCP ${v.mcp.running ? 'running' : 'NOT RUNNING'} — ${v.mcp.visible}/${v.mcp.total} tools on surface "${v.surface}"${v.mcp.serverVersion ? ` (server ${v.mcp.serverVersion})` : ''}`,
          `  node: ${v.node}`,
          `  skill: ${v.skill.installed ? v.skill.dir : 'NOT INSTALLED'}`,
          `  playwright (snapshot): ${v.playwright ? 'found' : 'missing'}${v.ffmpeg ? '  ffmpeg (story): found' : '  ffmpeg (story): missing'}`,
          `  references: ${v.references}`,
        ]
        if (!v.playwright) lines.push('  note: snapshot/story need Playwright — call unslop_deps to install, or ignore if you only edit code.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() { return hooks.statusReport() },
  }
}

function depsTool(settings, hooks) {
  return {
    name: 'unslop_deps',
    description:
      'Check, and optionally install, the optional heavy tools: Playwright + Chromium (for unslop_snapshot) and ffmpeg (for unslop_story). With install:true it runs `npm install -D playwright` then `npx playwright install chromium` in the plugin directory. The core audit workflow needs none of this.',
    parameters: {
      type: 'object',
      properties: {
        install: { type: 'boolean', description: 'Actually install Playwright + Chromium (default false = report only).' },
        timeoutMs: { type: 'integer', description: 'Per-command timeout for the install (default 300000).' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        const lines = [`playwright: ${v.playwright ? 'found' : 'missing'}   ffmpeg: ${v.ffmpeg ? 'found' : 'missing'}`]
        if (v.ran && v.ran.length) {
          for (const step of v.ran) lines.push(`  $ ${step.command} -> exit ${step.code ?? 'null'}${step.error ? ` (${step.error})` : ''}`)
        } else {
          lines.push('', `Installs into the persistent dir ${INSTALL_ROOT} (survives plugin redeploys):`, '  npm install --prefix <dir> playwright', '  npx playwright install chromium', `  # ffmpeg: ${IS_WINDOWS ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const probe = () => ({ playwright: hasPlaywright(), ffmpeg: Boolean(which('ffmpeg')) })
      if (args?.install !== true) return { ...probe(), ran: [] }
      const timeoutMs = Number.isFinite(args?.timeoutMs) ? Math.max(10_000, Math.trunc(args.timeoutMs)) : 300_000
      const npm = which('npm')
      if (!npm) return { ...probe(), ran: [{ command: 'npm', code: null, error: 'npm is not on PATH' }] }
      fs.mkdirSync(INSTALL_ROOT, { recursive: true })
      const ran = []
      const a = await run(npm, ['install', '--prefix', INSTALL_ROOT, 'playwright', '--no-save', '--no-audit', '--no-fund'], { cwd: INSTALL_ROOT, timeoutMs, signal: exec?.signal })
      ran.push({ command: `npm install --prefix ${INSTALL_ROOT} playwright`, code: a.code, error: a.error })
      const npx = which('npx')
      if (npx) {
        const b = await run(npx, ['playwright', 'install', 'chromium'], { cwd: INSTALL_ROOT, timeoutMs: timeoutMs * 2, signal: exec?.signal })
        ran.push({ command: 'npx playwright install chromium', code: b.code, error: b.error })
      }
      whichCache.clear()
      return { ...probe(), ran }
    },
  }
}

function surfaceTool(settings, hooks) {
  return {
    name: 'unslop_surface',
    description:
      'Read or switch which unslop MCP tools this Harness can see. Tiers: "off" (no tools), "core" (unslop_references / unslop_read only), "all" (every tool, including unslop_snapshot and unslop_story). The surface is written to bridge.json and re-applied to the tool registry immediately — no restart, no reconnect. Call with no argument to read it, or pass an explicit allow list of glob patterns.',
    parameters: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: SURFACE_ORDER, description: 'Tier to switch to. Leave out to read the current one.' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Explicit glob patterns instead of a tier, e.g. ["unslop_read","unslop_*"]. An empty list allows every tool.' },
        enabled: { type: 'boolean', description: 'With allow: false hides every tool (same as surface "off").' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        const counts = v.mcp && v.mcp.total ? ` — visible ${v.mcp.visible ?? '?'}/${v.mcp.total}` : ''
        return [{ type: 'text', text: `unslop tool surface: ${v.surface}${v.allow.length ? ` = ${v.allow.join(', ')}` : ' (every tool)'}${counts}` }]
      },
    },
    async execute(args) {
      let patch = null
      if (args && typeof args.surface === 'string') {
        const tier = Object.prototype.hasOwnProperty.call(SURFACES, args.surface) ? SURFACES[args.surface] : null
        if (!tier) throw new Error(`unknown surface "${args.surface}"; use one of ${SURFACE_ORDER.join(', ')}`)
        patch = tier
      } else if (args && Array.isArray(args.allow)) {
        patch = { enabled: args.enabled !== false, allow: args.allow.map(String) }
      } else if (args && args.enabled === false) {
        patch = SURFACES.off
      }
      if (patch) writeSurface(patch)
      const applied = hooks.applySurface()
      return { ...readSurface(), mcp: applied, mcpTools: hooks.registryCounts() }
    },
  }
}

// ---- detector (optional impeccable CLI, else built-in rules) --------------------------------
function readDetectBaselines() { try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) || {} } catch { return {} } }
function writeDetectBaselines(map) { try { fs.mkdirSync(INSTALL_ROOT, { recursive: true }); fs.writeFileSync(BASELINE_FILE, JSON.stringify(map, null, 2) + '\n') } catch { /* best effort */ } }

function detectTool(settings, hooks) {
  return {
    name: 'unslop_detect',
    description:
      'Deterministically scan UI source for AI-slop tells and score it 0-100 (higher = cleaner). Prefers the impeccable CLI when installed, else a built-in rule engine — offline, no model calls. Workflow: run with action:"baseline" before fixing, fix with the unslop passes, then action:"compare" to get the score delta. path defaults to the current folder; the scan is confined to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to scan, relative to the project. Default ".".' },
        engine: { type: 'string', enum: ['auto', 'builtin', 'impeccable'], description: 'auto (default): impeccable CLI if present, else built-in.' },
        action: { type: 'string', enum: ['scan', 'baseline', 'compare'], description: 'scan (default) | baseline (save score) | compare (delta vs saved baseline).' },
        maxIssues: { type: 'integer', description: 'Max issues to return (default 40, max 200).' },
        render: { type: 'boolean', description: 'Also run Playwright render checks (overflow / contrast / tiny font / tap target) on a single .html target. Requires Playwright.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        const lines = [`unslop_detect  score ${v.score}/100  [${v.engine}]  files=${v.files ?? '?'}  issues=${v.issueCount}  (high ${v.bySeverity.high} / med ${v.bySeverity.medium} / low ${v.bySeverity.low})  — ${v.rootLabel}`]
        if (v.delta !== undefined) lines.push(`Δ ${v.delta >= 0 ? '+' : ''}${v.delta} vs baseline ${v.baseline.score} (${v.baseline.ts})`)
        else if (v.baselineSaved) lines.push('· baseline saved for later compare')
        else if (v.baselineMissing) lines.push('· no baseline saved yet (run action:"baseline" first)')
        if (v.renderIssues !== undefined) lines.push(`· render 检查命中 ${v.renderIssues} 条（溢出/对比度/字号/触控）`)
        if (v.renderNote) lines.push(`· ${v.renderNote}`)
        for (const it of (v.issues || []).slice(0, 20)) lines.push(`  - ${it.file}:${it.line} [${it.sev}] ${it.rule}: ${it.message}`)
        if (v.issueCount > (v.issues || []).length) lines.push(`  … ${v.issueCount - (v.issues || []).length} more`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const base = resolveBaseDir(settings, exec)
      const rel = String(args?.path || '.')
      const target = path.resolve(base, rel)
      const relCheck = path.relative(base, target)
      if (relCheck === '..' || relCheck.startsWith('..' + path.sep) || path.isAbsolute(relCheck)) throw new Error(`path escapes project root: ${rel}`)
      if (!fs.existsSync(target)) throw new Error(`path not found: ${rel}`)
      const maxIssues = Math.min(200, Math.max(1, Number.isFinite(args?.maxIssues) ? Math.trunc(args.maxIssues) : 40))
      const wantEngine = String(args?.engine || 'auto')
      const cli = wantEngine === 'builtin' ? null : which('impeccable')
      let result = null
      if (cli && (wantEngine === 'auto' || wantEngine === 'impeccable')) {
        try {
          const r = await run(cli, ['detect', target, '--json'], { timeoutMs: 120_000, signal: exec?.signal })
          if (r.code === 0 || r.code === 2) {
            let json = null
            try { json = JSON.parse(r.stdout) } catch { json = null }
            if (json) result = normalizeImpeccable(json, target)
          }
        } catch { /* fall back to builtin */ }
      }
      if (!result) result = scanPath(target)
      let renderNote = null
      if (args?.render === true) {
        const st = fs.statSync(target)
        if (!st.isFile() || !/\.html?$/i.test(target)) {
          renderNote = 'render 检查仅支持单个 .html 文件'
        } else if (!hasPlaywright()) {
          renderNote = 'Playwright 未安装，已跳过 render 检查'
        } else {
          try {
            const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', UNSLOP_PLAYWRIGHT_HOME: path.join(INSTALL_ROOT, 'node_modules') }
            const r = await run(NODE, [path.join(PACKAGE_DIR, 'mcp', 'render-check.mjs'), pathToFileURL(target).href], { timeoutMs: 120_000, env, signal: exec?.signal })
            if (r.code === 0) {
              const j = JSON.parse(r.stdout)
              const relFile = path.relative(base, target) || path.basename(target)
              for (const it of (j.issues || [])) result.issues.push({ file: relFile, line: 0, rule: it.rule, sev: it.sev, message: it.message, snippet: '', count: 1 })
              const s = scoreItems(result.issues)
              result.score = s.score; result.penalty = s.penalty; result.bySeverity = s.bySeverity; result.counts = s.counts; result.issueCount = result.issues.length
              result.renderIssues = (j.issues || []).length
            } else {
              renderNote = r.code === 3 ? 'Playwright 未安装，已跳过 render 检查' : `render-check 退出码 ${r.code}`
            }
          } catch (e) { renderNote = 'render-check 失败: ' + String(e?.message || e) }
        }
      }
      const payload = { ...result, issues: result.issues.slice(0, maxIssues), rootLabel: path.relative(base, target) || '.', action: String(args?.action || 'scan') }
      if (renderNote) payload.renderNote = renderNote
      const map = readDetectBaselines()
      if (payload.action === 'baseline') {
        map[target] = { score: result.score, issueCount: result.issueCount, bySeverity: result.bySeverity, engine: result.engine, ts: new Date().toISOString() }
        writeDetectBaselines(map)
        payload.baselineSaved = true
      } else if (payload.action === 'compare') {
        const b = map[target]
        if (b) { payload.baseline = b; payload.delta = result.score - b.score } else { payload.baselineMissing = true }
      }
      return payload
    },
  }
}

// ---- HTTP routes ------------------------------------------------------------------------
function tokenRouteHandler(auth) {
  return (req, res) => sendJson(res, 200, { ok: true, token: auth.token })
}

function surfaceRouteHandler(hooks) {
  return async (req, res) => {
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      const body = await readJsonBody(req)
      let patch = null
      if (typeof body.surface === 'string' && Object.prototype.hasOwnProperty.call(SURFACES, body.surface)) patch = SURFACES[body.surface]
      else if (Array.isArray(body.allow)) patch = { enabled: body.enabled !== false, allow: body.allow.map(String) }
      if (!patch) return sendJson(res, 400, { ok: false, error: 'body must be {"surface":"off|core|all"} or {"allow":[...]}' })
      writeSurface(patch)
      const applied = hooks.applySurface()
      return sendJson(res, 200, { ok: true, ...readSurface(), mcp: applied, mcpTools: hooks.registryCounts() })
    }
    // GET is read-only: the chip polls this, so it must never re-register tools on a poll.
    const surface = readSurface()
    const counts = hooks.registryCounts()
    sendJson(res, 200, { ok: true, ...surface, mcp: { ...counts, surface: surface.surface, allow: surface.allow }, mcpTools: counts })
  }
}

function statusRouteHandler(hooks) {
  return async (req, res) => sendJson(res, 200, { ok: true, ...(await hooks.statusReport()) })
}

export function apply(ctx, config) {
  const raw = config || {}
  const settings = {
    projectDir: typeof raw.projectDir === 'string' && raw.projectDir.trim() ? raw.projectDir.trim() : undefined,
    trustedHosts: Array.isArray(raw.trustedHosts) ? raw.trustedHosts : [],
    installSkillOnBoot: raw.installSkillOnBoot !== false,
    callTimeoutMs: Number.isFinite(raw.callTimeoutMs) ? Math.max(1000, Math.trunc(raw.callTimeoutMs)) : 600_000,
    mcpArgs: Array.isArray(raw.mcpArgs) && raw.mcpArgs.length ? raw.mcpArgs.map(String) : undefined,
  }

  if (settings.installSkillOnBoot) {
    const report = []
    const skill = installSkill(report)
    if (!skill.ok) console.error(`[dsh-unslop] skill install: ${report.join('; ')}`)
  }

  const runtime = { client: null, tools: [], disposers: new Map(), total: 0, visible: 0, lastError: null, serverVersion: null, references: 0 }

  const disposeMcpTools = () => {
    for (const dispose of runtime.disposers.values()) { try { dispose?.() } catch { /* keep going */ } }
    runtime.disposers.clear()
  }

  const mcpDefinition = (tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} }
    const readOnly = tool.annotations && tool.annotations.readOnlyHint === true
    return {
      name: `${TOOL_PREFIX}${tool.name}`,
      description: `${tool.description || tool.name}${readOnly ? ' (read-only)' : ''}`,
      parameters: schema,
      timeoutMs: settings.callTimeoutMs,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const blocks = []
          if (value && Array.isArray(value.content)) {
            for (const block of value.content) if (block && block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
          }
          if (blocks.length === 0) blocks.push({ type: 'text', text: '(unslop returned no output)' })
          if (value && value.ok === false) blocks.unshift({ type: 'text', text: `unslop ${tool.name} failed:` })
          return blocks
        },
      },
      async execute(args, exec) {
        const client = runtime.client
        if (!client) throw new Error('the unslop MCP client is not running; call unslop_status, then reload the plugin, then retry')
        const base = resolveBaseDir(settings, exec)
        const forwarded = args && typeof args === 'object' ? { ...args } : {}
        if (typeof forwarded.cwd === 'string' && forwarded.cwd.trim()) forwarded.cwd = path.resolve(base, forwarded.cwd)
        return client.callTool(tool.name, forwarded, { signal: exec?.signal, timeoutMs: settings.callTimeoutMs })
      },
    }
  }

  const registryCounts = () => ({ total: runtime.total, visible: runtime.visible, running: Boolean(runtime.client) })

  const applySurface = () => {
    disposeMcpTools()
    const surface = readSurface()
    const allowed = allowedNames(surface)
    let visible = 0
    for (const tool of runtime.tools) {
      if (!allowed(tool.name)) continue
      try { runtime.disposers.set(tool.name, ctx.tools.register(mcpDefinition(tool))); visible += 1 }
      catch (error) { console.error(`[dsh-unslop] cannot register ${TOOL_PREFIX}${tool.name}: ${String(error?.message || error)}`) }
    }
    runtime.visible = visible
    runtime.total = runtime.tools.length
    return { surface: surface.surface, allow: surface.allow, visible, total: runtime.total, running: Boolean(runtime.client) }
  }

  const statusReport = async () => ({
    node: process.version,
    playwright: hasPlaywright(),
    ffmpeg: Boolean(which('ffmpeg')),
    skill: { dir: SKILL_ROOT, installed: fs.existsSync(path.join(SKILL_ROOT, 'SKILL.md')) },
    references: runtime.references,
    surface: readSurface().surface,
    mcp: {
      serverName: SERVER_NAME,
      toolPrefix: TOOL_PREFIX,
      running: Boolean(runtime.client),
      visible: runtime.visible,
      total: runtime.total,
      serverVersion: runtime.serverVersion,
      lastError: runtime.lastError,
    },
  })

  const hooks = { statusReport, applySurface, registryCounts }

  const stopClient = () => {
    const client = runtime.client
    runtime.client = null
    if (client) { try { client.stop() } catch { /* gone */ } }
    disposeMcpTools()
    runtime.tools = []
    runtime.total = 0
    runtime.visible = 0
  }

  const startClient = async () => {
    const client = createUnslopClient({
      cli: NODE,
      argv: settings.mcpArgs || [SERVER],
      cwd: settings.projectDir,
      callTimeoutMs: settings.callTimeoutMs,
      env: { ELECTRON_RUN_AS_NODE: '1', UNSLOP_PLAYWRIGHT_HOME: path.join(INSTALL_ROOT, 'node_modules') },
    })
    client.onListChanged(() => {
      client.listTools().then((tools) => { runtime.tools = tools; applySurface() }).catch((e) => { runtime.lastError = String(e?.message || e) })
    })
    client.onDown((reason) => { runtime.lastError = reason })
    await client.start()
    runtime.client = client
    runtime.serverVersion = client.state.serverVersion
    runtime.tools = await client.listTools()
    try { runtime.references = (await client.listResources()).length } catch { runtime.references = 0 }
    runtime.lastError = null
    applySurface()
    console.error(`[dsh-unslop] MCP server up: ${SERVER} (${runtime.total} tools, ${runtime.references} references)`)
    return statusReport()
  }

  ctx.inject(['workingDirectory'], (wdCtx) => {
    workingDirectoryService = wdCtx.workingDirectory || null
  })

  const definitions = [statusTool(settings, hooks), depsTool(settings, hooks), surfaceTool(settings, hooks), detectTool(settings, hooks)]
  ctx.effect(() => {
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(ctx.tools.register(definition))
      return () => { while (disposers.length > 0) { try { disposers.pop()?.() } catch { /* ignore */ } } }
    } catch (error) {
      while (disposers.length > 0) { try { disposers.pop()?.() } catch { /* ignore */ } }
      throw error
    }
  }, 'dsh-unslop: host tools')

  ctx.effect(() => {
    startClient().catch((error) => {
      runtime.lastError = String(error?.message || error)
      console.error(`[dsh-unslop] MCP client did not start: ${runtime.lastError}`)
    })
    return () => stopClient()
  }, 'dsh-unslop: mcp client')

  // ---- Web routes (composer chip reads these) -------------------------------------------
  const httpAuth = createHttpAuth(ctx, settings, TOKEN_FILE)
  ctx.inject(['webServer'], (webCtx) => {
    const route = (pathname, handler, options) => webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: pathname, handler: options ? guarded(handler, httpAuth, options) : guarded(handler, httpAuth) }),
      `dsh-unslop: ${pathname} route`,
    )
    route('/unslop/api/token', tokenRouteHandler(httpAuth), { token: false })
    route('/unslop/api/surface', surfaceRouteHandler(hooks))
    route('/unslop/api/status', statusRouteHandler(hooks))
  })
}
