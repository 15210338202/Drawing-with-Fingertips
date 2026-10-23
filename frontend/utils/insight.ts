/**
 * 「共情式解读」的纯逻辑：多种语气模板 + 结果清洗 + 兜底。
 *
 * 为什么单独抽出来：
 * 1. 语气模板是产品文案，会反复调，放这里改了不用碰路由；
 * 2. 大模型的输出永远不可信（少字段、多说一句、suggestions 只给两个、带 markdown 围栏），
 *    清洗规则必须有单测，否则线上表现全看模型心情。
 */

/** 一次解读的结果结构（前端卡片直接按这个渲染） */
export interface Insight {
  /** 观察：看到了什么（颜色、线条、疏密、留白） */
  observation: string
  /** 感受：「我好像感觉到…」 */
  feeling: string
  /** 邀请：一个开放问题 */
  invitation: string
  /** 提议：3 个艺术转化方向，每个 ≤6 字 */
  suggestions: string[]
  /** 实际使用的语气 */
  tone: InsightToneKey
}

export type InsightToneKey = 'gentle' | 'curious' | 'poetic' | 'encourage'

export interface InsightToneMeta {
  key: InsightToneKey
  /** 按钮上显示的名字 */
  label: string
  /** 一句话说明这种语气的差别，给前端做 title */
  hint: string
}

/** 四种语气：同一张画，四种陪法 */
export const INSIGHT_TONES: InsightToneMeta[] = [
  { key: 'gentle', label: '温柔陪伴', hint: '先描述再给一个轻声的猜测，不追问太多' },
  { key: 'curious', label: '好奇提问', hint: '少下判断，多用问题把话语权还给孩子' },
  { key: 'poetic', label: '诗意想象', hint: '用比喻和画面感复述这幅画' },
  { key: 'encourage', label: '鼓励过程', hint: '肯定尝试与坚持，不谈画得像不像' },
]

export const DEFAULT_TONE: InsightToneKey = 'gentle'

/** 建议池：模型给不满 3 个、或者给了超长/重复的内容时从这里补 */
export const SUGGESTION_POOL = [
  '水墨风',
  '治愈绘本',
  '星空梦境',
  '水彩轻语',
  '剪纸民俗',
  '像素童话',
  '暖色油画',
  '线稿极简',
]

/** 三个建议的兜底（DeepSeek 完全不可用时整段文案也用它） */
export const FALLBACK_SUGGESTIONS = SUGGESTION_POOL.slice(0, 3)

/** 没有任何模型可用时的整段兜底文案 */
export const FALLBACK_INSIGHT: Insight = {
  observation: '我看到了一幅充满想象力的线条，它们有自己的节奏。',
  feeling: '我好像感觉到你很专注，画的时候整个人都安静下来了。',
  invitation: '能告诉我这根长长的线是什么吗？',
  suggestions: [...FALLBACK_SUGGESTIONS],
  tone: DEFAULT_TONE,
}

/** 建议文案的长度上限（按产品要求：各 ≤6 字） */
const SUGGESTION_MAX_LENGTH = 6

/** 各字段的长度上限：防止模型写小作文把卡片撑破 */
const LIMITS = {
  observation: 160,
  feeling: 120,
  invitation: 90,
} as const

/** 判断语气 key 是否合法，非法一律回默认 */
export function normalizeTone(value: unknown): InsightToneKey {
  const key = typeof value === 'string' ? value.trim() : ''
  return (INSIGHT_TONES.some(t => t.key === key) ? key : DEFAULT_TONE) as InsightToneKey
}

/**
 * 构造 system prompt。
 * 「看」和「说」分离：视觉关键词由 llava 提供，这里只负责把它们讲成人话。
 *
 * 共同约束（四个模板都带）：
 * - 不判断画得像什么、不纠正、不下定义；
 * - 不猜测任何身心状况（这类表述对特殊人群极不友好，也超出能力边界）；
 * - 严格输出 JSON，字段名固定，方便前端直接渲染。
 */
