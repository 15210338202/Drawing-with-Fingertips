import stylesData from '../data/styles.json'

/** 知识库条目，字段定义见 docs 里的 RAG 知识库说明 */
interface StyleEntry {
  id: string
  title: string
  /** 大类（流派 / 地域）：只用于界面分组，**不参与检索打分** */
  category: string
  tags: string[]
  /** 题材标签：前端筛选用，并以 0.35 的低权重参与检索兜底（让「我想画动物」也能召回画风） */
  themes: string[]
  /** 纯画风/材质描述，不含具体物体 —— 画什么由用户草图决定 */
  styleModifiers: string
  /** 内容兜底：只有拿不到草图（文生图模型）时才拼进 prompt */
  contentHints: string
  negative: string
  source: string
  styleKey: string
}

/**
 * 直接 import JSON：构建时就被打进产物里，运行时不用读磁盘，
 * 也就不会出现「.output 里找不到 server/data/styles.json」这种部署问题。
 */
const STYLES = stylesData as StyleEntry[]

/** 题材词命中的权重：低于任何真实风格词命中（0.6/1.0），只做兜底召回 */
const THEME_WEIGHT = 0.35

const DEFAULT_K = 3
const MAX_K = 5

/**
 * 同义词组：命中组里任意一个词，整组都算命中。
 * 中文没有词边界，所以统一按「子串包含」来判，不做分词。
 * 拼音别名也放进来 —— LLM 解析出来的 style 经常是 guofeng 这种写法。
 *
 * 【划分原则】组内必须是「语义等价」的词，不能只是相关。
 * 之前把「传统」并进「国风」组，结果川剧脸谱（tags 里有"传统"）在查"国风"时也拿满分 ——
 * 宽泛词要单独成组，否则会污染所有风格。
 */
const SYNONYM_GROUPS: string[][] = [
  ['国风', '中国风', '中式', '古风', 'guofeng', 'chinese', 'traditional chinese'],
  ['水墨', '墨', '写意', 'ink', 'inkwash', 'shuimo'],
  ['工笔', 'gongbi'],
  ['山水', '风景', 'landscape', 'shanshui'],
  ['传统', '东方', 'traditional', 'oriental'],
  ['川渝', '四川', '重庆', 'sichuan', 'chongqing'],
  ['川剧', '脸谱', '戏曲', '变脸', 'opera'],
  ['赛博', '赛博朋克', '科幻', '未来', 'cyberpunk', 'scifi'],
  ['霓虹', '夜景', 'neon'],
  ['水彩', '淡彩', 'watercolor', 'shuicai'],
  ['像素', '复古', '怀旧', 'pixel', 'retro'],
  ['油画', '厚涂', '古典', 'oil painting', 'impasto', 'youhua'],
  // 西方古典一脉：用户常说「文艺复兴」「巴洛克」「写实」，这些词现有组里都没有
  ['文艺复兴', '巴洛克', '新古典', '写实', 'realism', 'renaissance', 'baroque'],
  ['极简', '线稿', '简笔', '黑白', 'minimal', 'line art'],
  ['二次元', '动漫', '日系', 'anime', 'dongman'],
]

/** 词 → 它所属的同义词组，查表比每次遍历数组快 */
const SYNONYM_INDEX = new Map<string, string[]>()
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYM_INDEX.set(word, group)
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ query?: unknown, k?: unknown }>(event)
  const query = typeof body?.query === 'string' ? body.query.trim() : ''

  /*
   * P2-11 之后这个接口的定位变了：
   * - Agent 聊天不再调它（风格清单已写进 system prompt，由模型直选 id）；
   * - 它只服务「手动浏览画廊」：query 为空就返回全部风格，score 统一 0。
   * 带 query 时仍保留原来的词表匹配，作为老入口和调试用。
   */
  if (!query) {
    return { results: STYLES.map(style => toResult(style, 0)) }
  }

  const k = clampK(body?.k)
  const text = query.toLowerCase()
  const concepts = extractConcepts(text)

  const results = STYLES
    .map(style => ({ style, score: scoreStyle(style, text, concepts) }))
    // 只回真正匹配上的：给用户塞一条 0 分的"参考风格"没有意义
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.style.id.localeCompare(b.style.id))
    .slice(0, k)
    .map(({ style, score }) => toResult(style, score))

  return { results }
})

