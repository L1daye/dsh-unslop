// dsh-unslop — unit test for the deterministic detector (mcp/detect.mjs). No Harness, no browser.
//   node tests/detecttest.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { scanPath, normalizeImpeccable } = await import(pathToFileURL(path.resolve(HERE, '..', 'mcp', 'detect.mjs')).href)

let pass = 0, fail = 0
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.error(`  FAIL ${n}${d ? ' — ' + d : ''}`) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-detect-'))
const sloppy = `<!doctype html><html><body>
<div class="bg-gradient-to-r from-purple-500 to-blue-600 shadow-[0_0_20px_rgba(139,92,246,0.5)]">
  <h1 class="bg-clip-text text-transparent font-extrabold">Welcome back 🚀</h1>
  <span class="uppercase tracking-widest text-[10px]">NAVIGATION</span>
  <button class="hover:scale-105 transition-all animate-pulse rounded-full">Get started! ✨</button>
  <img class="backdrop-blur" src="x.png" />
  <p class="mt-[13px]">Supercharge your workflow</p>
</div></body></html>`
const clean = `<!doctype html><html><body>
<main class="mx-auto max-w-3xl p-6"><h1>October report</h1>
<p>Revenue was up 12% vs last month.</p><button>Export</button></main>
</body></html>`
fs.writeFileSync(path.join(dir, 'sloppy.html'), sloppy)
fs.writeFileSync(path.join(dir, 'clean.html'), clean)
// a file under node_modules must be skipped
fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bad.html'), sloppy)

try {
  const before = scanPath(dir)
  ok('scan finds files, skips node_modules', before.files === 2, `files=${before.files}`)
  ok('sloppy score < 100', before.score < 100, `score=${before.score}`)
  ok('detects gradient-surface', (before.counts['gradient-surface'] || 0) >= 1)
  ok('detects gradient-text', (before.counts['gradient-text'] || 0) >= 1)
  ok('detects emoji-icon', (before.counts['emoji-icon'] || 0) >= 1)
  ok('detects arbitrary-spacing', (before.counts['arbitrary-spacing'] || 0) >= 1)
  ok('issues carry file:line', before.issues.every((i) => i.file && i.line >= 1))

  const cleanScan = scanPath(path.join(dir, 'clean.html'))
  ok('clean file score = 100', cleanScan.score === 100 && cleanScan.issueCount === 0, `score=${cleanScan.score} n=${cleanScan.issueCount}`)

  const norm = normalizeImpeccable({ results: [
    { file: 'a.tsx', line: 3, rule: 'gradient-text', severity: 'P0', message: 'gradient text' },
    { file: 'a.tsx', line: 9, rule: 'tiny-font', severity: 'P3', message: 'tiny' },
  ] }, dir)
  ok('normalizeImpeccable maps results', norm.engine === 'impeccable' && norm.issueCount === 2 && norm.score < 100, `n=${norm.issueCount} score=${norm.score}`)
  ok('normalizeImpeccable severity mapping', norm.issues[0].sev === 'high' && norm.issues[1].sev === 'low')
} catch (e) {
  fail++; console.error('  FAIL exception: ' + e.message)
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
