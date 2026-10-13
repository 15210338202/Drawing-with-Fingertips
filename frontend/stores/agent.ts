import { defineStore } from 'pinia'

export const useAgentStore = defineStore('agent', {
  state: () => ({
    messages: [] as { role: 'user' | 'assistant'; content: string }[],
    loading: false,
  }),
  actions: {
    addMessage(m: { role: 'user' | 'assistant'; content: string }) {
      this.messages.push(m)
    },
    setLoading(v: boolean) {
      this.loading = v
    },
  },
})