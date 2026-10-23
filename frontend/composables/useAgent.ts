import { detectCasualIntent } from '~/utils/styles'
import type { StyleSuggestion } from '~/utils/styleSuggestions'
import { useTTS } from '~/composables/useTTS'

/** /api/agent 的响应，契约见 docs/api.md 第 1 节 */
export interface AgentReply {
  reply: string
  actions: { tool: string, args: Record<string, unknown> }[]
  reasoning?: string[]
  fallback?: boolean
  traceId?: string
}

/** /api/search-style 的响应，契约见 docs/api.md 第 4 节 */
interface SearchStyleResponse {
  results: StyleResult[]
}

/** /api/generate 的响应，契约见 docs/api.md 第 5 节 */
interface GenerateResponse {
  imageUrl: string
  costMs: number
  provider: string
  fallback?: boolean
  reason?: string
}

/** 每次最多带多少条历史消息上去，防止聊久了请求体无限增长 */
const MAX_HISTORY = 20

/** 解析出来的一条 SSE 消息 */
type StreamEvent =
  | { type: 'delta', text: string }
  | { type: 'done' }
  | { type: 'error', message: string }

export function useAgent() {
  const store = useAgentStore()
  const brush = useBrushStore()
  const gesture = useGestureStore()
  const { speak } = useTTS()

  /** 当前流式请求的中断句柄；再次提问或点“停止”都要用它 */
  let controller: AbortController | null = null

  /**
   * 收尾：把提示追加到已经生成的内容后面。
   * 已经有半段回答时不要把它冲掉，用户还想看那半段。
   */
  function finishWithNotice(accumulated: string, notice: string) {
    store.updateLastAssistant(accumulated ? `${accumulated}\n\n（${notice}）` : `（${notice}）`)
  }

  /** 按 docs/api.md 的契约组装上下文：AI 靠它判断画布上现在是什么情况 */
  function buildContext() {
    return {
      hasSketch: store.hasSketch,
      canvasSize: { w: 800, h: 600 },
      brushColor: brush.color,
      recentActions: store.lastActions.map(action => action.tool),
      // 上次用的画风：AI 用它避免「随便」时反复给同一个
      lastStyle: store.lastStyleKey || undefined,
    }
  }

  /** 让画布导出当前草图（白底 PNG dataURL）；画布还没挂载时返回 null */
  function exportSketch() {
    return store.sketchExporter?.() ?? null
  }

  /** 最近一条用户消息，某些 action 缺参数时拿它兜底 */
  function lastUserText() {
    for (let i = store.messages.length - 1; i >= 0; i--) {
      const message = store.messages[i]
      if (message?.role === 'user') return message.content
    }
    return ''
  }

  /**
   * 执行一个动作，返回一句给用户看的执行结果。
   * 每种工具都是独立的一小段，抛错由调用方兜住 —— 一个动作失败不影响后面的。
   */
  async function runAction(action: AgentAction): Promise<string> {
    const args = action.args ?? {}

    switch (action.tool) {
      case 'set_color': {
        const color = String(args.color ?? '').trim()
        if (!color) return '缺少 color 参数，跳过'
        brush.setColor(color)
        return `画笔颜色改成 ${color}`
      }

      case 'set_brush_size': {
        const size = Number(args.size)
        if (!Number.isFinite(size)) return '缺少 size 参数，跳过'
        brush.setSize(Math.min(50, Math.max(1, Math.round(size))))
        return `笔触粗细改成 ${brush.size}`
      }

      case 'clear': {
        // 走 store 计数器通知画布，和握拳清空是同一条通路
        gesture.requestClear()
        return '画布已清空'
      }

      case 'erase':
        return '橡皮擦还没实现（需要先做历史记录栈），这次跳过'

      case 'export': {
        const dataUrl = exportSketch()
        if (!dataUrl) return '导出失败：画布还没准备好'

        const format = args.format === 'jpg' ? 'jpg' : 'png'
        downloadDataUrl(dataUrl, `指尖绘迹-${Date.now()}.${format}`)
        return '作品已导出'
      }

      // P2-11 之后 Agent 不再下发 search_style（风格由模型直选 id）。
      // 这里保留它只服务两个内部入口：解读卡片的建议按钮、以及手动检索调试。
      case 'search_style': {
        const query = String(args.style ?? '').trim() || lastUserText()
        const k = Number(args.k) || 3

        const res = await $fetch<SearchStyleResponse>('/api/search-style', {
          method: 'POST',
          body: { query, k },
          timeout: 15000,
        })

        const results = res.results ?? []
        store.setStyleResults(results)

        const top = results[0]
        return top
          ? `检索到 ${results.length} 个风格，最匹配「${top.title}」（${top.score}）`
          : `没有匹配到与「${query}」相关的风格`
      }

      case 'generate_image': {
        // 换风格重绘会传 lastSketchBase64，复用生成当前作品的那张草图；
        // 普通入口没传时才现场导出（导出的图已经裁白边 + 二值化，适合模型识别）。
        const providedSketch = typeof args.sketchBase64 === 'string'
          && args.sketchBase64.startsWith('data:image')
          ? args.sketchBase64
          : ''
        const imageBase64 = providedSketch || exportSketch()
        if (!imageBase64) return '生成失败：画布还没准备好'

        // 所有生成入口共用同一把锁：👍、空闲提示气泡、风格库、Agent 动作。
        // 没有它，用户一边比 👍 一边点“好呀”会同时发两次请求，后回来的图会覆盖前一张。
        if (store.isGenerating) return '正在生成中，请稍候'

        const requested = String(args.styleKey ?? '').trim()
        // LLM/调用方给的 styleKey 可能是标题或编出来的 id；
        // 优先在检索结果里找真实条目，避免把不存在的 id 发给服务端。
        // 注意：requested 为空时不能查，否则 styleModifiers.includes('') 恒为 true，
        // 会把第一条风格（水墨）误当成“用户手动指定”，AI 推荐永远轮不到。
        const requestedMatch = requested
          ? store.styleResults.find(
            item => item.id === requested || item.title === requested || item.styleModifiers.includes(requested),
          )
          : undefined

        // 用户没有手动指定时，默认用 AI 看图后推荐的第一名；
        // 还没看过图（没有推荐）才退回上次风格/清单第一条。
        const aiTop = store.currentSuggestions[0]?.styleKey ?? ''
        const styleKey = requestedMatch?.id
          || requested
          || aiTop
          || store.lastStyleKey
          || store.styleResults[0]?.id
          || ''

        const matched = styleKey
          ? store.styleResults.find(
            item => item.id === styleKey || item.title === styleKey || item.styleModifiers.includes(styleKey),
          )
          : undefined

        store.setGenerating(true)

        try {
          const res = await $fetch<GenerateResponse>('/api/generate', {
            method: 'POST',
            body: {
              imageBase64,
              styleKey: matched?.id || styleKey,
              promptOverride: matched?.styleModifiers,
              strength: Number(args.strength) || 0.6,
            },
            // 服务端自己要轮询 30 秒，客户端给足余量
            timeout: 45000,
          })

          store.setGeneratedImage(res.imageUrl)
          store.setLastSketchBase64(imageBase64)
          // 记下这次用的画风：lastStyleKey 供「随便」避重，lastGeneratedStyleId 供结果页高亮
          if (styleKey) {
            const finalKey = matched?.id || styleKey
            store.setLastStyleKey(finalKey)
            store.setLastGeneratedStyleId(finalKey)
          }

          const label = matched?.title ? `「${matched.title}」` : ''
          return res.fallback
            ? `生成服务没成功（${res.reason ?? '未知原因'}），先用占位图顶上`
            : `生成完成${label}，用时 ${res.costMs} ms`
        }
        finally {
          store.setGenerating(false)
        }
      }

      case 'analyze_sketch': {
        const imageBase64 = typeof args.imageBase64 === 'string' && args.imageBase64.trim()
          ? args.imageBase64
          : exportSketch()

        if (!imageBase64) return '看图失败：画布还没准备好'
        const silent = Boolean(args.silent)

        // llava + DeepSeek 两级，最坏 20 秒左右，超时给足
        const res = await $fetch<{
          success: boolean
          data: {
            observation: string
            feeling: string
            invitation: string
            suggestions: string[]
            styleSuggestions?: StyleSuggestion[]
            degrade?: string
          }
        }>('/api/analyze-sketch', {
          method: 'POST',
          body: { imageBase64 },
          timeout: 90000,
        })

        if (!res.success || !res.data) return '看图失败：AI 没有返回解读结果'

        // 推荐直接进 store：之后 👍/空闲气泡不指定风格时，generate_image 会默认用第一条
        store.setCurrentSuggestions(res.data.styleSuggestions ?? [])

        const { observation, feeling, invitation, suggestions } = res.data

        // 猜画是陪孩子看的：把“感受 + 邀请”念出来，观察文字留在对话区慢慢看。
        // 语速稍慢、音调稍高，避免像导航播报。
        const spoken = [feeling, invitation]
          .map(part => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join('。')
        // 手势/空闲气泡只是借这次分析拿风格推荐，不要把整段解读念出来打断用户
        if (spoken && !silent) speak(spoken, { rate: 0.95, pitch: 1.06 })

        // 一句自然语言回给对话区；建议里第一个顺手做成风格检索，让用户能直接接下一步
        return `${observation}${feeling}想问问你：${invitation}`
          + (suggestions.length ? `（要不要试试「${suggestions.join('」「')}」？）` : '')
      }

      default:
        return `不认识的动作 ${action.tool}，跳过`
    }
  }

  /**
   * 串行执行一串动作。
   * 必须串行而不是并发：动作之间可能互相影响（先改颜色再生成，生成时用的是改后的画布状态）。
   */
  async function executeActions(actions: AgentAction[]) {
    if (!actions.length) return

    store.setExecuting(true)
    const lines: string[] = []

    try {
      for (const action of actions) {
        try {
          lines.push(`· ${action.tool}：${await runAction(action)}`)
        } catch (err) {
          // 单步失败只记一条，继续跑后面的，不要把整串中断
          console.error(`[agent] 执行 ${action.tool} 失败：`, err)
          lines.push(`· ${action.tool}：执行失败（${(err as Error)?.message ?? '未知错误'}）`)
        }
      }

      store.addMessage({ role: 'assistant', content: `动作执行结果：\n${lines.join('\n')}` })
    } finally {
      store.setExecuting(false)
    }
  }

  /**
   * 非流式入口：走 /api/agent，一次性拿到 reply + actions，然后串行执行 actions。
   * 结果全部写进 agentStore，界面直接读 store。
   */
  async function send(text: string) {
    const content = text.trim()
    if (!content || store.loading || store.streaming || store.executing) return

    store.addMessage({ role: 'user', content })
    store.setLoading(true)
    store.setFallback(false)

    try {
      // 「随便来一个」这类请求服务端要靠草图猜内容，所以只在命中随便意图时才附图，
      // 免得每次聊天都往请求里塞几百 KB
      const casual = detectCasualIntent(content)
      const context = buildContext() as Record<string, unknown>

      if (casual && store.hasSketch) {
        const sketch = exportSketch()
        if (sketch) context.sketch = sketch
      }

      const res = await $fetch<AgentReply>('/api/agent', {
        method: 'POST',
        body: { text: content, context },
        // 普通请求 5–15 秒；「随便」还要多跑一次 llava 看图，给到 60 秒
        timeout: casual ? 60000 : 30000,
      })

      store.addMessage({ role: 'assistant', content: res.reply })
      store.setReasoning(res.reasoning ?? [])
      store.setLastActions(res.actions ?? [])
      store.setFallback(res.fallback === true)

      if (res.actions?.length) {
        console.log('[agent] 模型返回的动作：', res.actions, 'traceId:', res.traceId)
      }

      // 模型答完了，接下来是执行动作：先摘掉 loading，再进 executing，
      // 否则界面会一直显示"思考中"，用户不知道是在等模型还是在跑动作
      store.setLoading(false)
      await executeActions(res.actions ?? [])
    } catch (err) {
      // 网络失败、超时、非 200 都在这里兜住，不要把原始异常丢到界面上
      const data = (err as { data?: { error?: string, statusMessage?: string, message?: string } })?.data
      store.addMessage({
        role: 'assistant',
        content: describeHttpError(httpStatus(err), data?.error || data?.statusMessage || data?.message),
      })
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

      // 服务端的错误也以 SSE 帧返回（状态码照实给），所以只要响应体是 event-stream 就照常读流。
      // 只有响应根本不是 SSE 时（进程崩了、反代返回了 HTML 错误页）才退回按状态码翻译。
      const isStream = response.headers.get('content-type')?.includes('text/event-stream') === true

      if (!response.body || (!response.ok && !isStream)) {
        finishWithNotice(accumulated, describeHttpError(response.status, await readErrorDetail(response)))
        return
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
          const event = parseEvent(chunk)
          if (!event) continue

          if (event.type === 'error') {
            // 上游的错误原文只写日志，界面给人话
            console.error('[agent] 服务端返回错误：', event.message)
            finishWithNotice(accumulated, describeStreamError(event.message))
            return
          }

          if (event.type === 'done') return

          accumulated += event.text
          store.updateLastAssistant(accumulated)
        }
      }

      // 流结束了却一个字都没收到（比如连接被中途掐断），给个交代，别留个空气泡
      if (!accumulated) finishWithNotice('', '没有收到内容，请重试。')
    } catch (err) {
      // 主动 abort 会抛 AbortError，这是正常操作，不当错误处理
      if (!isAbortError(err)) {
        console.error('[agent] 流式请求失败：', err)
        finishWithNotice(accumulated, '连接中断，请重试。')
      }
    } finally {
      // 只有自己还是「当前那次请求」时才收尾，避免把新请求的状态改掉
      if (controller === current) {
        controller = null
        store.setStreaming(false)
      }
    }
  }

  return { send, chatStream, stop, runAction, executeActions, exportSketch, buildContext }
}

