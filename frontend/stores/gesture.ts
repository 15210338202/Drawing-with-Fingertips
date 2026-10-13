import { defineStore } from 'pinia'

export const useGestureStore = defineStore('gesture', {
  state: () => ({
    state: 'idle' as 'idle' | 'drawing',
    lastPoint: null as { x: number; y: number } | null,
  }),
  actions: {
    setState(s: 'idle' | 'drawing') {
      this.state = s
    },
    setLastPoint(p: { x: number; y: number } | null) {
      this.lastPoint = p
    },
  },
})