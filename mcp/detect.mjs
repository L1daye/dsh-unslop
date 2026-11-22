// dsh-unslop — deterministic "slop" detector (offline, no LLM).
//
// The built-in engine scans UI source text and flags tell-tale AI-slop patterns; it never calls a
// model. When the impeccable CLI is installed, the host half prefers it (see host/index.js) and this
// module only normalises its JSON. Either way the result shape is the same so before/after comparison
// stays apples-to-apples.

import fs from 'node:fs'
import path from 'node:path'

const W = { high: 6, medium: 3, low: 1.5 }
const SEV_ORDER = ['high', 'medium', 'low']
const EXTS = new Set(['.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'coverage', '.turbo', '.svelte-kit', '.aoci'])
const MAX_FILES = 3000
const MAX_BYTES = 2 * 1024 * 1024

// Each rule: id, severity, human message, and a per-line RegExp. Calibrated on the "signs of slop"
// the unslop skill audits, plus a few objective quality smells.
export const RULES = [
  { id: 'gradient-surface', sev: 'high', msg: '紫/蓝渐变背景或卡片（AI slop 标志）', re: /\b(?:from|to|via)-(?:purple|violet|indigo|fuchsia|pink|blue)-\d{2,3}\b|bg-gradient-to-(?:r|br|b|bl|l|tl|tr)\b|linear-gradient\([^)]*(?:purple|violet|#8b5cf6|#a855f7|#6366f1|#7c3aed)/i },
  { id: 'gradient-text', sev: 'high', msg: '渐变文字（bg-clip-text / text-transparent / background-clip:text）', re: /bg-clip-text|text-transparent|background-clip:\s*text|-webkit-background-clip:\s*text/i },
  { id: 'colored-glow', sev: 'high', msg: '彩色发光/彩色阴影（glow）', re: /shadow-\[[^\]]*rgba?\(|drop-shadow-|box-shadow:[^;]*(?:rgba?\(|\b(?:purple|violet|indigo|blue|fuchsia|pink|cyan|#8b5cf6|#a855f7)\b)/i },
  { id: 'radial-wash', sev: 'high', msg: '径向色晕 / 模糊色块（blob）', re: /radial-gradient|blur-3xl|blur-2xl|blur-\[|bg-\[radial-gradient/i },
  { id: 'neon-border', sev: 'high', msg: '霓虹/高饱和彩色边框', re: /border-(?:purple|violet|indigo|fuchsia|pink|cyan|blue)-\d{3}/i },
  { id: 'emoji-icon', sev: 'high', msg: '用 emoji 当图标/装饰', re: /\p{Extended_Pictographic}/u },
  { id: 'uppercase-tracked', sev: 'medium', msg: '大写+宽字距标签（NAVIGATION 式）', re: /uppercase[^"'<>]*tracking-(?:wide|wider|widest)|tracking-(?:wider|widest)[^"'<>]*uppercase|text-transform:\s*uppercase/i },
  { id: 'heavy-weight', sev: 'medium', msg: '800/900 超重字重标题', re: /font-(?:extrabold|black)\b|font-weight:\s*(?:800|900)/i },
  { id: 'glass-card', sev: 'medium', msg: '玻璃拟态卡片（backdrop-blur）', re: /backdrop-blur|bg-white\/[0-9]{1,2}\b/i },
  { id: 'pulse-anim', sev: 'medium', msg: '无意义的呼吸/脉冲动画', re: /animate-(?:pulse|ping|bounce)\b/ },
  { id: 'transition-all', sev: 'medium', msg: 'transition-all（应指明具体属性）', re: /transition-all\b/ },
  { id: 'hover-scale', sev: 'medium', msg: 'hover:scale 放大动效', re: /hover:scale-\d/ },
  { id: 'badge-noise', sev: 'medium', msg: '“New ✨ / PRO / Beta 🚀” 徽章噪音', re: /New\s*✨|\bPRO\b|Beta\s*🚀|✨|🚀/ },
  { id: 'gradient-wordmark', sev: 'medium', msg: '渐变/闪光词标或 logo', re: /(?:logo|wordmark)[^"'<>]*(?:gradient|sparkle|✨)|sparkles?/i },
  { id: 'arbitrary-spacing', sev: 'low', msg: '任意像素间距（如 mt-[13px]），脱离 4px 栅格', re: /-\[[0-9]{1,3}px\]/ },
  { id: 'hype-words', sev: 'low', msg: '营销大词（supercharge/seamless/unlock/magic…）', re: /\b(?:supercharge|seamless|unlock|magic|revolutionar\w*|game.?chang\w*|AI-powered|effortless|cutting-edge|next-gen)\b/i },
  { id: 'exclamation', sev: 'low', msg: '界面文案里的感叹号', re: /["'>][^"'<>]{0,60}[A-Za-z\u4e00-\u9fa5]!!?[^"'<>]{0,10}["'<]/ },
  { id: 'fake-numbers', sev: 'low', msg: '假数据/占位（123,456 / [X] / Lorem ipsum）', re: /123,456|\[X\]|Lorem ipsum/i },
  { id: 'greeting', sev: 'low', msg: '问候式标题（Welcome back…）', re: /\b(?:Welcome back|Welcome,|欢迎回来|你好，)/i },
  { id: 'placeholder-ellipsis', sev: 'low', msg: '啰嗦占位（Search anything…）', re: /Search anything|Type anything|placeholder="[^"]*\.\.\."/i },
  { id: 'pill-everywhere', sev: 'low', msg: 'rounded-full 满屏胶囊', re: /rounded-full\b/ },
  { id: 'tiny-text', sev: 'low', msg: '过小字号（<11px）', re: /text-\[(?:[0-9]|10)px\]|font-size:\s*(?:[0-9]|10)px/i },
  { id: 'default-graphite', sev: 'low', msg: '默认 #161616 石墨灰（模板感）', re: /#161616\b/i },
]

function scoreFromIssues(issues) {
  const counts = {}
  for (const it of issues) counts[it.rule] = (counts[it.rule] || 0) + 1
  let penalty = 0
  const seen = {}
  for (const it of issues) {
    // cap each rule at 8 counted occurrences so one noisy file can't dominate
    if ((seen[it.rule] = (seen[it.rule] || 0) + 1) > 8) continue
    penalty += W[it.sev] || 1.5
  }
  const score = Math.max(0, Math.round(100 - Math.min(100, penalty)))
  const bySeverity = { high: 0, medium: 0, low: 0 }
  for (const it of issues) bySeverity[it.sev] = (bySeverity[it.sev] || 0) + 1
  return { score, counts, bySeverity, penalty: Math.min(100, Math.round(penalty)) }
}

function collectFiles(root) {
  const out = []
  const stat = fs.statSync(root)
  if (stat.isFile()) return EXTS.has(path.extname(root).toLowerCase()) ? [root] : []
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

// Built-in scan. root must be an absolute path inside the caller's project (host confines it).
export function scanPath(root) {
  const files = collectFiles(root)
  const issues = []
  const perFileRule = new Map() // "file\u0000rule" -> count
  for (const abs of files) {
    let text
    try {
      const st = fs.statSync(abs)
      if (st.size > MAX_BYTES) continue
      text = fs.readFileSync(abs, 'utf8')
    } catch { continue }
    const rel = path.relative(root, abs) || path.basename(abs)
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line || line.length > 2000) continue
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue
        const key = rel + '\u0000' + rule.id
        const c = (perFileRule.get(key) || 0) + 1
        perFileRule.set(key, c)
        if (c > 3) continue // per-file per-rule cap
        issues.push({ file: rel, line: i + 1, rule: rule.id, sev: rule.sev, message: rule.msg, snippet: line.trim().slice(0, 120) })
      }
    }
  }
  const s = scoreFromIssues(issues)
  return { engine: 'builtin', root, files: files.length, issueCount: issues.length, score: s.score, penalty: s.penalty, bySeverity: s.bySeverity, counts: s.counts, issues }
}

// Normalise impeccable's `detect --json` output into the same shape. Unknown schema -> best effort.
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
    const message = it.message || it.description || it.msg || rule
    issues.push({ file, line, rule, sev, message: String(message).slice(0, 200), snippet: String(it.snippet || '').slice(0, 120) })
  }
  const s = scoreFromIssues(issues)
  return { engine: 'impeccable', root, files: null, issueCount: issues.length, score: s.score, penalty: s.penalty, bySeverity: s.bySeverity, counts: s.counts, issues }
}

export const SEVERITIES = SEV_ORDER
