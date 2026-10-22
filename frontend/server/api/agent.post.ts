import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { AGENT_TOOLS_PROMPT, TOOL_NAMES } from '../../utils/tools'
import { buildStyleCatalog, defaultStyleId, detectCasualIntent, normalizeStyleActions, pickRandomStyle, rankStylesByKeywords } from '../../utils/styles'
import { extractVisualKeywords } from '../utils/vision'
import stylesData from '../data/styles.json'

/**
 * DeepSeek 的接口是 OpenAI 兼容的，所以不用装 DeepSeek 专用 SDK：
 * 复用已有的 @ai-sdk/openai，只换 baseURL 和 model id。
 * base_url 写成 https://api.deepseek.com/v1 也等价（官方两种都接受）。
 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * V4.1-Flash 的 model id 就是不带版本号的 deepseek-flash，
 * 旧名 deepseek-v4-flash 目前仍可路由，但指向的是同一个模型，别再用旧名。
 */
const DEEPSEEK_MODEL = 'deepseek-flash'

/** 一次最多 3 个动作、5 条推理，防止模型一口气返回一长串 */
const MAX_ACTIONS = 3
const MAX_REASONING = 5

/** 温度：正常取 0.7；解析失败重试时降到 0，输出更确定 */
const TEMPERATURE = 0.7
const RETRY_TEMPERATURE = 0

// ===== P2-11：把画风清单直接写进 prompt，由模型直选 id =====
interface StyleEntry {
  id: string
  title: string
  tags: string[]
}

const STYLES = stylesData as StyleEntry[]

/** 模型完全没线索时的默认画风 */
const DEFAULT_STYLE_ID = defaultStyleId(STYLES)

/**
 * 注入给模型的清单。
 * 只给 id / 标题 / 前几个标签：够它判断，又不至于把 prompt 撑长
 * （二十来条的规模下，这比任何向量检索都准，也不会出现"毛茸茸匹配不到治愈绘本"那种事）。
 */
const STYLE_CATALOG = buildStyleCatalog(STYLES)

const agentResponseSchema = z.object({
  reply: z.string().describe('给用户看的一句话'),
  actions: z
    .array(
      z.object({
        tool: z.enum([...TOOL_NAMES]),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .max(MAX_ACTIONS)
    .default([]),
  reasoning: z.array(z.string()).max(MAX_REASONING).default([]),
})

type AgentResponse = z.infer<typeof agentResponseSchema>

const SYSTEM_PROMPT = `你是一个「隔空绘画」创作助手。用户用手指在空中画画，你负责理解他的意图，帮他调整画面或做风格化。

你可以调用的工具：
${AGENT_TOOLS_PROMPT}

可选画风清单（generate_image 的 styleKey 只能填下面的 id）：
${STYLE_CATALOG}

选画风的规则：
1. 用户明确说了画风（国风/水彩/像素/赛博…）→ 选最匹配的 id；
2. 用户没直说、但语境能推断（例如"想要毛茸茸软软的感觉"→ 治愈绘本；"想要很酷很未来"→ 赛博霓虹）→ 直接替他选一个，并在 reasoning 里写清依据；
3. 用户说"随便/你决定/都行/都可以"这类话时：
   - 如果消息里给了「候选画风」，从候选里挑一个最配画面的（必须在清单内）；
   - 没有候选就自己挑一个，但**不要每次都选同一个**，也别和「上次使用画风」重复；
   - 同样要在 reasoning 里写清为什么选它；
4. 完全没有任何线索（画布是空的、用户也没说什么）→ 用默认 ${DEFAULT_STYLE_ID}；
5. 只能从清单里选，绝对不要编造 id；也不要为了选风格多问一句，直接执行。

必须严格遵守下面的输出规则：
1. 只输出一个 JSON 对象。不要写解释文字，不要加 markdown 代码块，不要加任何前后缀。
2. JSON 结构固定为：
{"reply": "给用户看的一句话", "actions": [{"tool": "工具名", "args": {}}], "reasoning": ["一句判断依据"]}
3. actions 最多 ${MAX_ACTIONS} 个，按执行先后顺序排列。不确定要做什么就返回空数组 []。
4. reasoning 最多 ${MAX_REASONING} 条，每条一句中文短句，写你判断的依据（会展示给用户看）。
5. 只能使用上面列出的工具名；args 里的字段名必须和工具签名完全一致，不要自己加字段。
6. 如果用户的要求涉及违法、暴力、色情或其他敏感内容：reply 里给出礼貌的拒绝说明，actions 返回空数组。
7. 用户只是闲聊、打招呼、问你是谁时：reply 正常回应，actions 返回空数组。`

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: unknown, context?: unknown }>(event)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''

  if (!text) {
    throw createError({ statusCode: 400, statusMessage: 'text 不能为空' })
  }

  const context = (body?.context ?? {}) as Record<string, unknown>
  const traceId = Math.random().toString(36).slice(2, 8)

  /** 上次用过的画风：用来避免「随便」时反复给同一个 */
  const lastStyle = typeof context.lastStyle === 'string' ? context.lastStyle : ''
  /** 用户是不是说了"随便/你决定" */
  const casual = detectCasualIntent(text)

  try {
    const model = createModel()

    // 「随便」时先看图猜内容，把候选画风塞进用户消息（多花一次 llava，但比固定默认有诚意）
    const hint = casual ? await buildCasualHint(context, lastStyle) : ''

    let parsed: AgentResponse
    try {
      parsed = await ask(model, text, context, TEMPERATURE, hint)
    } catch (firstError) {
      // 解析失败（模型加了 markdown、少字段、JSON 截断…）就降温度重试一次
      console.warn(`[agent:${traceId}] 首次调用未通过校验，降温度重试：`, (firstError as Error).message)
      parsed = await ask(model, text, context, RETRY_TEMPERATURE, hint)
    }

    return { ...normalizeActions(parsed, casual, lastStyle), traceId }
  } catch (err) {
    // 最终兜底：答辩会问“模型挂了怎么办”，这里必须永远返回一个可用结构
    console.error(`[agent:${traceId}] 调用失败，切换到本地模板：`, err)

    return {
      reply: 'AI 暂时不可用，已切换本地模板。',
      actions: [],
      reasoning: [],
      fallback: true,
      traceId,
    }
  }
})

