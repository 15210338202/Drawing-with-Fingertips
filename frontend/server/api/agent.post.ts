import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { AGENT_TOOLS_PROMPT, TOOL_NAMES } from '../../utils/tools'

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

  const context = body?.context ?? {}
  const traceId = Math.random().toString(36).slice(2, 8)

  try {
    const model = createModel()

    let parsed: AgentResponse
    try {
      parsed = await ask(model, text, context, TEMPERATURE)
    } catch (firstError) {
      // 解析失败（模型加了 markdown、少字段、JSON 截断…）就降温度重试一次
      console.warn(`[agent:${traceId}] 首次调用未通过校验，降温度重试：`, (firstError as Error).message)
      parsed = await ask(model, text, context, RETRY_TEMPERATURE)
    }

    return { ...parsed, traceId }
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
): Promise<AgentResponse> {
  const { text: raw } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(text, context),
    temperature,
  })

  return agentResponseSchema.parse(extractJson(raw))
}

function buildUserPrompt(text: string, context: unknown) {
  return `用户说：${text}

当前上下文（JSON）：
${JSON.stringify(context ?? {})}`
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
