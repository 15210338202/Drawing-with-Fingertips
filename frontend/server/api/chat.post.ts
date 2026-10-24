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

const SYSTEM_PROMPT = `你叫「小绘」，是「隔空绘画」应用的创作助手。用户正用手指在空中画画。你自称“小绘”，不要自称“小惠”或其他名字。

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

  const apiKey = process.env.DEEPSEEK_API_KEY

  // 两个前置校验先判出来，因为状态码必须在 flushHeaders() 之前定下来
  const invalidRequest = messages.length === 0
  const missingKey = !apiKey

  const res = event.node.res

  // 统一用 SSE 回答，**连错误也是**：响应体永远是一条条 data: 帧。
  // 这样前端只需要一条解析路径；状态码照实给，方便日志和监控区分「客户端传错」和「服务端没配好」。
  setResponseStatus(event, invalidRequest ? 400 : missingKey ? 500 : 200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 告诉 Nginx 之类的反代别缓冲，否则前端要等整段生成完才一次性收到，就不是流式了
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  if (invalidRequest) {
    writeEvent(res, { error: '请求里没有有效的 messages' })
    res.end()
    return
  }

  if (missingKey) {
    writeEvent(res, { error: '服务端没有配置 DEEPSEEK_API_KEY，请写进 frontend/.env' })
    res.end()
    return
  }

  // 客户端断开（关页面、点停止）时立刻中止生成，不然模型还在白烧 token。
  // 注意：StreamTextResult 上没有 abort() 方法，取消要靠传进去的 abortSignal ——
  // 很多示例里写的 result.abort() 在这个版本是没有的，写了也不报错（可选调用），但根本不生效。
  const abortController = new AbortController()
  event.node.req.on('close', () => abortController.abort())

  const deepseek = createOpenAI({ baseURL: DEEPSEEK_BASE_URL, apiKey, name: 'deepseek' })

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
    // 用户主动点「停止」时会走到这里，那不是错误，什么都不用发
    if (!abortController.signal.aborted) {
      console.error('[chat] 生成失败：', err)
      writeEvent(res, { error: (err as Error)?.message ?? String(err) })
    }
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