export function buildInsightPrompt(
  tone: InsightToneKey,
  keywords: string,
  styleCatalog = '',
): string {
  const styleBlock = styleCatalog
    ? `
风格库（styleKey 必须原样取自这里，不能编造）：
${styleCatalog}

请再从风格库里挑 3 个最适合这幅画的风格，按匹配度从高到低，给出 0–1 的分数和一句具体理由：
- reason 要提到画面里的线条/颜色/留白/疏密，不要只写“很适合”；
- 三个 styleKey 不能重复；
- 极简/线稿（如 mn-01）通常只是描一遍原图，改动较小；除非画面本身就是极简线稿，否则只作为备选，不要排在第一位；
- 这 3 条会直接展示给用户，理由要像一句温柔、具体的推荐语。
`.trim()
    : ''

  const schema = styleCatalog
    ? '{"observation":"…","feeling":"…","invitation":"…","suggestions":["…","…","…"],"styleSuggestions":[{"styleKey":"gf-01","score":0.9,"reason":"…"}]}'
    : '{"observation":"…","feeling":"…","invitation":"…","suggestions":["…","…","…"]}'

  const common = `
你是一位善于观察的儿童艺术陪伴者，正在看一幅孩子的画。
硬性要求：
- 不要判断"画得像什么"，不要纠正，不要下定义；
- 禁止出现"正确/错误/画得像/应该是"这类评判词；
- 不要猜测或诊断任何身心状况；
- 只用中文，语气自然口语，不要 markdown。
参考视觉关键词（可能不准，仅供你参考，不要直接罗列）：${keywords}

严格输出 JSON，且只有 JSON：
${schema}
其中：
- observation（观察）：≤2 句，描述颜色、线条走向、疏密、留白；
- feeling（感受）：以"我好像感觉到"开头，给 1 个开放的情绪猜测，并说明依据；
- invitation（邀请）：1 个开放问题，邀请孩子自己说说；
- suggestions（提议）：3 个艺术转化方向，每个不超过 6 个字。
${styleBlock}
`.trim()

  const variants: Record<InsightToneKey, string> = {
    gentle: `语气：温柔陪伴。观察要具体而克制，情绪猜测只给一个，避免连续追问。
描述之后停一下，让孩子有余地。`,

    curious: `语气：好奇提问。少做解读，多用问题；invitation 要问得具体（比如某根线、某块颜色），
而不是"你想表达什么"这种大问题。feeling 只轻轻带一句。`,

    poetic: `语气：诗意想象。允许用一个比喻（比如"像一阵风"、"像一条小路"）来复述这幅画，
但不要夸张堆砌形容词。observation 要有画面感，feeling 要柔和。`,

    encourage: `语气：鼓励成长。重点肯定"你在尝试/坚持/反复修改"这些过程，
不谈结果好不好、像不像。invitation 要让孩子愿意再画下去。`,
  }

  return `${common}\n\n${variants[tone]}`
}

/**
 * llava 输出的常见废话词。
 * 它经常整句回答（"The image features a house with a blue roof…"），
 * 直接按空格切会给出一堆 the / with / image，喂给下一轮 prompt 反而干扰。
 */
const STOPWORDS = new Set([
  'the', 'and', 'are', 'was', 'were', 'been', 'being', 'but', 'for', 'from', 'has', 'have',
  'had', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'with', 'without', 'into',
  'image', 'images', 'picture', 'pictures', 'drawing', 'drawings', 'sketch', 'photo', 'photos',
  'appears', 'appear', 'looks', 'look', 'seems', 'seem', 'shows', 'show', 'features', 'featuring',
  'some', 'very', 'also', 'can', 'could', 'would', 'should', 'may', 'might', 'which', 'while',
  'simple', 'simple-looking', 'overall', 'scene', 'likely', 'probably', 'probably,', 'about',
])

/**
 * 清洗 llava 输出的视觉关键词。
 * 只保留字母、数字、逗号和空格；丢掉句子里的功能词；最多 10 个词。
 */
export function cleanKeywords(raw: unknown): string {
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9,\s]/g, ' ')
    .split(/[,\s]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 3 && !STOPWORDS.has(word))

  // 去重，保留出现顺序
  const unique = [...new Set(words)].slice(0, 10)

  return unique.length >= 2 ? unique.join(', ') : 'abstract lines, shapes'
}

/**
 * 从模型回复里抠出 JSON。
 * 模型经常包一层 ```json 围栏，或者在前后加一句"好的"——都得容错。
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? raw).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  }
  catch {
    return null
  }
}

/**
 * 把模型输出规整成 Insight：
 * - 字段缺失/类型不对 → 用兜底文案；
 * - 文本过长 → 截断；
 * - suggestions 清洗后不足 3 个 → 从建议池补齐；
 * - 语气字段强制写回实际使用的语气（模型可能自己改）。
 */
export function normalizeInsight(raw: Record<string, unknown> | null, tone: InsightToneKey): Insight {
  const pick = (key: keyof typeof LIMITS) => {
    const value = raw?.[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  return {
    observation: clampText(pick('observation'), LIMITS.observation) || FALLBACK_INSIGHT.observation,
    feeling: clampText(pick('feeling'), LIMITS.feeling) || FALLBACK_INSIGHT.feeling,
    invitation: clampText(pick('invitation'), LIMITS.invitation) || FALLBACK_INSIGHT.invitation,
    suggestions: normalizeSuggestions(raw?.suggestions),
    tone,
  }
}

/**
 * 清洗建议列表：
 * 去掉空白/标点、压到 6 字以内、去重，最后不足 3 个用建议池补齐。
 * 补齐时也会跳过已存在的项，避免出现两个"水墨风"。
 */
export function normalizeSuggestions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []

  const result: string[] = []

  for (const item of list) {
    if (typeof item !== 'string') continue

    const text = item
      .replace(/[\s"'`、。，,.!?！？:：;；]/g, '')
      .slice(0, SUGGESTION_MAX_LENGTH)

    if (!text || result.includes(text)) continue
    result.push(text)
    if (result.length === 3) return result
  }

  for (const item of SUGGESTION_POOL) {
    if (result.length === 3) break
    if (!result.includes(item)) result.push(item)
  }

  return result
}

function clampText(text: string, max: number) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}
