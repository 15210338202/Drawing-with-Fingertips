/** /api/agent 的响应，契约见 docs/api.md 第 1 节 */
export interface AgentReply {
  reply: string
  actions: { tool: string, args: Record<string, unknown> }[]
  reasoning?: string[]
  fallback?: boolean
  traceId?: string
}

export function useAgent() {
  const store = useAgentStore()
  const brush = useBrushStore()

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
   * 发一条消息给 AI。
   * 不返回结果，全部写进 agentStore，界面直接读 store。
   */
  async function send(text: string) {
    const content = text.trim()
    if (!content || store.loading) return

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

      // 真正执行动作是明天的任务，今天先看一眼模型返回了什么
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

  return { send, buildContext }
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