/**
 * 给「随便来一个」补上内容线索。
 *
 * 客户端只在识别到随便意图时才会把草图一起发上来（见 useAgent.send），
 * 所以这里拿不到图也不会额外耗时，直接退化成「提示模型换一个」。
 */
async function buildCasualHint(context: Record<string, unknown>, lastStyle: string) {
  const lines: string[] = []

  const sketch = typeof context.sketch === 'string' && context.sketch.startsWith('data:image')
    ? context.sketch
    : ''

  if (sketch) {
    const commaAt = sketch.indexOf(',')
    const bytes = Buffer.from(commaAt >= 0 ? sketch.slice(commaAt + 1) : sketch, 'base64')

    // 失败不抛：猜不出内容就只按「换一个」处理
    const vision = await extractVisualKeywords(bytes)

    if (!vision.error) {
      lines.push(`画面关键词（llava 识图）：${vision.keywords}`)

      const ranked = rankStylesByKeywords(STYLES, vision.keywords, 3)
      if (ranked.length) {
        lines.push(`候选画风（按画面匹配度）：${ranked.map(style => `${style.id}（${style.title}）`).join('、')}`)
      }
    }
    else {
      console.warn('[agent] 随便时看图失败，退化成随机挑选：', vision.error)
    }
  }

  const avoid = [DEFAULT_STYLE_ID, lastStyle].filter(Boolean)
  if (avoid.length) lines.push(`这次请避免使用：${avoid.join('、')}`)
  if (lastStyle) lines.push(`上次使用画风：${lastStyle}`)

  return lines.join('\n')
}

/**
 * 幻觉防护 + 「随便」去重：
 * - 不存在的 styleKey / 标题当 id → 纠成真实 id；
 * - 说了「随便」却仍用默认画风 → 换一个随机的，避免每次都一样。
 * 纠偏逻辑在 utils/styles.ts 里（可单测），这里只把说明并进 reasoning。
 */
function normalizeActions(parsed: AgentResponse, casual: boolean, lastStyle: string): AgentResponse {
  // 「随便」时兜底不再是固定第一条，而是排除默认与上次用过的随机一个
  const fallbackId = casual
    ? pickRandomStyle(STYLES, { avoid: [DEFAULT_STYLE_ID, lastStyle].filter(Boolean) }) || DEFAULT_STYLE_ID
    : DEFAULT_STYLE_ID

  const { actions, repairs } = normalizeStyleActions(parsed.actions, STYLES, {
    fallbackId,
    avoidDefault: casual,
  })

  return {
    ...parsed,
    actions,
    // 纠偏说明放在最前面：条数超限时宁可挤掉模型自己写的依据，也要让这条留下
    reasoning: [...repairs, ...parsed.reasoning].slice(0, MAX_REASONING),
  }
}

/** 建模型实例。API Key 只在 server/ 里读，前端代码永远拿不到它 */
function createModel() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('缺少环境变量 DEEPSEEK_API_KEY，请写进 frontend/.env')
  }

  const deepseek = createOpenAI({
    baseURL: DEEPSEEK_BASE_URL,
    apiKey,
    // 出错信息里显示成 deepseek 而不是 openai，排查时不容易看错
    name: 'deepseek',
  })

  // 必须用 .chat()：直接调用 provider 走的是 /responses，DeepSeek 那边支持情况不如 /chat/completions 稳
  return deepseek.chat(DEEPSEEK_MODEL)
}

/** 调一次模型，并把返回解析成校验过的结构化结果；任何一步不对都抛错，交给上层重试 */
async function ask(
  model: ReturnType<typeof createModel>,
  text: string,
  context: unknown,
  temperature: number,
  hint = '',
): Promise<AgentResponse> {
  const { text: raw } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(text, context, hint),
    temperature,
  })

  return agentResponseSchema.parse(extractJson(raw))
}

/** hint 是「随便」时补的内容线索（画面关键词 / 候选画风 / 上次用过的风格） */
function buildUserPrompt(text: string, context: unknown, hint = '') {
  // 草图体积很大，别原样塞进 prompt，只留一个标记告诉模型画布上有东西
  const safeContext = { ...(context as Record<string, unknown>) }
  if (typeof safeContext.sketch === 'string') safeContext.sketch = '[已附草图，见下方线索]'

  return `用户说：${text}

当前上下文（JSON）：
${JSON.stringify(safeContext ?? {})}${hint ? `\n\n${hint}` : ''}`
}

/**
 * 从模型输出里抠出 JSON 对象。
 * 模型偶尔会裹一层 ```json 或者前后加两句解释，所以先剥围栏、再取第一个 { 到最后一个 }。
 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? raw).trim()

  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('响应里找不到 JSON 对象')
  }

  return JSON.parse(body.slice(start, end + 1))
}
