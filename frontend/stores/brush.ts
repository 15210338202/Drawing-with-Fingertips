import { defineStore } from 'pinia'

export const useBrushStore = defineStore('brush', {
  state: () => ({
    color: '#1F4E79',
    size: 5,
  }),
  actions: {
    setColor(color: string) {
      this.color = color
    },
    setSize(size: number) {
      this.size = size
    },
  },
})