#!/usr/bin/env node
// unslop MCP server — a standalone, host-agnostic Model Context Protocol server.
//
// It wraps heydamir/unslop (github.com/heydamir/unslop, CC BY 4.0, by Damir Sokolovsky)
// as a real MCP endpoint so ANY MCP host — DeepSeek Harness, Claude Code, Codex, a custom
// client — can call it. The dsh plugin (host/index.js) is a thin adapter that spawns this
// process and registers its tools as mcp__unslop__*; this file itself has no dsh dependency.
//
// Surfaces MCP exposes here:
//   tools      unslop_references / unslop_read / unslop_snapshot / unslop_story
//   resources  unslop://reference/<name>   (the 6 markdown reference docs, lazy)
//   prompts    unslop                     (the audit -> direction -> passes playbook)
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio framing).
// Zero runtime dependencies for the server core; Playwright/ffmpeg are only needed by the
// snapshot/story tools and are probed lazily.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const SKILL_DIR = path.join(PKG, 'skills', 'unslop')
const REF_DIR = path.join(SKILL_DIR, 'references')
const SCRIPT_DIR = path.join(SKILL_DIR, 'scripts')

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'unslop', version: '0.1.0' }
const NODE = process.execPath

// ---- reference catalog -------------------------------------------------------------------
// One line each on purpose: unslop_read streams the body, the catalog never preloads it.
const REFERENCES = {
  signs: 'The audit checklist: every tell of AI slop (gradients, glows, emoji, shouty copy, uneven spacing) with where it lives.',
  tokens: 'Exact values for every pass: the 4px space scale, neutral ramps, type families, radii, durations, easings.',
  visuals: 'How to pick the subject of a hero image, the prompt recipe, and how to place it. Read before the Visuals pass.',
  refs: 'Finished examples to learn composition, light, restraint and moment placement from (subject only, never copy the layout).',
  effects: 'Code treatments such as drawing an image in glyphs — advanced visual effects that ship as real code.',
  rtl: 'Right-to-left rules for Arabic, Persian, Urdu and Hebrew. Its rules win where they differ from the passes.',
}

// ---- helpers ----------------------------------------------------------------------------
function readReference(name) {
  const key = String(name || '').replace(/\.md$/i, '').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(REFERENCES, key)) {
    const names = Object.keys(REFERENCES).join(', ')
    throw new Error(`unknown reference "${name}"; available: ${names}`)
  }
  const file = path.join(REF_DIR, `${key}.md`)
  if (!fs.existsSync(file)) throw new Error(`reference ${key}.md is missing from the package`)
  return { key, file, text: fs.readFileSync(file, 'utf8') }
}

function runNode(script, args, { cwd, timeoutMs = 180_000, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    // A durable Playwright can live outside the plugin package (host passes its node_modules here),
    // so snapshot/story still find it after the plugin dir is redeployed/replaced. NODE_PATH is the
    // fallback the CommonJS createRequire() in the upstream scripts honours when the local copy is gone.
    const env = { ...process.env }
    if (process.env.UNSLOP_PLAYWRIGHT_HOME) {
      env.NODE_PATH = [process.env.UNSLOP_PLAYWRIGHT_HOME, env.NODE_PATH].filter(Boolean).join(path.delimiter)
    }
    try {
      child = spawn(NODE, [path.join(SCRIPT_DIR, script), ...args], {
        cwd: cwd || PKG,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message || error), ms: 0, error: String(error?.message || error) })
      return
    }
    let settled = false
    const finish = (code, errorMessage) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code, stdout: stdout.slice(0, 200_000), stderr: stderr.slice(0, 200_000), ms: Date.now() - started, ...(errorMessage ? { error: errorMessage } : {}) })
    }
    const kill = () => { try { child.kill('SIGTERM') } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 800).unref?.() }
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

