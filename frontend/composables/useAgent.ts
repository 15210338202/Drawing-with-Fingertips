/** /api/agent 的响应，契约见 docs/api.md 第 1 节 */
export interface AgentReply {
  reply: string
  actions: { tool: string, args: Record<string, unknown> }[]
  reasoning?: string[]
  fallback?: boolean
  traceId?: string
}

/** 每次最多带多少条历史消息上去，防止聊久了请求体无限增长 */
const MAX_HISTORY = 20

export function useAgent() {
  const store = useAgentStore()
  const brush = useBrushStore()

  /** 当前流式请求的中断句柄；再次提问或点“停止”都要用它 */
  let controller: AbortController | null = null

  /** 按 docs/api.md 的契约组装上下文：AI 靠它判断画布上现在是什么情况 */
  function buildContext() {
    return {
      hasSketch: store.hasSketch,
      canvasSize: { w: 800, h: 600 },
      brushColor: brush.color,
      recentActions: store.lastActions.map(action => action.tool),
    }
  }

  /**
   * 非流式入口：走 /api/agent，一次性拿到 reply + actions + reasoning。
   * 结果全部写进 agentStore，界面直接读 store。
   */
  async function send(text: string) {
    const content = text.trim()
    if (!content || store.loading || store.streaming) return

    store.addMessage({ role: 'user', content })
    store.setLoading(true)
    store.setFallback(false)

    try {
      const res = await $fetch<AgentReply>('/api/agent', {
        method: 'POST',
        body: { text: content, context: buildContext() },
        // LLM 一次要 5–15 秒，默认超时太短会误判成网络失败
        timeout: 30000,
      })

      store.addMessage({ role: 'assistant', content: res.reply })
      store.setReasoning(res.reasoning ?? [])
      store.setLastActions(res.actions ?? [])
      store.setFallback(res.fallback === true)

      // 真正执行动作是后面的任务，现在先看一眼模型返回了什么
      if (res.actions?.length) {
        console.log('[agent] 模型返回的动作：', res.actions, 'traceId:', res.traceId)
      }
    } catch (err) {
      // 网络失败、超时、非 200 都在这里兜住，不要把原始异常丢到界面上
      store.addMessage({ role: 'assistant', content: describeAgentError(err) })
      store.setReasoning([])
      store.setLastActions([])
      store.setFallback(true)
    } finally {
      store.setLoading(false)
    }
  }

  /** 中断正在进行的流式回答 */
  function stop() {
    controller?.abort()
    controller = null
    store.abortStream()
  }

  /**
   * 流式入口：走 /api/chat，边生成边显示。
   * 必须用原生 fetch —— $fetch 会等整个响应体结束才返回，拿不到中间过程。
   */
  async function chatStream(text: string) {
    const content = text.trim()
    if (!content) return

    // 上一段还没答完就先掐掉，否则两段回答会混在一起
    stop()

    store.addMessage({ role: 'user', content })

    // 先组装要发上去的消息：此刻占位消息还没加，天然不会把空 assistant 发出去
    const messages = store.messages
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }))

    // 再放一条空的 assistant 占位，delta 到了不断替换它
    store.addMessage({ role: 'assistant', content: '' })
    store.setStreaming(true)

    const current = new AbortController()
    controller = current

    let accumulated = ''

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: current.signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // stream: true 不能省：一个汉字的 UTF-8 占 3 字节，正好被 chunk 切开时不带这个参数会解出乱码
        buffer += decoder.decode(value, { stream: true })

        // 一次 read 拿到的 chunk 可能在某条消息中间断开，
        // 所以按 \n\n 切开后，最后一段要留回缓冲区等下一个 chunk
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''

        for (const chunk of chunks) {
          const delta = parseEvent(chunk)
          if (delta === null) continue
          if (delta === DONE) return

          accumulated += delta
          store.updateLastAssistant(accumulated)
        }
      }
    } catch (err) {
      // 主动 abort 会抛 AbortError，这是正常操作，不当错误处理
      if (!isAbortError(err)) {
        console.error('[agent] 流式请求失败：', err)
        store.updateLastAssistant(accumulated || '（连接中断，请重试）')
      }
    } finally {
      // 只有自己还是「当前那次请求」时才收尾，避免把新请求的状态改掉
      if (controller === current) {
        controller = null
        store.setStreaming(false)
      }
    }
  }

  return { send, chatStream, stop, buildContext }
}

/** parseEvent 用它表示「这条消息说流结束了」 */
const DONE = Symbol('done')

/**
 * 解析一条 SSE 消息。
 * @returns 文本增量；null 表示这条不用管；DONE 表示流已结束
 */
function parseEvent(raw: string): string | typeof DONE | null {
  const line = raw.split('\n').find(item => item.startsWith('data:'))
  if (!line) return null

  const payload = line.slice(5).trim()
  if (!payload) return null
  if (payload === '[DONE]') return DONE

  try {
    const data = JSON.parse(payload) as { delta?: string, done?: boolean, error?: string }
    if (data.error) {
      console.error('[agent] 服务端返回错误：', data.error)
      return DONE
    }
    if (data.done) return DONE
    return typeof data.delta === 'string' ? data.delta : null
  } catch {
    // 半条 JSON（理论上缓冲区已经挡住了，这里只是兜底），忽略掉
    return null
  }
}

function isAbortError(err: unknown) {
  return (err as { name?: string })?.name === 'AbortError'
}

/** $fetch 抛出来的错误给用户看之前先翻译一下 */
function describeAgentError(err: unknown) {
  const status = (err as { statusCode?: number, status?: number })?.statusCode
    ?? (err as { status?: number })?.status

  if (status === 400) return '这个请求不合法，换个说法再试试。'
  if (status === 401) return 'AI 服务没有授权，检查一下 DEEPSEEK_API_KEY 配置。'
  if (status === 429) return '今天的额度用完了，已切换本地模板。'
  if (status === 503) return '服务繁忙，已降级。'

  return 'AI 暂时不可用，已切换本地模板。'
}
