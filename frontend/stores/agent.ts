import { defineStore } from 'pinia'
import type { StyleSuggestion } from '~/utils/styleSuggestions'

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
  /** 纯画风描述（= styleModifiers，留作展示与 promptOverride） */
  prompt: string
  /** 纯画风/材质，不含具体物体 */
  styleModifiers: string
  /** 内容兜底，仅文生图模型用 */
  contentHints: string
  source: string
  score: number
}

/** CameraPreview 挂载时注册的桥；Agent 的 open_camera 拿不到模板 ref */
export interface CameraController {
  start: () => Promise<unknown>
  stop: () => void
  isActive: () => boolean
}

/** 两个“确认生成”入口：竖大拇指、10 秒空闲邀请 */
export type GenerationTrigger = 'thumbs-up' | 'idle-suggestion'

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
     * 上一次生成用的画风 id。
     * 传进 /api/agent 的 context，让模型在「随便来一个」时避开重复选择。
     */
    lastStyleKey: '',

    /** 上一次生成实际使用的画风，结果 Sheet 用它高亮推荐理由 */
    lastGeneratedStyleId: '',

    /** AI 看图后返回的 Top 3 风格；没有手动指定时，生成默认用第一条 */
    currentSuggestions: [] as StyleSuggestion[],

    /**
     * 当前作品生成时用的草图 data URL。
     * 结果 Sheet 换风格重绘必须复用同一张草图，不能重新导出（用户可能已经继续画了）。
     */
    lastSketchBase64: null as string | null,

    /**
     * 画布上有没有内容，作为 /api/agent 的 context.hasSketch 传上去。
     * DrawingCanvas 落笔时置 true、清空时置 false —— 让 AI 知道是空画布还是已经有草图。
     */
    hasSketch: false,

    /**
     * 最后一次落笔/落墨的时间（毫秒时间戳）。
     * 首页/画布用它做“10 秒没有新笔画”的空闲提示；0 表示当前没有笔迹。
     */
    lastStrokeTime: 0,

    /**
     * 是否正在生图。
     * runAction('generate_image') 会把它置 true；所有生成入口（👍、建议气泡、风格库、
     * Agent 动作）共用这个锁，避免同一张画并发生成。
     */
    isGenerating: false,

    /**
     * 谁先认领了这次“确认生成”。
     * 竖大拇指和 10 秒空闲邀请都可能在准备阶段等待 AI 分析，
     * 在真正进入 generate_image 之前用一个共享锁占位，避免两边同时开始。
     */
    generationTrigger: null as GenerationTrigger | null,

    /**
     * 画布导出的桥。
     * useAgent 在 AgentPanel 里调用，拿不到 DrawingCanvas 的模板 ref，
     * 所以由画布在挂载时把自己的 exportSketch 挂上来（函数不是响应式对象，Pinia 不会包装它）。
     */
    sketchExporter: null as null | (() => string | null),

    /**
     * 画布撤销的桥。
     * Agent 的 undo 工具在 useAgent 里执行，拿不到 DrawingCanvas 的模板 ref；
     * 由画布挂载时把 undo 挂上来，返回是否真的撤销了一步。
     */
    undoHandler: null as null | (() => boolean),

    /**
     * 故事卡保存的桥。
     * Agent 的 save_story_card 工具同样拿不到 DrawingCanvas 的模板 ref，
     * 由画布挂载时把自己的 saveStoryCard 挂上来。
     */
    storyCardSaver: null as null | (() => Promise<boolean>),

    /**
     * 摄像头控制桥。
     * 语音/文字 Agent 运行在 useAgent 里，拿不到 CameraDock 里 CameraPreview 的 ref；
     * 由 CameraPreview 挂载时注册，open_camera 通过它启动摄像头。
     */
    cameraController: null as CameraController | null,

    /**
     * 是否正在等用户确认“清空画布”。
     * 清空是不可逆动作，语音/文本入口都先问一句；确认后才真正清。
     */
    pendingClear: false,
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
      if (!v) {
        this.lastStrokeTime = 0
        // 画布清空后，上一张画的风格推荐不再有效，避免新手势继续沿用旧推荐
        this.currentSuggestions = []
        this.pendingClear = false
      }
      else {
        // 用户重新落笔后，之前那句“确定要清空吗”已经过期，避免下一次
        // 再说“清空”时被当成确认、直接清掉新画。
        this.pendingClear = false
      }
    },
    /**
     * 记录一次新的落墨。
     * 不只置 hasSketch：空闲提示靠 lastStrokeTime 判断“用户是不是还在画”，
     * 所以每一段笔迹都要刷新时间戳，不能只在起笔时记一次。
     */
    markStroke() {
      this.hasSketch = true
      this.pendingClear = false
      this.lastStrokeTime = Date.now()
    },
    setLastStrokeTime(v: number) {
      this.lastStrokeTime = v
    },
    setGenerating(v: boolean) {
      this.isGenerating = v
    },
    /**
     * 先到先得地认领一次生成。
     * 返回 false 表示另一个入口已经在准备或正在生成，调用方必须直接退出。
     */
    claimGeneration(source: GenerationTrigger): boolean {
      if (this.generationTrigger || this.isGenerating) return false
      this.generationTrigger = source
      return true
    },
    /** 只释放自己持有的锁，避免把另一个入口的锁误清掉 */
    releaseGeneration(source: GenerationTrigger) {
      if (this.generationTrigger === source) this.generationTrigger = null
    },
    setStyleResults(arr: StyleResult[]) {
      this.styleResults = arr
    },
    setGeneratedImage(url: string | null) {
      this.generatedImage = url
    },
    /** 记录上一次生成用的画风，供「随便来一个」避重 */
    setLastStyleKey(id: string) {
      this.lastStyleKey = id
    },
    setLastGeneratedStyleId(id: string) {
      this.lastGeneratedStyleId = id
    },
    setCurrentSuggestions(list: StyleSuggestion[]) {
      this.currentSuggestions = list
    },
    setLastSketchBase64(dataUrl: string | null) {
      this.lastSketchBase64 = dataUrl
    },
    setSketchExporter(fn: null | (() => string | null)) {
      this.sketchExporter = fn
    },
    setUndoHandler(fn: null | (() => boolean)) {
      this.undoHandler = fn
    },
    requestUndo(): boolean {
      return this.undoHandler?.() ?? false
    },
    setStoryCardSaver(fn: null | (() => Promise<boolean>)) {
      this.storyCardSaver = fn
    },
    setCameraController(controller: CameraController | null) {
      this.cameraController = controller
    },
    async requestOpenCamera(): Promise<'opened' | 'already' | 'missing' | 'failed'> {
      if (!this.cameraController) return 'missing'
      if (this.cameraController.isActive()) return 'already'

      try {
        await this.cameraController.start()
      }
      catch {
        return 'failed'
      }

      return this.cameraController?.isActive() ? 'opened' : 'failed'
    },
    requestCloseCamera(): 'closed' | 'already' | 'missing' | 'failed' {
      if (!this.cameraController) return 'missing'
      if (!this.cameraController.isActive()) return 'already'

      try {
        this.cameraController.stop()
      }
      catch {
        return 'failed'
      }

      return this.cameraController.isActive() ? 'failed' : 'closed'
    },
    setPendingClear(v: boolean) {
      this.pendingClear = v
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
      this.lastStyleKey = ''
      this.lastGeneratedStyleId = ''
      this.currentSuggestions = []
      this.lastSketchBase64 = null
      this.lastStrokeTime = 0
      this.isGenerating = false
      this.generationTrigger = null
      this.pendingClear = false
    },
  },
})
