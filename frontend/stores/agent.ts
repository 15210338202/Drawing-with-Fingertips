import { defineStore } from 'pinia'

/** 模型返回的一个动作，明天才真正执行 */
export interface AgentAction {
  tool: string
  args: Record<string, unknown>
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    messages: [] as AgentMessage[],
    loading: false,
    /** AI 的判断依据，界面上作为“思考可视化”展示 */
    reasoning: [] as string[],
    /** 上一次返回的动作列表 */
    lastActions: [] as AgentAction[],
    /** 上游降级过，界面上给个提示 */
    fallback: false,

    /**
     * 画布上有没有内容，作为 /api/agent 的 context.hasSketch 传上去。
     * DrawingCanvas 落笔时置 true、清空时置 false —— 让 AI 知道是空画布还是已经有草图。
     */
    hasSketch: false,
  }),
  actions: {
    addMessage(m: AgentMessage) {
      this.messages.push(m)
    },
    setLoading(v: boolean) {
      this.loading = v
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
    reset() {
      this.messages = []
      this.loading = false
      this.reasoning = []
      this.lastActions = []
      this.fallback = false
    },
  },
})
