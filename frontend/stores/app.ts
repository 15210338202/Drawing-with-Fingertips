import { defineStore } from 'pinia'

const SENSORY_STORAGE_KEY = 'sensory'
const AUTO_START_CAMERA_KEY = 'autoStartCamera'
const AUTO_CAMERA_ENTERED_KEY = 'autoCameraEntered'

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
    /**
     * 行动不便时的 opt-in：浏览器已授权摄像头时，从欢迎页直接进入画室并开摄像头。
     * 这不是静默授权；首次仍必须由用户允许浏览器权限。
     */
    autoStartCamera: false,
    autoStartCameraLoaded: false,
    /**
     * 只存在内存里的一次性交接标记。
     * 欢迎页确认权限后置 true，CameraPreview 挂载时消费并启动摄像头。
     */
    autoCameraRequested: false,
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

    initAutoStartCamera() {
      if (this.autoStartCameraLoaded || typeof window === 'undefined') return

      try {
        this.autoStartCamera = window.localStorage.getItem(AUTO_START_CAMERA_KEY) === 'true'
      }
      catch {
        // 隐私模式/禁用存储时保持默认关闭
      }

      this.autoStartCameraLoaded = true
    },

    setAutoStartCamera(value: boolean) {
      this.autoStartCamera = value

      if (typeof window === 'undefined') return
      try {
        window.localStorage.setItem(AUTO_START_CAMERA_KEY, String(value))
        // 重新打开这个开关时，允许下一次进入欢迎页再自动进一次
        if (value) window.sessionStorage.removeItem(AUTO_CAMERA_ENTERED_KEY)
      }
      catch {
        // 存不下就只对当前会话生效
      }
    },

    requestAutoCamera() {
      this.autoCameraRequested = true
    },

    /** 一次性消费；CameraPreview 挂载时调用，避免每次路由切换重复开摄像头 */
    consumeAutoCameraRequest(): boolean {
      if (!this.autoCameraRequested) return false
      this.autoCameraRequested = false
      return true
    },
  },
})
