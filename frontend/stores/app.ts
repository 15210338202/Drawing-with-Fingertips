import { defineStore } from 'pinia'

const SENSORY_STORAGE_KEY = 'sensory'

/**
 * 应用级偏好。
 *
 * 注意不要把 localStorage 直接写在 state() 里：
 * SSR 渲染时没有 localStorage，服务端会先输出 false；如果客户端初始 state 直接读成 true，
 * Vue 会报 hydration mismatch。这里保持两端初始值一致，由 app.vue 在 onMounted 后补齐。
 */
export const useAppStore = defineStore('app', {
  state: () => ({
    /** 感官友好模式：更低的刺激、更慢的语速 */
    isSensoryFriendly: false,
    /** 是否已经读过本地偏好；避免重复初始化，也方便调试 */
    sensoryPreferenceLoaded: false,
  }),
  actions: {
    /** 只在客户端调用；读到非法值/存储被禁用时安静地保持默认关闭 */
    initSensoryMode() {
      if (this.sensoryPreferenceLoaded || typeof window === 'undefined') return

      try {
        this.isSensoryFriendly = window.localStorage.getItem(SENSORY_STORAGE_KEY) === 'true'
      }
      catch {
        // 隐私模式/禁用存储时不要影响主流程
      }

      this.sensoryPreferenceLoaded = true
    },

    setSensoryMode(value: boolean) {
      this.isSensoryFriendly = value

      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(SENSORY_STORAGE_KEY, String(value))
      }
      catch {
        // 存不下就只对当前会话生效
      }
    },

    toggleSensoryMode() {
      this.setSensoryMode(!this.isSensoryFriendly)
    },
  },
})
