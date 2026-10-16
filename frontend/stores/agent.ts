import { defineStore } from 'pinia'

/** 模型返回的一个动作 */
export interface AgentAction {
  tool: string
  args: Record<string, unknown>
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

/** RAG 检索回来的一条风格（契约见 docs/api.md 第 4 节） */
export interface StyleResult {
  id: string
  title: string
  prompt: string
  source: string
  score: number
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    messages: [] as AgentMessage[],
    loading: false,
    /**
     * 正在流式接收回答。
     * 和 loading 的区别：loading 是「等 /api/agent 一次性返回」，streaming 是「/api/chat 正在一段段吐字」。
     */
    streaming: false,
    /** 正在执行模型返回的 actions（串行调用多个接口，可能好几秒） */
    executing: false,
    /** AI 的判断依据，界面上作为“思考可视化”展示 */
    reasoning: [] as string[],
    /** 上一次返回的动作列表 */
    lastActions: [] as AgentAction[],
    /** 上游降级过，界面上给个提示 */
    fallback: false,

    /** RAG 检索结果，StyleGallery 读它渲染卡片 */
    styleResults: [] as StyleResult[],
    /** 生成好的图片 URL（服务端失败时是内联占位图），DrawingCanvas 读它显示 */
    generatedImage: null as string | null,

    /**
     * 画布上有没有内容，作为 /api/agent 的 context.hasSketch 传上去。
     * DrawingCanvas 落笔时置 true、清空时置 false —— 让 AI 知道是空画布还是已经有草图。
     */
    hasSketch: false,

    /**
     * 画布导出的桥。
     * useAgent 在 AgentPanel 里调用，拿不到 DrawingCanvas 的模板 ref，
     * 所以由画布在挂载时把自己的 exportSketch 挂上来（函数不是响应式对象，Pinia 不会包装它）。
     */
    sketchExporter: null as null | (() => string | null),
  }),
  actions: {
    addMessage(m: AgentMessage) {
      this.messages.push(m)
    },
    setLoading(v: boolean) {
      this.loading = v
    },
    setStreaming(v: boolean) {
      this.streaming = v
    },
    setExecuting(v: boolean) {
      this.executing = v
    },
    setReasoning(arr: string[]) {
      this.reasoning = arr
    },
    setLastActions(arr: AgentAction[]) {
      this.lastActions = arr
    },
    setFallback(v: boolean) {
      this.fallback = v
    },
    setHasSketch(v: boolean) {
      this.hasSketch = v
    },
    setStyleResults(arr: StyleResult[]) {
      this.styleResults = arr
    },
    setGeneratedImage(url: string | null) {
      this.generatedImage = url
    },
    setSketchExporter(fn: null | (() => string | null)) {
      this.sketchExporter = fn
    },

    /**
     * 流式过程中刷新最后一条 assistant 消息。
     * 注意传进来的是**完整文本**，不是增量 —— 所以这里是替换而不是追加。
     * 每次 push 一条新消息的话消息列表会瞬间爆掉。
     */
    updateLastAssistant(content: string) {
      const last = this.messages[this.messages.length - 1]
      if (last && last.role === 'assistant') {
        last.content = content
      }
    },

    /** 中断流式回答：停掉状态，并给还没吐出任何字的占位消息一个交代 */
    abortStream() {
      this.streaming = false

      const last = this.messages[this.messages.length - 1]
      if (last && last.role === 'assistant' && !last.content) {
        last.content = '（已停止）'
      }
    },

    reset() {
      this.messages = []
      this.loading = false
      this.streaming = false
      this.executing = false
      this.reasoning = []
      this.lastActions = []
      this.fallback = false
      this.styleResults = []
      this.generatedImage = null
    },
  },
})
