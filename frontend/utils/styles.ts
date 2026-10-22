/**
 * 画风清单相关的纯逻辑：给模型的目录文本 + 幻觉 id 纠偏。
 *
 * 抽成纯函数的原因：这两件事都不依赖请求上下文，但都极容易出错——
 * 目录漏了标签模型就选不准；纠偏写错一个分支就会把合法 id 改掉。
 * 放在 utils 里就能直接单测，路由只负责「读清单 → 调模型 → 过一遍纠偏」。
 */

export interface StyleLike {
  id: string
  title: string
  tags: string[]
}

/** 模型完全没线索时用的默认画风（取清单第一条） */
export function defaultStyleId(styles: StyleLike[]): string {
  return styles[0]?.id ?? 'gf-01'
}

/**
 * 拼出注入 system prompt 的清单文本。
 * 只给 id / 标题 / 前几个标签：够模型判断，又不至于把 prompt 撑长。
 */
export function buildStyleCatalog(styles: StyleLike[], tagsPerStyle = 5): string {
  return styles
    .map(style => `- ${style.id}：${style.title}（${style.tags.slice(0, tagsPerStyle).join('、')}）`)
    .join('\n')
}

/**
 * 把模型给的 styleKey 解析成真实 id；认不出来返回 null。
 *
 * 依次尝试：原样 id → 大小写不同的 id → 标题 → 文本里夹带的 id → 文本里夹带的标题。
 * 这几条覆盖了实测里模型的所有走样方式（"GF-01"、"水墨国风"、"gf-01（水墨）"）。
 */
export function resolveStyleId(raw: unknown, styles: StyleLike[]): string | null {
  if (typeof raw !== 'string') return null

  const value = raw.trim()
  if (!value) return null

  const lower = value.toLowerCase()
  const byId = styles.find(style => style.id.toLowerCase() === lower)
  if (byId) return byId.id

  const byTitle = styles.find(style => style.title === value)
  if (byTitle) return byTitle.id

  const idInside = styles.find(style => lower.includes(style.id.toLowerCase()))
  if (idInside) return idInside.id

  const titleInside = styles.find(style => value.includes(style.title))
  return titleInside?.id ?? null
}

export interface AgentActionLike {
  tool: string
  args: Record<string, unknown>
}

export interface NormalizeResult {
  actions: AgentActionLike[]
  /** 纠偏说明，按发生顺序排列，由调用方并进 reasoning */
  repairs: string[]
}

/** 随机挑一个（可排除上次用过的），给「随便」兜底用；random 可注入便于测试 */
export function pickRandomStyle(
  styles: StyleLike[],
  options: { random?: () => number, avoid?: string[] } = {},
): string {
  const random = options.random ?? Math.random
  const avoid = new Set(options.avoid ?? [])
  const pool = styles.filter(style => !avoid.has(style.id))
  const list = pool.length ? pool : styles

  if (!list.length) return ''

  const index = Math.min(list.length - 1, Math.floor(random() * list.length))
  return list[index]?.id ?? ''
}

/**
 * 幻觉防护：模型可能编出不存在的 styleKey（gf-99），也可能把标题当 id。
 * 这里把 generate_image 的 styleKey 统一纠成真实 id；认不出来就用 fallbackId。
 *
 * @param options.fallbackId 认不出来时用哪个（默认第一条）
 * @param options.avoidDefault 为 true 时，即使模型选了默认画风也换掉——
 *        用于「随便来一个」这类请求，否则每次都是同一个风格，用户会觉得"这也要我教"
 */
export function normalizeStyleActions(
  actions: AgentActionLike[],
  styles: StyleLike[],
  options: { fallbackId?: string, avoidDefault?: boolean } = {},
): NormalizeResult {
  const repairs: string[] = []
  const fallback = options.fallbackId || defaultStyleId(styles)
  const baseline = defaultStyleId(styles)

  const normalized = actions.map((action) => {
    if (action.tool !== 'generate_image') return action

    const requested = action.args?.styleKey
    let resolved = resolveStyleId(requested, styles)

    if (!resolved) {
      repairs.push(`模型给的画风「${String(requested ?? '空')}」不在清单里，已换一个相近的`)
      resolved = fallback
    }
    else if (options.avoidDefault && resolved === baseline && fallback !== baseline) {
      repairs.push('「随便」类请求不该总用默认画风，已换一个相近的')
      resolved = fallback
    }

    return { ...action, args: { ...action.args, styleKey: resolved } }
  })

  return { actions: normalized, repairs }
}

// ===== 「随便来一个」：先按画面猜，猜不到就随机相近 =====

/** 没有明确倾向的说法 */
const CASUAL_PATTERN = /随便|随意|都行|都可以|你决定|你来决定|你看着办|看着办|你选|任意|随便来|随便挑/

/**
 * 判断用户是不是「随便来一个」这类没有倾向的说法。
 * 客户端用它决定要不要把草图一起发上去（服务端要靠图猜内容），服务端用它决定兜底策略。
 */
export function detectCasualIntent(text: string): boolean {
  return typeof text === 'string' && CASUAL_PATTERN.test(text)
}

/**
 * 按画面关键词给画风排序，取前几个当候选。
 *
 * 只用 tags 做子串匹配就够：llava 吐的是英文名词（cat / watercolor / pixel…），
 * styles.json 的 tags 里正好有 ink、watercolor、pixel、anime 这些词。
 * 匹配不到就返回空数组，上层再退化成随机挑。
 */
export function rankStylesByKeywords(styles: StyleLike[], keywords: string, limit = 3): StyleLike[] {
  const words = String(keywords ?? '')
    .toLowerCase()
    .split(/[,\s]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 3 && !['abstract', 'lines', 'shapes', 'white', 'black'].includes(word))

  if (!words.length) return []

  const scored = styles.map((style) => {
    const tags = style.tags.map(tag => tag.toLowerCase())
    let score = 0

    for (const word of words) {
      for (const tag of tags) {
        if (tag === word) score += 2
        else if (tag.includes(word) || word.includes(tag)) score += 1
      }
    }

    return { style, score }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.style.id.localeCompare(b.style.id))
    .slice(0, limit)
    .map(item => item.style)
}
