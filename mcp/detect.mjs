// dsh-unslop — deterministic "slop" detector (offline, no LLM) + optional render check fusion.
//
// v0.1.4: rules now also match hand-written CSS (not only Tailwind utilities), scoring saturates so a
// very sloppy page no longer floors at 0, and issues are merged/deduped so the list reads as real
// problems instead of one visual tell counted five ways.

import fs from 'node:fs'
import path from 'node:path'

const W = { high: 6, medium: 3, low: 1.5 }
const EXTS = new Set(['.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'coverage', '.turbo', '.svelte-kit', '.aoci'])
const MAX_FILES = 3000
const MAX_BYTES = 2 * 1024 * 1024

// Rule family: same-location hits in one family collapse to a single (highest-severity) issue.
const FAMILY = {
  'gradient-surface': 'gradient', 'gradient-text': 'gradient', 'gradient-wordmark': 'gradient',
  'colored-glow': 'glow', 'text-shadow': 'glow', 'blur-filter': 'glow', 'radial-wash': 'glow', 'neon-border': 'glow',
  'emoji-icon': 'emoji', 'badge-noise': 'emoji',
  'pulse-anim': 'motion', 'transition-all': 'motion', 'hover-scale': 'motion',
}

export const RULES = [
  { id: 'gradient-surface', sev: 'high', msg: '紫/蓝/多色相渐变背景或卡片（AI slop 标志）', re: /\b(?:from|to|via)-(?:purple|violet|indigo|fuchsia|pink|blue|cyan)-\d{2,3}\b|bg-gradient-to-(?:r|br|b|bl|l|tl|tr)\b|linear-gradient\([^)]*(?:purple|violet|#8b5cf6|#a855f7|#6366f1|#7c3aed|#2563eb|#ec4899)/i },
  { id: 'gradient-text', sev: 'high', msg: '渐变文字（bg-clip-text / text-transparent / background-clip:text）', re: /bg-clip-text|text-transparent|background-clip:\s*text|-webkit-background-clip:\s*text/i },
  { id: 'colored-glow', sev: 'high', msg: '彩色发光/彩色阴影（glow）', re: /shadow-\[[^\]]*rgba?\(|drop-shadow-|box-shadow:[^;]*(?:rgba?\(|\b(?:purple|violet|indigo|blue|fuchsia|pink|cyan|#8b5cf6|#a855f7)\b)/i },
  { id: 'radial-wash', sev: 'high', msg: '径向色晕 / 模糊色块（blob）', re: /radial-gradient|blur-3xl|blur-2xl|blur-\[|bg-\[radial-gradient/i },
  { id: 'neon-border', sev: 'high', msg: '霓虹/高饱和彩色边框', re: /border-(?:purple|violet|indigo|fuchsia|pink|cyan|blue)-\d{3}/i },
  { id: 'emoji-icon', sev: 'high', msg: '用 emoji 当图标/装饰', re: /\p{Extended_Pictographic}/u },
  { id: 'uppercase-tracked', sev: 'medium', msg: '大写+宽字距标签（NAVIGATION 式）', re: /uppercase[^"'<>]*tracking-(?:wide|wider|widest)|tracking-(?:wider|widest)[^"'<>]*uppercase|text-transform:\s*uppercase/i },
  { id: 'heavy-weight', sev: 'medium', msg: '700/800/900 超重字重标题', re: /font-(?:bold|extrabold|black)\b|font-weight:\s*(?:700|800|900)/i },
  { id: 'glass-card', sev: 'medium', msg: '玻璃拟态（backdrop-blur / backdrop-filter:blur）', re: /backdrop-blur|backdrop-filter\s*:\s*blur|bg-white\/[0-9]{1,2}\b/i },
  { id: 'text-shadow', sev: 'medium', msg: '文字阴影/发光文字（text-shadow）', re: /text-shadow\s*:/i },
  { id: 'blur-filter', sev: 'medium', msg: '装饰性滤镜模糊（filter:blur）', re: /filter\s*:\s*blur\(/i },
  { id: 'pulse-anim', sev: 'medium', msg: '无意义的呼吸/脉冲动画', re: /animate-(?:pulse|ping|bounce)\b/ },
  { id: 'transition-all', sev: 'medium', msg: 'transition-all（应指明具体属性）', re: /transition-all\b/ },
  { id: 'hover-scale', sev: 'medium', msg: 'hover 放大（hover:scale / :hover{transform:scale}）', re: /hover:scale-\d|:hover[^}]*transform\s*:\s*scale|transform\s*:\s*scale\(\s*1\.[0-9]/i },
  { id: 'badge-noise', sev: 'medium', msg: '“New ✨ / PRO / Beta 🚀” 徽章噪音', re: /New\s*✨|\bPRO\b|Beta\s*🚀|✨|🚀/ },
  { id: 'gradient-wordmark', sev: 'medium', msg: '渐变/闪光词标或 logo', re: /\.(?:logo|brand)[^{}]*\{[^}]*(?:linear-gradient|gradient)|(?:logo|wordmark)[^"'<>]*(?:gradient|sparkle|✨)|sparkles?/i },
  { id: 'negative-tracking-small', sev: 'medium', msg: '小字用负字距（应放大/加粗而非压缩）', re: /font-size\s*:\s*(?:[0-9]|1[0-5])px[^}]*letter-spacing\s*:\s*-|text-\[(?:[0-9]|1[0-5])px\][^"']*tracking-tight/i },
  { id: 'arbitrary-spacing', sev: 'low', msg: '任意像素间距（如 mt-[13px]），脱离 4px 栅格', re: /-\[[0-9]{1,3}px\]/ },
  { id: 'hype-words', sev: 'low', msg: '营销大词（supercharge/seamless/unlock/magic…）', re: /\b(?:supercharge|seamless|unlock|magic|revolutionar\w*|game.?chang\w*|AI-powered|effortless|cutting-edge|next-gen|hyper-?growth)\b/i },
  { id: 'exclamation', sev: 'low', msg: '界面文案里的感叹号', re: /["'>][^"'<>]{0,60}[A-Za-z\u4e00-\u9fa5]!!?[^"'<>]{0,10}["'<]/ },
  { id: 'fake-numbers', sev: 'low', msg: '假数据/占位（123,456 / [X] / Lorem ipsum / 999+ / 420%）', re: /123,456|\[X\]|Lorem ipsum|\b999\+|\b420%|\b69,?420\b/i },
  { id: 'greeting', sev: 'low', msg: '问候式标题（Welcome back…）', re: /\b(?:Welcome back|Welcome,|欢迎回来|你好，)/i },
  { id: 'placeholder-ellipsis', sev: 'low', msg: '啰嗦占位（Search anything…）', re: /Search anything|Type anything|placeholder="[^"]*\.\.\."/i },
  { id: 'pill-everywhere', sev: 'low', msg: 'rounded-full / 999px 满屏胶囊', re: /rounded-full\b|border-radius\s*:\s*(?:9999|999)px/i },
  { id: 'tiny-text', sev: 'low', msg: '过小字号（<11px）', re: /text-\[(?:[0-9]|10)px\]|font-size:\s*(?:[0-9]|10)px/i },
  { id: 'default-graphite', sev: 'low', msg: '默认 #161616 石墨灰（模板感）', re: /#161616\b/i },
]

// File-level rules: need whole-file context (mix of formats, too many tints).
const FILE_RULES = [
  {
    id: 'mixed-number-format', sev: 'medium', msg: '同一文件数字格式混用（整数与两位小数并存）',
    test: (text) => /[$¥€£]\s?\d[\d,]*\.\d{2}\b/.test(text) && /\$\s?\d[\d,]*(?!\.\d)\b/.test(text),
  },
  {
    id: 'many-text-tints', sev: 'low', msg: '近似文字色过多（text-white/NN 多档并存）',
    test: (text) => {
      const set = new Set((text.match(/text-white\/(\d{1,3})/g) || []).map((s) => s))
      return set.size >= 4
    },
  },
]

function scoreItems(issues) {
  const counts = {}
  for (const it of issues) counts[it.rule] = (counts[it.rule] || 0) + (it.count || 1)
  let penalty = 0
  for (const it of issues) penalty += (W[it.sev] || 1.5) * Math.min(it.count || 1, 8)
  const score = Math.max(0, Math.round(100 / (1 + penalty / 25))) // saturated: never floors at 0
  const bySeverity = { high: 0, medium: 0, low: 0 }
  for (const it of issues) bySeverity[it.sev] = (bySeverity[it.sev] || 0) + (it.count || 1)
  return { score, counts, bySeverity, penalty: Math.round(penalty) }
}
export { scoreItems }

function collectFiles(root) {
  const out = []
  const st = fs.statSync(root)
  if (st.isFile()) return EXTS.has(path.extname(root).toLowerCase()) ? [root] : []
  const stack = [root]
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name)) }
      else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name))
      if (out.length >= MAX_FILES) break
    }
  }
  return out
}

// Per-file cleanup: merge same-rule adjacent lines into one issue (with a count), then collapse
// same-location same-family issues to the highest severity. Keeps the list readable and honest.
function normalizeFileIssues(rel, raw) {
  raw.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
  const merged = []
  const byRule = new Map()
  for (const it of raw) {
    const key = rel + '\u0000' + it.rule
    const arr = byRule.get(key) || []
    arr.push(it); byRule.set(key, arr)
  }
  for (const [, arr] of byRule) {
    arr.sort((a, b) => a.line - b.line)
    let cur = null
    for (const it of arr) {
      if (cur && it.line - cur.lastLine <= 1) { cur.count += 1; cur.lastLine = it.line }
      else { cur = { ...it, count: 1, lastLine: it.line }; merged.push(cur) }
    }
  }
  // family collapse by coarse location bucket
  const kept = []
  const groupBest = new Map()
  for (const it of merged) {
    const fam = FAMILY[it.rule]
    if (!fam) { kept.push(it); continue }
    const key = fam + '|' + Math.floor(it.line / 4)
    const prev = groupBest.get(key)
    if (!prev) { groupBest.set(key, it); kept.push(it); continue }
    if ((W[it.sev] || 0) > (W[prev.sev] || 0)) {
      // replace prev in kept
      const idx = kept.indexOf(prev); if (idx >= 0) kept[idx] = it
      groupBest.set(key, it)
    }
  }
  kept.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
  return kept
}

export function scanPath(root) {
  const files = collectFiles(root)
  const issues = []
  for (const abs of files) {
    let text
    try { const st = fs.statSync(abs); if (st.size > MAX_BYTES) continue; text = fs.readFileSync(abs, 'utf8') } catch { continue }
    const rel = path.relative(root, abs) || path.basename(abs)
    const lines = text.split(/\r?\n/)
    const raw = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line || line.length > 2000) continue
      for (const rule of RULES) {
        if (rule.re.test(line)) raw.push({ file: rel, line: i + 1, rule: rule.id, sev: rule.sev, message: rule.msg, snippet: line.trim().slice(0, 120) })
      }
    }
    for (const fr of FILE_RULES) {
      if (fr.test(text)) raw.push({ file: rel, line: 1, rule: fr.id, sev: fr.sev, message: fr.msg, snippet: '' })
    }
    for (const it of normalizeFileIssues(rel, raw)) issues.push(it)
  }
  const s = scoreItems(issues)
  return { engine: 'builtin', root, files: files.length, issueCount: issues.length, score: s.score, penalty: s.penalty, bySeverity: s.bySeverity, counts: s.counts, issues }
}

export function normalizeImpeccable(json, root) {
  const items = Array.isArray(json) ? json : (json && (json.results || json.findings || json.issues)) || []
  const issues = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const rule = String(it.rule || it.ruleId || it.id || it.code || 'impeccable')
    const sevRaw = String(it.severity || it.level || it.priority || '').toLowerCase()
    const sev = /(^|p)0|high|block|error|critical/.test(sevRaw) ? 'high' : /(^|p)1|(^|p)2|med|warn/.test(sevRaw) ? 'medium' : 'low'
    const file = it.file || it.path || (it.location && it.location.file) || ''
    const line = it.line || (it.locus && it.locus.line) || (it.location && it.location.line) || 0
    issues.push({ file, line, rule, sev, message: String(it.message || it.description || it.msg || rule).slice(0, 200), snippet: String(it.snippet || '').slice(0, 120), count: 1 })
  }
  const s = scoreItems(issues)
  return { engine: 'impeccable', root, files: null, issueCount: issues.length, score: s.score, penalty: s.penalty, bySeverity: s.bySeverity, counts: s.counts, issues }
}
