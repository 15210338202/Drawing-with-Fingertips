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
    /**
     * 画面宽高比（videoWidth / videoHeight），由 CameraPreview 在拿到 metadata 后写进来。
     * 关键点距离要按它换算到等比空间，否则横向和纵向捏合的读数会差 33%。
     * 默认 4:3 对应摄像头约束 640×480，拿不到真实画幅时也不会算错。
     */
    cameraAspect: 4 / 3,
    /**
     * 捏合进入阈值：**2D** 指尖向量按掌长(0→9)/掌宽(5→17)各向异性归一化后的比例。
     * 读数不一定是 0.25：手型、模型版本、手侧过来的角度都会影响它。
     * 最快标定法：捏合时点 Toolbar 的「记录进入」，张开时点「记录退出」。
     */
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
    /** 当前捏合比例：2D 指尖向量按掌长/掌宽各向异性归一化 */
    debugPinchRatio: 0,
    /** 捏合读数的数据源：现在是 2d；保留字段便于以后接 3D 诊断 */
    debugPinchSource: '2d' as '3d' | '2d',
    /** 当前原始 2D 指尖距离（归一化），配合 debugPinchPalm 看比例是怎么来的 */
    debugPinchTip: 0,
    /** 等效掌尺 = 当前指尖距离 ÷ 比例；不是单一掌宽，只用于显示 */
    debugPinchPalm: 0,
    /** worldLandmarks 点数：只作诊断，不参与捏合判定 */
    debugPinchWorldCount: 0,
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
    /** 摄像头画幅变了（换分辨率/外接设备）时更新，距离换算要用它 */
    setCameraAspect(v: number) {
      if (Number.isFinite(v) && v > 0) this.cameraAspect = v
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
    setDebugRatios(pinch: number, fingers: number, thumb: number, source: '3d' | '2d' = '2d') {
      this.debugPinchRatio = pinch
      this.debugPinchSource = source
      this.debugFingerRatio = fingers
      this.debugThumbRatio = thumb
    },
    /** useGesture 每帧写捏合原始距离，Toolbar 用来判断 0.5 是分子大还是分母小 */
    setPinchDiagnostics(tip: number, palm: number, worldCount: number) {
      this.debugPinchTip = tip
      this.debugPinchPalm = palm
      this.debugPinchWorldCount = worldCount
    },
    /**
     * 现场标定：把**当前捏合读数**设成进入阈值。
     * 不再需要先知道“正常应该是 0.25 还是 0.5”，捏住时点一下就行。
     */
    capturePinchEnter() {
      if (!Number.isFinite(this.debugPinchRatio)) return
      this.pinchEnter = Math.min(3, Math.round((this.debugPinchRatio + 0.02) * 100) / 100)
      if (this.pinchExit <= this.pinchEnter + 0.02) {
        this.pinchExit = Math.min(3, Math.round((this.pinchEnter + 0.08) * 100) / 100)
      }
    },
    /** 现场标定：把**当前张开读数**设成退出阈值 */
    capturePinchExit() {
      if (!Number.isFinite(this.debugPinchRatio)) return
      const exit = Math.round((this.debugPinchRatio - 0.02) * 100) / 100
      this.pinchExit = Math.max(this.pinchEnter + 0.02, Math.min(3, exit))
    },
    /** 请求清空画布（DrawingCanvas 监听 clearRequested） */
    requestClear() {
      this.clearRequested += 1
    },
  },
})
