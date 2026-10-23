import { defaultStyleId, rankStylesByKeywords, resolveStyleId } from './styles'
import type { StyleLike } from './styles'

/** AI 推荐的一条风格：只信 id、分数和理由，标题由前端用风格库补 */
export interface StyleSuggestion {
  styleKey: string
  score: number
  reason: string
}

/** 理由太长会撑破结果 Sheet，截断到一句短评 */
const REASON_MAX_LENGTH = 48

/** 没拿到 AI 结果时，给每档一个递减的置信度，避免三条都写 0.9 */
const FALLBACK_SCORES = [0.62, 0.54, 0.46]

/**
 * 极简线稿本身的改动很小，用户通常想要“被修饰过”的结果。
 * 不删除这个方向，只把它从首选位置压到备选位置。
 */
const MINIMAL_STYLE_PENALTY = 0.08
const MINIMAL_STYLE_PATTERN = /极简|线稿|minimal|line[\s-]*art/i

/**
 * 把模型返回的 styleSuggestions 洗成可用列表：
 * - 只认风格库里的 id（模型经常编 gf-99，或把标题当 id）；
 * - 分数夹到 0–1，按分数降序；
 * - 去重；不足 3 条用本地关键词排序补齐。
 *
 * 服务端不信任模型输出：哪怕它返回了 5 条、字段类型全错，这里也要给出稳定的 3 条。
 */
export function normalizeStyleSuggestions(
  raw: unknown,
  styles: StyleLike[],
  keywords = '',
  limit = 3,
): StyleSuggestion[] {
  const list = Array.isArray(raw) ? raw : []
  const result: StyleSuggestion[] = []
  const seen = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue

    const record = item as Record<string, unknown>
    const styleKey = resolveStyleId(
      record.styleKey ?? record.styleId ?? record.id ?? record.title,
      styles,
    )
    if (!styleKey || seen.has(styleKey)) continue

    const rawScore = Number(record.score)
    const score = Number.isFinite(rawScore) ? clamp(rawScore, 0, 1) : 0.5
    const reason = cleanReason(record.reason) || fallbackReason(styleKey, styles, keywords)

    seen.add(styleKey)
    result.push({ styleKey, score, reason })
  }

  // 模型给不满 / 全都不合法：按关键词和标签补，保证结果页始终有 3 个可选方向
  for (const style of rankFallbackStyles(styles, keywords)) {
    if (result.length >= limit) break
    if (seen.has(style.id)) continue

    seen.add(style.id)
    result.push({
      styleKey: style.id,
      score: FALLBACK_SCORES[result.length] ?? 0.4,
      reason: fallbackReason(style.id, styles, keywords),
    })
  }

  applyMinimalPreference(result, styles)
  result.sort((a, b) => b.score - a.score)
  return result.slice(0, limit)
}

/** 没有 AI 时的完整兜底：关键词命中优先，否则从清单头部挑 */
export function fallbackStyleSuggestions(
  styles: StyleLike[],
  keywords = '',
  limit = 3,
): StyleSuggestion[] {
  return normalizeStyleSuggestions([], styles, keywords, limit)
}

/**
 * 极简线稿通常只是把原图描一遍，视觉变化小；
 * 用户更想要“被修饰过”的结果，所以保留推荐但把它从第一位压下来。
 */
function applyMinimalPreference(list: StyleSuggestion[], styles: StyleLike[]): void {
  if (list.length < 2) return

  const isMinimal = (styleKey: string) => {
    const style = styles.find(item => item.id === styleKey)
    // 只看标题，不看 tags：ab-01「抽象色域」的 tags 里也有“极简”，
    // 用 tags 匹配会把抽象色块误判成线稿。
    return style ? MINIMAL_STYLE_PATTERN.test(style.title) : false
  }

  for (const item of list) {
    if (isMinimal(item.styleKey)) {
      item.score = clamp(item.score - MINIMAL_STYLE_PENALTY, 0, 1)
    }
  }

  list.sort((a, b) => b.score - a.score)

  // 即使模型/兜底把它排第一，也强制至少让一个非极简风格排在前面。
  // 仍然保留这条推荐，不删除；用户依然可以在结果页手动点它。
  if (!isMinimal(list[0].styleKey)) return

  const minimal = list.shift()
  if (!minimal || !list.length) {
    if (minimal) list.unshift(minimal)
    return
  }

  list.sort((a, b) => b.score - a.score)
  const firstOther = list[0]
  minimal.score = Math.min(minimal.score, Math.max(0, firstOther.score - 0.01))
  list.splice(1, 0, minimal)
}

function rankFallbackStyles(styles: StyleLike[], keywords: string): StyleLike[] {
  const ranked = rankStylesByKeywords(styles, keywords, 6)
  const fallback = styles.find(style => style.id === defaultStyleId(styles))
  const rest = styles.filter(style => !ranked.some(item => item.id === style.id))

  return [
    ...ranked,
    ...(fallback ? [fallback] : []),
    ...rest,
  ]
}

function fallbackReason(styleKey: string, styles: StyleLike[], keywords: string): string {
  const style = styles.find(item => item.id === styleKey)
  if (!style) return '这个方向和画面里的气质很接近。'

  const words = String(keywords ?? '')
    .toLowerCase()
    .split(/[,\s]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 3)

  const hit = words.find(word => style.tags.some(tag => tag.toLowerCase().includes(word) || word.includes(tag.toLowerCase())))
  if (hit) return `画面里的「${hit}」和${style.title}的质感很合拍。`

  const tags = style.tags.slice(0, 2).join('、')
  return tags
    ? `${style.title}的${tags}，能接住这张画的气质。`
    : `${style.title}的气质和这张画很接近。`
}

function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_MAX_LENGTH)}…` : text
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
