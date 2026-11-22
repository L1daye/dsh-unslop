// dsh-unslop — render-level QA via Playwright. Opens a local page at desktop + mobile widths and
// measures what text-only rules cannot: horizontal overflow, low text contrast, tiny rendered font,
// and too-small tap targets. Prints a JSON object: { issues: [{rule,sev,message}], widths }.
//
// Invoked by the host half only when a single .html target is scanned with render:true and Playwright
// is available. No Playwright -> exit 3 (host reports "render skipped").

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

async function browserKit() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name) } catch {}
    try { return createRequire(process.env.UNSLOP_PLAYWRIGHT_HOME ? process.env.UNSLOP_PLAYWRIGHT_HOME + '/x.js' : import.meta.url)(name) } catch {}
  }
  return null
}

const target = process.argv[2]
const pageUrl = /^(?:file|https?):/i.test(String(target || '')) ? String(target) : pathToFileURL(target).href
const widths = [[1440, 900], [390, 844]]
const kit = await browserKit()
if (!kit) { console.error('no playwright'); process.exit(3) }
const { chromium } = kit

function auditInPage() {
  const issues = []
  const visible = (el) => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const parseRGB = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] } }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05) }
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const bg = parseRGB(getComputedStyle(n).backgroundColor); if (bg && bg.a > 0.5) return bg; n = n.parentElement } return { r: 255, g: 255, b: 255, a: 1 } }

  // overflow
  const doc = document.documentElement
  const overflow = doc.scrollWidth - doc.clientWidth
  if (overflow > 1) issues.push({ rule: 'render-overflow', sev: 'high', message: `水平溢出 ${overflow}px（scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}）` })

  // fonts / contrast / tap
  let minFont = null, lowContrast = 0, tapSmall = 0
  const els = [...document.querySelectorAll('body *')]
  for (const el of els) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
    if (ownText) {
      const fs = parseFloat(cs.fontSize)
      if (!minFont || fs < minFont) minFont = fs
      const fg = parseRGB(cs.color), bg = bgOf(el)
      if (fg && bg && !/gradient|url\(/.test(cs.backgroundImage)) {
        try { if (ratio(fg, bg) < 4.5) lowContrast++ } catch {}
      }
    }
    if (el.matches('a,button,[role="button"],input,select')) {
      const r = el.getBoundingClientRect()
      if ((r.width < 24 || r.height < 24)) tapSmall++
    }
  }
  if (minFont && minFont < 11) issues.push({ rule: 'render-tiny', sev: 'medium', message: `渲染最小字号 ${minFont.toFixed(1)}px < 11px` })
  if (lowContrast > 0) issues.push({ rule: 'render-contrast', sev: 'medium', message: `${lowContrast} 处文字对比度 < 4.5:1` })
  if (tapSmall > 0) issues.push({ rule: 'render-tap', sev: 'low', message: `${tapSmall} 个可点击目标 < 24px（触控偏小）` })
  return issues
}

const out = { issues: [], widths: widths.map((w) => w[0]) }
const browser = await chromium.launch()
try {
  for (const [w, h] of widths) {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.goto(pageUrl, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts && document.fonts.ready)
    await page.waitForTimeout(200)
    const found = await page.evaluate(auditInPage)
    for (const it of found) out.issues.push({ ...it, message: `${it.message}  @${w}px` })
    await page.close()
  }
} finally {
  await browser.close()
}
// de-dupe identical (rule+message)
const seen = new Set()
out.issues = out.issues.filter((i) => { const k = i.rule + '|' + i.message; if (seen.has(k)) return false; seen.add(k); return true })
console.log(JSON.stringify(out))
