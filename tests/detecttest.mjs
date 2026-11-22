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
  <p class="mt-[13px]">Supercharge your workflow</p>
</div></body></html>`
const clean = `<!doctype html><html><body>
<main class="mx-auto max-w-3xl p-6"><h1>October report</h1>
<p>Revenue was up 12% vs last month.</p><button>Export</button></main>
</body></html>`
// hand-written CSS the old (Tailwind-utility) rules missed — the 3 named blind spots:
const cssHand = `<!doctype html><html><head><style>
.glass{backdrop-filter:blur(8px)}
.stat-card:hover{transform:scale(1.05)}
.logo{background:linear-gradient(135deg,#7c3aed,#2563eb)}
</style></head><body><div class="glass">x</div></body></html>`
// same rule on 3 adjacent lines -> must merge to one issue (count 3)
const merged = `<div class="text-[10px]">a</div>\n<div class="text-[10px]">b</div>\n<div class="text-[10px]">c</div>\n`
// file-level: mixed money formats
const money = `<span>$390.00</span><span>$29</span>`

fs.writeFileSync(path.join(dir, 'sloppy.html'), sloppy)
fs.writeFileSync(path.join(dir, 'clean.html'), clean)
fs.writeFileSync(path.join(dir, 'csshand.html'), cssHand)
fs.writeFileSync(path.join(dir, 'merged.html'), merged)
fs.writeFileSync(path.join(dir, 'money.html'), money)
fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'bad.html'), sloppy)

try {
  const before = scanPath(dir)
  ok('scan finds files, skips node_modules', before.files === 5, `files=${before.files}`)
  ok('sloppy score < 100 and > 0 (saturating, not floored)', before.score < 100 && before.score > 0, `score=${before.score}`)
  ok('detects gradient-surface', (before.counts['gradient-surface'] || 0) >= 1)
  ok('detects gradient family (surface/text)', ((before.counts['gradient-surface'] || 0) + (before.counts['gradient-text'] || 0) + (before.counts['gradient-wordmark'] || 0)) >= 1)
  ok('detects emoji-icon', (before.counts['emoji-icon'] || 0) >= 1)

  const cleanScan = scanPath(path.join(dir, 'clean.html'))
  ok('clean file score = 100', cleanScan.score === 100 && cleanScan.issueCount === 0, `score=${cleanScan.score} n=${cleanScan.issueCount}`)

  // blind-spot fixes: hand-written CSS now detected
  const css = scanPath(path.join(dir, 'csshand.html'))
  ok('blind spot: backdrop-filter -> glass-card', (css.counts['glass-card'] || 0) >= 1)
  ok('blind spot: :hover transform:scale -> hover-scale', (css.counts['hover-scale'] || 0) >= 1)
  ok('blind spot: .logo linear-gradient -> gradient rule', (css.counts['gradient-wordmark'] || 0) >= 1 || (css.counts['gradient-surface'] || 0) >= 1)

  // merge: 3 adjacent tiny-text hits -> 1 issue with count 3
  const mg = scanPath(path.join(dir, 'merged.html'))
  const tiny = mg.issues.find((i) => i.rule === 'tiny-text')
  ok('adjacent same-rule merged to one issue', tiny && tiny.count === 3, tiny ? `count=${tiny.count}` : 'not found')

  // file-level rule
  const mo = scanPath(path.join(dir, 'money.html'))
  ok('file-level: mixed money formats detected', (mo.counts['mixed-number-format'] || 0) >= 1)

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
