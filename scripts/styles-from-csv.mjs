#!/usr/bin/env node
/**
 * 把邝思绮填的 CSV 转成 styles.json 的条目。
 *
 * 用法：
 *   node scripts/styles-from-csv.mjs                  # 读 docs/styles-collect.csv，生成 styles.next.json 供审阅
 *   node scripts/styles-from-csv.mjs --no-ai          # 不调 DeepSeek，英文留空并标出待补（可在无网络时用）
 *   node scripts/styles-from-csv.mjs --apply          # 审阅通过后正式合并进 styles.json（会先备份到 scripts/.backup/）
 *   node scripts/styles-from-csv.mjs 路径.csv --apply  # 指定别的 CSV
 *
 * 设计原则：
 *   1. **她只写中文**。英文画风提示词由 DeepSeek 生成，生成结果**强制过题材词黑名单**（X2 组的教训）。
 *   2. **不直接改线上文件**。默认只产出 styles.next.json，确认后才 --apply，且 --apply 会先备份。
 *   3. id / styleKey 自动分配，她不用管编号。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATEGORIES, CATEGORY_EN, CATEGORY_PREFIX, HARD_SUBJECTS, THEMES,
  hasWord, splitMulti,
} from './_style-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LIVE = resolve(ROOT, 'frontend/server/data/styles.json')
const NEXT = resolve(ROOT, 'frontend/server/data/styles.next.json')
const ENV_FILE = resolve(ROOT, 'frontend/.env')
/**
 * --apply 前的备份目录。
 * 放在 scripts/ 下而不是 .tmp-ablation/：后者是消融实验截图的临时目录，随时会被整个删掉，
 * 备份写在那里就会出现「父目录不存在 → copyFileSync 抛 ENOENT → 审阅通过却合并失败」。
 * 该目录已在 .gitignore 里，备份只留本地。
 */
const BACKUP_DIR = resolve(HERE, '.backup')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const NO_AI = argv.includes('--no-ai')
const csvPath = resolve(ROOT, argv.find(a => a.endsWith('.csv')) ?? 'docs/styles-collect.csv')

const HEADERS = ['序号', '名称', '大类', '题材', '检索关键词', '画风中文描述', '内容中文示例', '来源', '备注']

// ---------------------------------------------------------------- CSV 解析
/** 支持引号包裹、字段内逗号与换行、BOM、CRLF */
function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuote) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else inQuote = false
      }
      else field += c
      continue
    }
    if (c === '"') inQuote = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* 忽略 */ }
    else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => String(v).trim() !== ''))
}

// ---------------------------------------------------------------- .env
function loadEnv() {
  if (!existsSync(ENV_FILE)) return
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

// ---------------------------------------------------------------- DeepSeek
const AI_SYSTEM = `You convert a Chinese description of an art STYLE into ONE English prompt for an image model.

Output strictly this JSON shape and nothing else:
{"styleModifiers": "...", "contentHints": "..."}

HARD RULES:
1. styleModifiers describes ONLY technique, medium, material, texture, brushwork, colour, lighting and composition.
2. styleModifiers must contain NO concrete subject nouns — no animals, people, objects, places or scenes. If the Chinese mentions what to draw, DO NOT translate it into styleModifiers.
3. contentHints is ONE short English scene phrase (what would be drawn if there were no sketch).
4. Both values must be English only, comma-separated keyword phrases, 15-40 words for styleModifiers, under 15 words for contentHints.
5. Never output forbidden subject words: ${HARD_SUBJECTS.join(', ')}.`

const AI_USER = (styleZh, contentZh) =>
  `画风描述（中文）：${styleZh}\n内容示例（中文）：${contentZh || '（未填）'}`

async function callDeepSeek(styleZh, contentZh) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY（应在 frontend/.env 里）')

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-flash',
      temperature: 0.3,
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: AI_USER(styleZh, contentZh) },
      ],
    }),
  })
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const data = await res.json()
  const raw = data?.choices?.[0]?.message?.content ?? ''
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`模型没返回 JSON：${raw.slice(0, 120)}`)
  return JSON.parse(raw.slice(start, end + 1))
}

