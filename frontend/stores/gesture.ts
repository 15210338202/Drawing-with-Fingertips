import { defineStore } from 'pinia'

export const useGestureStore = defineStore('gesture', {
  state: () => ({
    /** 手势状态机：idle 待机 / drawing 绘制中 */
    state: 'idle' as 'idle' | 'drawing',
    /** 食指尖的归一化坐标，只在 drawing 时有值 */
    lastPoint: null as { x: number; y: number } | null,
    /**
     * 食指尖的悬停坐标（归一化、已镜像），只要有手就有值，不依赖捏合。
     * 和 lastPoint 的区别：lastPoint 是「正在画的点」，松手/丢手就置空；
     * 这个是「手在哪」，供悬停准星跟随，捏不捏合都不影响。
     */
    hoverPoint: null as { x: number; y: number } | null,

    // ===== 判定参数：Toolbar 的调试滑杆直接绑这几个，现场对着手调，调好了把默认值写回来 =====
    /** 捏合进入阈值：拇指尖到食指尖的距离 ÷ 手掌尺寸，小于它算捏合 */
    pinchEnter: 0.25,
    /** 捏合退出阈值：大于它算松开。必须比 pinchEnter 大，两者之差就是迟滞 */
    pinchExit: 0.35,
    /** 连续多少帧判定为捏合，才真正进入 drawing */
    confirmFrames: 3,
    /** 握拳要持续多少毫秒才触发清空 */
    fistHoldMs: 1000,
    /** 握拳判定：四指指尖到手腕的归一化距离上限 */
    fistThreshold: 0.85,
    /** 握拳判定：五指尖中要检查的四个（不含拇指，拇指握拳时绕在外侧，见 useGesture.ts 说明） */
    fistFingers: [8, 12, 16, 20],

    // ===== 调试读数：useGesture 每帧写进来，Toolbar 显示，用来现场对阈值 =====
    /** 当前捏合比例：拇指尖到食指尖的距离 ÷ 手掌尺寸 */
    debugPinchRatio: 0,
    /** 当前四指指尖到手腕的**最大**归一化距离（握拳时要它小于 fistThreshold） */
    debugFingerRatio: 0,
    /** 当前拇指尖到手腕的归一化距离（只作参考，不参与握拳判定） */
    debugThumbRatio: 0,

    /**
     * 清空请求计数器：每握拳清空一次就 +1。
     * 用计数器而不是布尔值 —— 连续两次清空时布尔值 true→true 不会触发 watch，
     * 计数器每次都在变，一定收得到。
     * 它同时也是调试读数：握拳后这个数字不动，说明手势没判定成功；动了但画布没清，才是画布那边的问题。
     */
    clearRequested: 0,
  }),
  actions: {
    setState(s: 'idle' | 'drawing') {
      this.state = s
    },
    setLastPoint(p: { x: number; y: number } | null) {
      this.lastPoint = p
    },
    /** 悬停准星的坐标；没识别到手时传 null */
    setHoverPoint(p: { x: number; y: number } | null) {
      this.hoverPoint = p
    },
    setPinchEnter(v: number) {
      this.pinchEnter = v
    },
    setPinchExit(v: number) {
      this.pinchExit = v
    },
    setConfirmFrames(v: number) {
      this.confirmFrames = v
    },
    setFistHoldMs(v: number) {
      this.fistHoldMs = v
    },
    setFistThreshold(v: number) {
      this.fistThreshold = v
    },
    /** useGesture 每帧写调试读数 */
    setDebugRatios(pinch: number, fingers: number, thumb: number) {
      this.debugPinchRatio = pinch
      this.debugFingerRatio = fingers
      this.debugThumbRatio = thumb
    },
    /** 请求清空画布（DrawingCanvas 监听 clearRequested） */
    requestClear() {
      this.clearRequested += 1
    },
  },
})