// ---- tool definitions -------------------------------------------------------------------
const TOOLS = [
  {
    name: 'unslop_references',
    description: 'List the unslop reference documents (signs, tokens, visuals, refs, effects, rtl) with a one-line summary of each. Call unslop_read with a name to get the full text. Use before a pass that needs exact values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'unslop_read',
    description: 'Read one unslop reference document in full (markdown). name is one of: signs, tokens, visuals, refs, effects, rtl. signs is the audit checklist; tokens holds the exact spacing/color/type values.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Reference to read: signs | tokens | visuals | refs | effects | rtl' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'unslop_snapshot',
    description: 'Capture a live page (URL or local HTML file) into a self-contained HTML copy plus a screenshot, using Playwright + Chromium. Use when the target is a live site and you only have a link. Returns the saved html path and live.png path. Requires Playwright; if it is missing the error says the exact install commands.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL or a local file path.' },
        out: { type: 'string', description: 'Output .html path (relative resolves against the project dir). A sibling .live.png screenshot is written next to it.' },
        label: { type: 'string', description: 'Optional pass label stored as <meta name="unslop-pass">.' },
        theme: { type: 'string', enum: ['dark', 'light', 'none'], description: 'Color scheme to render with (default none = system).' },
        width: { type: 'integer', description: 'Viewport width (default 1440).' },
        height: { type: 'integer', description: 'Viewport height (default 810).' },
        cwd: { type: 'string', description: 'Working directory (where the project + node_modules live). Defaults to the plugin dir.' },
      },
      required: ['url', 'out'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'unslop_story',
    description: 'Render a square (<10s) story video of a screen unslopping itself from a self-contained story.html that carries unslop-steps / unslop-frame meta and .s1/.s2 style steps. Uses Playwright + ffmpeg. Optional: this is the shareable extra, not the core fix.',
    inputSchema: {
      type: 'object',
      properties: {
        storyHtml: { type: 'string', description: 'Path to unslop-story/story.html.' },
        out: { type: 'string', description: 'Output .mp4 path. Omit with play=true to just watch it live.' },
        wide: { type: 'boolean', description: 'Render 16:9 instead of square.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the plugin dir.' },
      },
      required: ['storyHtml'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
]

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

async function callTool(name, args, signal) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'unslop_references': {
      const lines = ['unslop references — call unslop_read {name} for the full text:', '']
      for (const [key, summary] of Object.entries(REFERENCES)) lines.push(`- ${key}: ${summary}`)
      return toolResult(lines.join('\n'))
    }
    case 'unslop_read': {
      const { key, text } = readReference(a.name)
      return toolResult(`# reference: ${key}\n\n${text}`)
    }
    case 'unslop_snapshot': {
      if (!a.url || !a.out) return toolResult('unslop_snapshot needs url and out', true)
      const argv = [String(a.url), String(a.out)]
      if (a.label) argv.push(String(a.label))
      if (a.theme === 'dark') argv.push('--dark')
      else if (a.theme === 'light') argv.push('--light')
      if (Number.isInteger(a.width)) argv.push('--width', String(a.width))
      if (Number.isInteger(a.height)) argv.push('--height', String(a.height))
      const r = await runNode('snapshot.mjs', argv, { cwd: a.cwd ? path.resolve(a.cwd) : PKG, timeoutMs: 180_000, signal })
      const ok = r.code === 0
      const body = [`exit ${r.code ?? 'null'} in ${r.ms} ms`, r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
      return toolResult(ok ? `snapshot ok\n${body}` : `snapshot failed\n${body}`, !ok)
    }
    case 'unslop_story': {
      if (!a.storyHtml) return toolResult('unslop_story needs storyHtml', true)
      const argv = [String(a.storyHtml)]
      if (a.out) argv.push(String(a.out))
      if (a.wide === true) argv.push('--wide')
      const r = await runNode('story.mjs', argv, { cwd: a.cwd ? path.resolve(a.cwd) : PKG, timeoutMs: 600_000, signal })
      const ok = r.code === 0
      const body = [`exit ${r.code ?? 'null'} in ${r.ms} ms`, r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
      return toolResult(ok ? `story ok\n${body}` : `story failed\n${body}`, !ok)
    }
    default:
      return toolResult(`unknown tool "${name}"`, true)
  }
}

// ---- prompts ----------------------------------------------------------------------------
const PROMPTS = [
  {
    name: 'unslop',
    description: 'Run the unslop workflow on a screen: audit the slop, set a direction, fix it in nine passes, and never lose the product.',
    arguments: [
      { name: 'target', description: 'The screen, file, folder or URL to unslop.', required: false },
      { name: 'mode', description: 'heavy | light | auto (default auto).', required: false },
    ],
  },
]

function getPrompt(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const target = a.target ? String(a.target) : 'the screen the user pointed at'
  const mode = a.mode ? String(a.mode) : 'auto'
  const text = [
    `You are about to unslop ${target} (mode: ${mode}). Follow heydamir/unslop.`,
    '',
    '1. Look at the screen: find the file(s) that render it. If it is only a live URL, call unslop_snapshot to save a self-contained copy and a screenshot, then work on the copy.',
    '2. Audit: call unslop_read {name:"signs"} and list every slop sign you find, one line each with where it lives.',
    '3. Decide how much to change from the audit: heavy slop -> full process; light slop -> polish only; no slop -> say so and stop.',
    '4. Set the direction in five lines (product, character, world, moments, signature) and show the audit + direction to the user before editing.',
    '5. Fix in nine passes in order: spacing, color, icons, copy, type, layout, details, visuals, motion. Read unslop_read {name:"tokens"} for exact values, and visuals/refs before the Visuals pass.',
    '6. Check against the audit, render again (unslop_snapshot), and fix anything still on the list.',
    '7. Report the direction, a few lines per pass, and any image prompt. Only build a story video (unslop_story) when the user asks.',
    '',
    'Keep the product: features, content and section order stay. Keep the CC BY credit: unslop by Damir Sokolovsky (@heydamir).',
  ].join('\n')
  return {
    description: PROMPTS[0].description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  }
}

// ---- JSON-RPC plumbing ------------------------------------------------------------------
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return // notification, no reply
      case 'ping':
        return isRequest ? reply(id, {}) : undefined
      case 'tools/list':
        return reply(id, { tools: TOOLS })
      case 'tools/call': {
        const toolName = params && params.name
        let result
        try {
          result = await callTool(toolName, params && params.arguments)
        } catch (error) {
          // MCP convention: a tool's own failure is a result with isError, not a protocol error.
          result = toolResult(String(error?.message || error), true)
        }
        return reply(id, result)
      }
      case 'resources/list':
        return reply(id, {
          resources: Object.entries(REFERENCES).map(([key, summary]) => ({
            uri: `unslop://reference/${key}`,
            name: `unslop ${key}`,
            description: summary,
            mimeType: 'text/markdown',
          })),
        })
      case 'resources/read': {
        const uri = String(params && params.uri || '')
        const key = uri.replace(/^unslop:\/\/reference\//, '').replace(/\.md$/i, '')
        const { text } = readReference(key)
        return reply(id, { contents: [{ uri, mimeType: 'text/markdown', text }] })
      }
      case 'prompts/list':
        return reply(id, { prompts: PROMPTS })
      case 'prompts/get':
        return reply(id, getPrompt(params && params.name, params && params.arguments))
      default:
        if (isRequest) replyError(id, -32601, `method not found: ${method}`)
    }
  } catch (error) {
    if (isRequest) replyError(id, -32603, String(error?.message || error))
    else process.stderr.write(`[unslop] ${String(error?.message || error)}\n`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { process.stderr.write(`[unslop] bad JSON line\n`); continue }
    handle(message)
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write('[unslop] MCP server ready (stdio)\n')
