import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import type { ServerResponse } from 'node:http'

/**
 * 和 server/api/agent.post.ts 用同一套 DeepSeek 配置。
 * DeepSeek 是 OpenAI 兼容接口，复用已有的 @ai-sdk/openai 就够了，不用再装 @ai-sdk/deepseek。
 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** V4.1-Flash 的规范 model id；deepseek-v4-flash 是旧别名，指向的是同一个模型 */
const DEEPSEEK_MODEL = 'deepseek-flash'

const SYSTEM_PROMPT = `你是「隔空绘画」应用的创作助手。用户正用手指在空中画画。

要求：
1. 说中文，口语化，每次回答控制在 3 句话以内，别写长篇大论。
2. 不要输出 JSON，不要写 markdown 代码块，像聊天一样自然说话。
3. 你可以帮他改颜色、调笔刷粗细、擦除、清空画布、导出作品、按风格生成图片，
   这些由另一个接口完成，用自然语言邀请他试试就行。`

/** 只接受这两种角色：system 由服务端自己加，不让客户端传 */
interface ClientMessage {
  role: 'user' | 'assistant'
  content: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: unknown }>(event)

  const messages = (Array.isArray(body?.messages) ? body.messages : [])
    .filter(
      (m): m is ClientMessage =>
        !!m
        && typeof (m as ClientMessage).content === 'string'
        && !!(m as ClientMessage).content.trim()
        && ((m as ClientMessage).role === 'user' || (m as ClientMessage).role === 'assistant'),
    )
    .map(m => ({ role: m.role, content: m.content.trim() }))

  if (!messages.length) {
    throw createError({ statusCode: 400, statusMessage: 'messages 不能为空' })
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: '缺少环境变量 DEEPSEEK_API_KEY（放在 frontend/.env）' })
  }

  const res = event.node.res

  // 我们要手动把 token 一段段写出去，这几个 SSE 响应头必须自己设
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 告诉 Nginx 之类的反代别缓冲，否则前端要等整段生成完才一次性收到，就不是流式了
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const deepseek = createOpenAI({ baseURL: DEEPSEEK_BASE_URL, apiKey, name: 'deepseek' })

  // 客户端断开（关页面、点停止）时立刻中止生成，不然模型还在白烧 token。
  // 注意：StreamTextResult 上没有 abort() 方法，取消要靠传进去的 abortSignal ——
  // 很多示例里写的 result.abort() 在这个版本是没有的，写了也不会报错（可选调用），但根本不生效。
  const abortController = new AbortController()
  event.node.req.on('close', () => abortController.abort())

  const result = streamText({
    model: deepseek.chat(DEEPSEEK_MODEL),
    system: SYSTEM_PROMPT,
    messages,
    abortSignal: abortController.signal,
  })

  try {
    // textStream 是异步迭代器：每拿到一小段就立刻推给前端，不要等它结束
    for await (const delta of result.textStream) {
      writeEvent(res, { delta })
    }
    writeEvent(res, { done: true })
  } catch (err) {
    // 客户端主动 abort 也会走到这里，这时连接已经断了，writeEvent 内部会跳过
    writeEvent(res, { error: (err as Error)?.message ?? String(err) })
  } finally {
    if (!res.writableEnded) res.end()
  }
})

/**
 * 写一条 SSE 消息。
 * 结尾必须是两个换行 —— 这是 SSE 的消息分隔符，少一个前端就切不出完整消息。
 */
function writeEvent(res: ServerResponse, payload: unknown) {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
