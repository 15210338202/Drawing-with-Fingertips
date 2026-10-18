#!/usr/bin/env node
/**
 * 知识库校验器
 * 用法：node scripts/validate-styles.mjs
 *
 * 为什么需要它：styles.json 是**线上正在跑的数据**，改坏一条就可能让检索或出图失败。
 * 这个脚本把「什么算合格」变成机器能判的规则，改完跑一次就知道有没有问题。
 *
 * 规则来源：2026-10-18 的 P0-1 消融实验（见 docs/experiments.md）
 *   A 组  旧尺寸(1024×768) + 旧 prompt → 主体丢失，生成的是"另一只猫"
 *   B 组  新尺寸(≤512,加粗) + 旧 prompt → 主体保真      ⇒ 尺寸是主因
 *   X2 组 新尺寸 + 含 "misty mountains" 的旧画风 prompt → 主体保真，但背景被塞进水墨山峦
 *         ⇒ **styleModifiers 里的题材/场景词会漏进画面**，所以下面要拦这类词
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 词表与禁用词统一放在 _style-rules.mjs，和 styles-from-csv.mjs 共用同一份，避免规则漂移
import { CATEGORIES, THEMES, HARD_SUBJECTS, SOFT_SCENE, hasWord } from './_style-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = resolve(HERE, '../frontend/server/data/styles.json')

const REQUIRED = ['id', 'title', 'category', 'tags', 'themes', 'styleModifiers', 'contentHints', 'source', 'styleKey']

const errors = []
const warns = []
const err = (id, msg) => errors.push(`[${id}] ${msg}`)
const warn = (id, msg) => warns.push(`[${id}] ${msg}`)

let list
try {
  // Windows 上的编辑器（记事本、VSCode 的 "UTF-8 with BOM"）常常带 BOM，
  // 而 JSON.parse 遇到 BOM 会直接报 "Unexpected token ''"，先剥掉。
  const raw = readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
  list = JSON.parse(raw)
}
catch (e) {
  console.error(`✗ 读不到或不是合法 JSON：${FILE}\n  ${e.message}`)
  process.exit(1)
}

if (!Array.isArray(list)) {
  console.error('✗ 顶层必须是数组')
  process.exit(1)
}

const seenId = new Map()
const seenKey = new Map()
const seenTitle = new Map()
const seenMod = new Map()

list.forEach((e, i) => {
  const id = e?.id ?? `#${i}`

  // 1) 字段齐全
  for (const f of REQUIRED) {
    if (!(f in e)) { err(id, `缺少字段 ${f}`); continue }
    const v = e[f]
    if (Array.isArray(v) ? v.length === 0 : (typeof v !== 'string' || !v.trim())) {
      err(id, `字段 ${f} 为空`)
    }
  }

  // 2) id / styleKey / title 唯一，且格式规范
  if (typeof e.id === 'string') {
    if (!/^[a-z]{2}-\d{2}$/.test(e.id)) err(id, 'id 格式应为「两位小写字母-两位数字」，如 gf-03')
    if (seenId.has(e.id)) err(id, `id 重复，与第 ${seenId.get(e.id) + 1} 条冲突`)
    else seenId.set(e.id, i)
  }
  if (typeof e.styleKey === 'string' && e.styleKey.trim()) {
    if (!/^[a-z0-9-]+$/.test(e.styleKey)) err(id, 'styleKey 只能用小写字母/数字/连字符')
    if (seenKey.has(e.styleKey)) err(id, `styleKey 重复：${e.styleKey}`)
    else seenKey.set(e.styleKey, i)
  }
  if (typeof e.title === 'string' && e.title.trim()) {
    if (e.title.length > 12) err(id, `title 过长（${e.title.length} 字），卡片放不下，建议 ≤8 字`)
    if (seenTitle.has(e.title)) err(id, `title 重复：${e.title}`)
    else seenTitle.set(e.title, i)
  }

  // 3) category 必须是大类
  if (typeof e.category === 'string' && e.category.trim() && !CATEGORIES.includes(e.category)) {
    err(id, `category「${e.category}」不在允许列表。允许：${CATEGORIES.join(' / ')}`)
  }

  // 4) tags：检索键，只放画风词
  if (Array.isArray(e.tags)) {
    if (e.tags.length < 2) err(id, 'tags 至少 2 个（检索靠它，太少会搜不到）')
    if (new Set(e.tags).size !== e.tags.length) err(id, 'tags 内部有重复')
    // 类别名必须在 tags 里：否则用户搜这个大类名（如「超现实」）会搜不到任何东西
    if (typeof e.category === 'string' && e.category.trim() && !e.tags.includes(e.category)) {
      err(id, `tags 里没有「${e.category}」——用户搜这个大类名时会搜不到它，请把类别名加进 tags`)
    }
    for (const t of e.tags) {
      if (typeof t !== 'string' || !t.trim()) err(id, 'tags 里有空值')
      else if (t.length > 12) warn(id, `tag 偏长：${t}（${t.length} 字符）——检索是子串匹配，太长会降低命中率`)
    }
  }

  // 5) themes：题材标签，必须在词表里
  if (Array.isArray(e.themes)) {
    if (e.themes.length === 0) err(id, 'themes 至少 1 个')
    if (new Set(e.themes).size !== e.themes.length) err(id, 'themes 内部有重复')
    for (const t of e.themes) {
      if (!THEMES.includes(t)) err(id, `themes「${t}」不在词表。允许：${THEMES.join(' / ')}`)
    }
  }

  // 6) styleModifiers：纯画风，不能有题材/场景词（X2 的核心教训）
  if (typeof e.styleModifiers === 'string' && e.styleModifiers.trim()) {
    const low = e.styleModifiers.toLowerCase()
    for (const w of HARD_SUBJECTS) {
      if (hasWord(low, w)) {
        err(id, `styleModifiers 里出现题材词「${w}」——画什么由草图决定，这类词会漏进画面当内容（X2 组的失败原因）。请删掉，或挪到 contentHints`)
      }
    }
    for (const w of SOFT_SCENE) {
      if (hasWord(low, w)) {
        warn(id, `styleModifiers 里有体裁/场景词「${w}」——会带偏构图，确认是否真的要保留`)
      }
    }
    if (/[\u4E00-\u9FA5]/.test(e.styleModifiers)) {
      warn(id, 'styleModifiers 含中文——最终是喂给英文图像模型的，建议用英文')
    }
    if (e.styleModifiers.length < 25) warn(id, 'styleModifiers 偏短，可能不足以表达画风')
    if (seenMod.has(e.styleModifiers)) warn(id, `styleModifiers 与第 ${seenMod.get(e.styleModifiers) + 1} 条完全相同，疑似重复`)
    else seenMod.set(e.styleModifiers, i)
  }

  // 7) contentHints：只给文生图兜底，一条只写一个场景
  if (typeof e.contentHints === 'string' && e.contentHints.trim()) {
    if (e.contentHints.includes(';')) err(id, 'contentHints 里有分号——它只该写**一个**场景，多个主语拼起来会生成怪画面')
    if (e.contentHints.length > 90) warn(id, `contentHints 偏长（${e.contentHints.length} 字符），建议压到一句短语`)
  }
})

// 8) 动物覆盖率提醒（低龄儿童画得最多的就是动物）
const animalCount = list.filter(e => Array.isArray(e.themes) && e.themes.includes('动物')).length
const coverage = animalCount / (list.length || 1)

// ---------- 输出 ----------
console.log(`\n检查文件：${FILE}`)
console.log(`条目总数：${list.length}`)
console.log(`含「动物」题材的条目：${animalCount} 条（${(coverage * 100).toFixed(0)}%）\n`)

if (warns.length) {
  console.log(`⚠ 警告 ${warns.length} 条（不阻断，但建议看一下）：`)
  for (const w of warns) console.log('  ' + w)
  console.log('')
}

if (errors.length) {
  console.log(`✗ 错误 ${errors.length} 条（必须修，否则别提交）：`)
  for (const e of errors) console.log('  ' + e)
  console.log('')
  process.exit(1)
}

if (coverage < 0.2) {
  console.log('ℹ 提示：「动物」题材占比偏低。低龄儿童画得最多的是小猫小狗小恐龙，建议优先补几条 themes 含「动物」的画风。\n')
}

console.log('✓ 全部通过，可以提交。\n')