/** 把 dataURL 存成文件（只在浏览器里调用） */
function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  link.click()
}

/**
 * 解析一条 SSE 消息。
 * @returns 解析结果；null 表示这条不用管（空行、注释、半条 JSON）
 */
function parseEvent(raw: string): StreamEvent | null {
  const line = raw.split('\n').find(item => item.startsWith('data:'))
  if (!line) return null

  const payload = line.slice(5).trim()
  if (!payload) return null
  if (payload === '[DONE]') return { type: 'done' }

  try {
    const data = JSON.parse(payload) as { delta?: string, done?: boolean, error?: string }
    if (data.error) return { type: 'error', message: data.error }
    if (data.done) return { type: 'done' }
    if (typeof data.delta === 'string') return { type: 'delta', text: data.delta }
    return null
  } catch {
    // 半条 JSON（理论上缓冲区已经挡住了，这里只是兜底），忽略掉
    return null
  }
}

/** 响应不是 SSE 时，尽量把它带的错误信息抠出来 */
async function readErrorDetail(response: Response) {
  try {
    const data = await response.json() as { error?: string, statusMessage?: string, message?: string }
    return data?.error || data?.statusMessage || data?.message || ''
  } catch {
    return ''
  }
}

/** $fetch 抛出来的错误里取状态码 */
function httpStatus(err: unknown) {
  const e = err as { statusCode?: number, status?: number, response?: { status?: number } }
  return e?.statusCode ?? e?.status ?? e?.response?.status
}