/** 条目 → 响应体。浏览和检索两条路共用，避免字段漏掉一个 */
function toResult(style: StyleEntry, score: number) {
  return {
    id: style.id,
    title: style.title,
    // 这两个字段透出来是给前端做分组与题材筛选的；themes 另有 0.35 的低权重兜底命中
    category: style.category,
    themes: style.themes,
    // prompt 保留给旧消费方（界面展示、promptOverride），值就是纯画风描述
    prompt: style.styleModifiers,
    styleModifiers: style.styleModifiers,
    contentHints: style.contentHints,
    // 响应里保留 source，前端要显示"本次参考了：水墨国风（来源：自建）"
    source: style.source,
    score,
  }
}

/** k 默认 3、上限 5，防止一次返回太多把风格库撑爆 */
function clampK(raw: unknown) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_K
  return Math.min(MAX_K, Math.round(value))
}

/**
 * 把 query 拆成「概念」，每个概念是一组同义说法。
 * 例：「国风 水墨」→ [国风组, 水墨组]，命中 2 个概念的风格得满分。
 */
function extractConcepts(text: string): string[][] {
  const concepts = SYNONYM_GROUPS.filter(group => group.some(word => text.includes(word)))

  if (concepts.length) return concepts

  // 一个已知概念都没命中：退回按空格/标点切词，每个词自己算一组
  return text
    .split(/[^\w\u4e00-\u9fa5]+/)
    .filter(Boolean)
    .map(word => [word])
}

/**
 * 一个概念在一条风格上匹配得有多好，0–1。
 *
 * 关键在最后那个权重：用户**真的说了**的词（比如查"赛博朋克"时的"赛博"）算满，
 * 只是同义词表里顺带带的词（比如同一组里的"霓虹"）打六折。
 * 不区分的话，"赛博朋克"会让只带"霓虹"标签的川渝烟火和真正的赛博霓虹并列第一。
 */
function matchQuality(concept: string[], text: string, tags: string[], themes: string[]) {
  let best = 0

  for (const word of concept) {
    const saidByUser = text.includes(word)

    for (const tag of tags) {
      const hit = tag === word
        ? 1
        : (tag.includes(word) || word.includes(tag) ? 0.6 : 0)

      if (hit > 0) best = Math.max(best, hit * (saidByUser ? 1 : 0.6))
    }

    /*
     * 题材兜底：用户说「我想画动物」时，风格词一个都不命中，但 themes 里有「动物」。
     * 用低权重（0.35）参与，保证它能召回一批画风，又永远不会压过真正的风格词。
     */
    for (const theme of themes) {
      if (theme === word || theme.includes(word) || word.includes(theme)) {
        best = Math.max(best, THEME_WEIGHT * (saidByUser ? 1 : 0.6))
      }
    }
  }

  return best
}

/** 得分 = 各概念匹配质量的平均值；标题里直接命中再给一点加成 */
function scoreStyle(style: StyleEntry, text: string, concepts: string[][]) {
  if (!concepts.length) return 0

  const tags = style.tags.map(tag => tag.toLowerCase())
  const themes = (style.themes ?? []).map(t => t.toLowerCase())

  const total = concepts.reduce((sum, concept) => sum + matchQuality(concept, text, tags, themes), 0)
  let score = total / concepts.length

  const title = style.title.toLowerCase()
  if (concepts.some(concept => concept.some(word => title.includes(word)))) {
    score = Math.min(1, score + 0.15)
  }

  return Math.round(score * 100) / 100
}
