// dsh-unslop — a minimal MCP stdio client, owned by this plugin.
//
// Mirrors dsh-rust-anything's client: the Harness does not ship @deepseek-ai/dsh-mcp-client and
// a profile not populated through pnpm has no copy, so a patch row naming it would fail to
// resolve. The unslop MCP server (mcp/server.mjs) speaks a small documented subset — initialize,
// tools/list, tools/call, resources/*, prompts/*, ping, notifications/* — over newline-delimited
// JSON-RPC 2.0, so this file speaks it directly. One bundle row, no peer dependency, and the
// tools still register under the same mcp__unslop__* names.

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'dsh-unslop', version: '0.1.4' }
const INIT_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 600_000

/**
 * @param {{cli: string, argv?: string[], cwd?: string, env?: Record<string,string>,
 *          callTimeoutMs?: number, log?: (line: string) => void}} options
 */
export function createUnslopClient(options) {
  const { cli } = options
  const argv = Array.isArray(options.argv) && options.argv.length ? options.argv.slice() : []
  const callTimeoutMs = Number.isFinite(options.callTimeoutMs) ? options.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS
  const log = options.log || ((line) => console.error(`[dsh-unslop] ${line}`))

  let child = null
  let startedAt = null
  let serverInfo = null
  let nextId = 1
  let buffer = ''
  let stopped = false
  const pending = new Map()
  const listChanged = new Set()
  const down = new Set()

  const send = (message) => {
    if (!child || child.killed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('unslop MCP server is not running')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const settle = (id, settleWith) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
    settleWith(entry)
  }

  const failAll = (reason) => {
    for (const id of [...pending.keys()]) {
      settle(id, (entry) => entry.reject(new Error(reason)))
    }
  }

  function request(method, params, timeoutMs = LIST_TIMEOUT_MS, signal) {
    const id = nextId++
    const message = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise((resolve, reject) => {
      if (stopped || !child) {
        reject(new Error('unslop MCP server is not running'))
        return
      }
      const entry = { resolve, reject, method, timer: null, onAbort: null, signal }
      // Register BEFORE the abort check: an already-aborted signal must settle this promise, not
      // leave it pending forever (the old order returned early with nothing in `pending`).
      pending.set(id, entry)
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          try { send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) } catch { /* gone */ }
          settle(id, (found) => found.reject(new Error(`${method} timed out after ${timeoutMs} ms`)))
        }, timeoutMs)
        if (entry.timer.unref) entry.timer.unref()
      }
      if (signal) {
        entry.onAbort = () => {
          try { send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) } catch { /* gone */ }
          settle(id, (found) => found.reject(new Error(`${method} cancelled`)))
        }
        if (signal.aborted) {
          entry.onAbort()
          return
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      try {
        send(message)
      } catch (error) {
        settle(id, (found) => found.reject(error))
      }
    })
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message && message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const id = message.id
      if (message.error) {
        const error = new Error(String(message.error.message || 'MCP error'))
        error.code = message.error.code
        settle(id, (entry) => entry.reject(error))
      } else {
        settle(id, (entry) => entry.resolve(message.result))
      }
      return
    }
    if (message && typeof message.method === 'string') {
      if (message.method === 'notifications/tools/list_changed') {
        for (const listener of listChanged) {
          try { listener() } catch { /* a listener must not break the reader */ }
        }
      }
    }
  }

  function attach(proc) {
    // After the child exits, a late write to its closed stdin emits 'error' on the stream; without
    // a listener that becomes an unhandled 'error' event and crashes the host. Swallow it here; the
    // exit handler is what reports the real state.
    try { proc.stdin.on('error', () => { /* EPIPE after exit */ }) } catch { /* no stdin */ }
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      if (buffer.length < 8_000_000) buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) handleLine(line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(text)
    })
    proc.on('error', (error) => {
      failAll(`unslop MCP server failed: ${error && error.message ? error.message : error}`)
      for (const listener of down) {
        try { listener(String(error && error.message ? error.message : error)) } catch { /* ignore */ }
      }
    })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      const reason = `unslop MCP server exited (code ${code}, signal ${signal === null ? 'none' : signal})`
      if (!stopped) log(reason)
      failAll(reason)
      if (!stopped) {
        for (const listener of down) {
          try { listener(reason) } catch { /* ignore */ }
        }
      }
    })
  }

  async function start() {
    stopped = false
    child = spawn(cli, argv, {
      cwd: options.cwd || undefined,
      env: Object.assign({}, process.env, options.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    startedAt = new Date().toISOString()
    buffer = ''
    attach(child)
    const init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, INIT_TIMEOUT_MS)
    serverInfo = (init && init.serverInfo) || null
    try { send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) } catch { /* ignore */ }
    return serverInfo
  }

  async function listTools() {
    const result = await request('tools/list', {}, LIST_TIMEOUT_MS)
    const tools = result && Array.isArray(result.tools) ? result.tools : []
    return tools.filter((tool) => tool && typeof tool.name === 'string')
  }

  /**
   * @param {string} name
   * @param {object} args
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [exec]
   */
  async function callTool(name, args, exec = {}) {
    const params = { name, arguments: args && typeof args === 'object' ? args : {} }
    const result = await request('tools/call', params, exec.timeoutMs || callTimeoutMs, exec.signal)
    return {
      ok: !(result && result.isError === true),
      content: result && Array.isArray(result.content) ? result.content : [],
      structuredContent: result && result.structuredContent !== undefined ? result.structuredContent : null,
    }
  }

  async function listResources() {
    const result = await request('resources/list', {}, LIST_TIMEOUT_MS)
    return result && Array.isArray(result.resources) ? result.resources : []
  }

  function stop() {
    stopped = true
    failAll('unslop MCP server stopped')
    if (!child) return
    const proc = child
    child = null
    try { proc.stdin.end() } catch { /* already closed */ }
    try { proc.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* already gone */ } }, 150).unref?.()
    setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, 1200).unref?.()
  }

  return {
    start,
    stop,
    listTools,
    listResources,
    callTool,
    onListChanged: (listener) => { listChanged.add(listener); return () => listChanged.delete(listener) },
    onDown: (listener) => { down.add(listener); return () => down.delete(listener) },
    get state() {
      return {
        running: Boolean(child),
        cli,
        argv,
        cwd: options.cwd || null,
        pid: child ? child.pid : null,
        startedAt,
        serverVersion: serverInfo ? serverInfo.version || null : null,
        pending: pending.size,
      }
    },
  }
}