/**
 * 按状态码翻译成人话。
 * 能走到这里的都是「响应体不是 SSE」的情况：多半是框架层报的（JSON 体不合法、进程崩了、
 * 反代返回了 HTML 错误页），那些 message 是英文技术文本，不适合直接给用户看，
 * 所以只写日志，界面统一给中文提示。
 */
function describeHttpError(status: number | undefined, detail?: string) {
  if (detail) console.warn('[agent] 上游错误详情：', detail)

  if (status === 400) return '这个请求不合法，换个说法再试试。'
  if (status === 401 || status === 403) return 'AI 服务没有授权，检查一下 DEEPSEEK_API_KEY 配置。'
  if (status === 413) return '消息太长了，删掉几条再试。'
  if (status === 429) return '今天的额度用完了，稍后再试。'
  if (status === 503) return '服务繁忙，已降级。'

  return 'AI 暂时不可用，已切换本地模板。'
}

/** 流式过程中从 data:{error} 帧里拿到的原因，翻译成人话 */
function describeStreamError(message: string) {
  if (message.includes('DEEPSEEK_API_KEY')) return '服务端还没配密钥，先把 frontend/.env 放好。'
  if (/401|unauthor/i.test(message)) return 'AI 服务没有授权，检查一下 DEEPSEEK_API_KEY。'
  if (/429|rate.?limit/i.test(message)) return '今天的额度用完了，稍后再试。'
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return '上游超时了，重试一次试试。'
  return '生成中断，请重试。'
}

function isAbortError(err: unknown) {
  return (err as { name?: string })?.name === 'AbortError'
}