/** 生成英文并按黑名单校验；命中就带上下文重试一次 */
async function generateEnglish(styleZh, contentZh, log) {
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await callDeepSeek(
      attempt === 1 ? styleZh : `${styleZh}\n\n（上一次生成里混进了题材名词：${last?.join(', ')}，这次绝对不能出现）`,
      contentZh,
    )
    const mod = String(out.styleModifiers ?? '').trim()
    const hints = String(out.contentHints ?? '').trim()
    const hits = HARD_SUBJECTS.filter(w => hasWord(mod.toLowerCase(), w))
    if (!hits.length) return { styleModifiers: mod, contentHints: hints }
    log.push(`    第 ${attempt} 次生成命中了题材词 [${hits.join(', ')}]${attempt === 1 ? '，重试…' : '，放弃'}`)
    last = hits
  }
  return { styleModifiers: '', contentHints: '', blocked: last }
}

// ---------------------------------------------------------------- 主流程
function main() {
  if (!existsSync(csvPath)) {
    console.error(`✗ 找不到 CSV：${csvPath}`)
    console.error(`  请先复制模板：docs/styles-collect.csv`)
    process.exit(1)
  }
  loadEnv()

  const live = JSON.parse(readFileSync(LIVE, 'utf8').replace(/^\uFEFF/, ''))

  const usedIds = new Set(live.map(e => e.id))
  const usedKeys = new Set(live.map(e => e.styleKey))
  const nextSeq = {}
  for (const e of live) {
    const m = /^([a-z]{2})-(\d{2})$/.exec(e.id)
    if (m) nextSeq[m[1]] = Math.max(nextSeq[m[1]] ?? 0, Number(m[2]))
  }

  const rows = parseCsv(readFileSync(csvPath, 'utf8'))
  if (rows.length < 2) { console.error('✗ CSV 里只有表头，没有数据行'); process.exit(1) }

  const header = rows[0].map(h => h.trim())
  const col = name => {
    const i = header.indexOf(name)
    return i >= 0 ? i : -1
  }
  for (const h of HEADERS) {
    if (col(h) < 0) { console.error(`✗ CSV 缺少列「${h}」。表头应为：${HEADERS.join(',')}`); process.exit(1) }
  }

  const problems = []
  const generated = []

  return (async () => {
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r]
      const get = name => String(cells[col(name)] ?? '').trim()
      const lineNo = r + 1
      const where = `第 ${lineNo} 行`

      const title = get('名称')
      const category = get('大类')
      const themes = splitMulti(get('题材'))
      const tags = splitMulti(get('检索关键词'))
      const styleZh = get('画风中文描述')
      const contentZh = get('内容中文示例')
      const source = get('来源') || '自建'

      const bad = []
      if (!title) bad.push('名称为空')
      if (title.length > 12) bad.push(`名称太长（${title.length} 字，≤12）`)
      if (!CATEGORIES.includes(category)) bad.push(`大类「${category}」无效（允许：${CATEGORIES.join('/')}）`)
      if (!themes.length) bad.push('题材为空')
      for (const t of themes) if (!THEMES.includes(t)) bad.push(`题材「${t}」不在词表（允许：${THEMES.join('/')}）`)
      if (tags.length < 2) bad.push('检索关键词至少 2 个')
      if (!styleZh) bad.push('画风中文描述为空')
      if (bad.length) { problems.push(`${where}「${title || '?'}」：${bad.join('；')}`); continue }

      const prefix = CATEGORY_PREFIX[category]
      const seq = (nextSeq[prefix] ?? 0) + 1
      nextSeq[prefix] = seq
      const id = `${prefix}-${String(seq).padStart(2, '0')}`

      let styleKey = `${CATEGORY_EN[category]}-${String(seq).padStart(2, '0')}`
      let bump = 2
      while (usedKeys.has(styleKey)) styleKey = `${CATEGORY_EN[category]}-${String(seq).padStart(2, '0')}-${bump++}`
      usedIds.add(id)
      usedKeys.add(styleKey)

      let styleModifiers = ''
      let contentHints = ''
      let flag = ''

      if (NO_AI) {
        flag = '（--no-ai：英文留空，需人工补写）'
      }
      else {
        process.stdout.write(`  · ${id} ${title} … `)
        const log = []
        try {
          const out = await generateEnglish(styleZh, contentZh, log)
          styleModifiers = out.styleModifiers
          contentHints = out.contentHints
          if (out.blocked) flag = `（AI 两次都生成了题材词 [${out.blocked.join(', ')}]，需人工重写 styleModifiers）`
          process.stdout.write(flag ? '⚠\n' : 'ok\n')
        }
        catch (err) {
          flag = `（AI 调用失败：${err.message}）`
          process.stdout.write('✗\n')
        }
        for (const l of log) console.log(l)
      }

      generated.push({
        id,
        title,
        category,
        tags,
        themes,
        styleModifiers,
        contentHints,
        negative: '',
        source,
        styleKey,
        _csvLine: lineNo,
        _note: flag,
      })
    }

    // ---------------- 输出
    console.log('')
    if (problems.length) {
      console.log(`✗ 有 ${problems.length} 行不合格，已跳过（其余继续处理）：`)
      for (const p of problems) console.log('  - ' + p)
      console.log('')
    }
    if (!generated.length) { console.error('✗ 没有任何一行可用，未生成文件'); process.exit(1) }

    const needManual = generated.filter(g => !g.styleModifiers)
    console.log(`处理完成：可用 ${generated.length} 条，其中 ${needManual.length} 条英文待补`)

    // 写审阅文件（去掉 _ 开头的内部字段）
    const merged = [...live, ...generated.map(({ _csvLine, _note, ...rest }) => rest)]
    writeFileSync(NEXT, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    console.log(`\n已生成审阅文件：${relative(ROOT, NEXT)}（共 ${merged.length} 条 = 现有 ${live.length} + 新增 ${generated.length}）`)

    if (needManual.length) {
      console.log('\n⚠ 下面这些条目的英文还是空的，--apply 之前必须补齐：')
      for (const g of needManual) console.log(`  - 第 ${g._csvLine} 行 ${g.id} ${g.title} ${g._note}`)
    }

    if (APPLY_SAFE_CHECK()) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const bak = resolve(BACKUP_DIR, `styles.before-csv-apply.${stamp}.json`)
      // 先建目录再复制：copyFileSync 不会自动创建父目录，第一次 --apply 时会直接 ENOENT
      mkdirSync(BACKUP_DIR, { recursive: true })
      copyFileSync(LIVE, bak)
      copyFileSync(NEXT, LIVE)
      console.log(`\n✓ 已合并进 styles.json（备份：${relative(ROOT, bak)}）`)
      console.log('  请再跑一次：node scripts/validate-styles.mjs')
    }
    else if (APPLY) {
      console.log('\n✗ 还有英文待补的条目，拒绝 --apply。补齐后重跑。')
      process.exit(1)
    }
    else {
      console.log('\n下一步：')
      console.log('  1) 打开 styles.next.json 审阅（重点看 styleModifiers 有没有混进题材名词）')
      console.log('  2) 满意后运行：node scripts/styles-from-csv.mjs --apply')
    }
  })()
}

/** --apply 的前置条件：没有待补英文的条目 */
function APPLY_SAFE_CHECK() {
  if (!APPLY) return false
  const next = JSON.parse(readFileSync(NEXT, 'utf8'))
  return next.every(e => typeof e.styleModifiers === 'string' && e.styleModifiers.trim())
}

main().catch((err) => {
  console.error('\n✗ 运行失败：', err?.message ?? err)
  process.exit(1)
})
