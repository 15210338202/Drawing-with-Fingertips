import { defineStore } from 'pinia'
import type { Matrix3x3 } from '~/utils/homography'
import { isMatrix3x3 } from '~/utils/homography'

/** localStorage 的键：改名字等于让所有人的标定失效，别随便动 */
const STORAGE_KEY = 'fingertip.calibration.homography'

export const useCalibrationStore = defineStore('calibration', {
  state: () => ({
    /** 透视校正矩阵；null 表示没标定，走原来的简单映射 */
    matrix: null as Matrix3x3 | null,
    /** 是否已经从 localStorage 读过（避免每次组件挂载重复读） */
    loaded: false,
  }),
  getters: {
    calibrated: state => state.matrix !== null,
  },
  actions: {
    /** 从 localStorage 恢复。SSR 下没有 localStorage，直接跳过 */
    load() {
      if (this.loaded) return
      this.loaded = true

      if (typeof localStorage === 'undefined') return

      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const parsed: unknown = JSON.parse(raw)
        // 用户可能手改过 localStorage，形状不对就当没标定，不能让脏数据进推理链路
        if (isMatrix3x3(parsed)) this.matrix = parsed
      }
      catch {
        // 解析失败按未标定处理，不影响画图
      }
    },
    save(matrix: Matrix3x3) {
      this.matrix = matrix
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(matrix))
      }
      catch {
        // 隐私模式/配额满：本次会话仍然生效，只是下次进来要重标
      }
    },
    clear() {
      this.matrix = null
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.removeItem(STORAGE_KEY)
      }
      catch {
        // 同上，忽略
      }
    },
  },
})
