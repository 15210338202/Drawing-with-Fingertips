import type { HandLandmark } from './useHandTracking'

/** 拿不到真实画幅时的兜底宽高比（摄像头默认 640×480） */
const DEFAULT_ASPECT = 4 / 3

/**
 * 两个关键点之间的距离，**已换算到等比空间**。
 *
 * 为什么必须换算：MediaPipe 的 x 是按画面【宽】归一化的、y 是按画面【高】归一化的。
 * 640×480 下同样是 51 像素的位移，横向只算出 0.08、纵向算出 0.107 —— 相差 33%。
 * 表现就是：横向捏合和纵向捏合的手感不一样，阈值只能对着某一个方向调。
 * 修法：算距离前把 dx 乘上宽高比（w/h），把两者都换算成「以画面高度为单位」的尺度。
 *
 * 物理上等价于：在正方形像素空间里量距离，而不是在归一化拉伸空间里量。
 *
 * @param aspect 画面宽高比 = video.videoWidth / video.videoHeight
 */
function distance(
  a: { x: number, y: number },
  b: { x: number, y: number },
  aspect: number,
) {
  const dx = (a.x - b.x) * aspect
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

/**
 * 宽高比的兜底与熔断。
 * 摄像头还没 metadata 时 store 里可能是 undefined；0/NaN 会让距离恒为 0、捏合永远成立，
 * 所以这里把不合理值一律退回 4:3。
 */
function normalizeAspect(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_ASPECT
  return value
}

/**
 * 手势状态机：捏合进入绘制、松开退出、握拳清空。
 *
 * 输入是每帧的 21 个关键点，输出是 state（idle / drawing）。
 * 阈值都从 stores/gesture.ts 读，Toolbar 上的调试滑杆改的就是它们。
 */
export function useGesture() {
  const store = useGestureStore()

  /** 直接映射 store 里的状态：画布和这里读到的必须是同一个值 */
  const state = computed(() => store.state)

  /** 连续判定为捏合的帧数 */
  let pinchStreak = 0
  /** 握拳开始的时间戳，null 表示当前没握拳 */
  let fistSince: number | null = null
  /** 这一次握拳是否已经触发过清空（要松手才重新武装，否则一直握着会反复清空） */
  let fistConsumed = false
  /** 外部注册的清空动作 */
  let clearHandler: (() => void) | null = null

  /** 注册清空回调；具体清什么由调用方决定（我们接的是 store 计数器） */
  function onClear(handler: () => void) {
    clearHandler = handler
  }

  /**
   * 指尖到手腕的距离 ÷ 手掌尺寸。
   * 手掌大小因人而异、离摄像头远近也会变，所以必须用比例，不能用绝对距离。
   *
   * 注意 aspect 必须和下面算 palmSize 用的是同一个：分子分母在同一度量空间里，
   * 比值才有意义（手掌方向不同时两边的缩放系数不一样，不能只缩一边）。
   */
  function tipRatio(landmarks: HandLandmark[], tipIndex: number, palmSize: number, aspect: number) {
    const tip = landmarks[tipIndex]
    const wrist = landmarks[0]
    if (!tip || !wrist) return Number.POSITIVE_INFINITY

    return distance(tip, wrist, aspect) / palmSize
  }

  /**
   * 握拳计时：四指持续收拢 fistHoldMs 毫秒，才触发一次清空。
   *
   * 判定只用四指（不含拇指 4）：握拳时拇指绕在四指**外侧**，指尖停在指关节那一圈，
   * 离手腕天生远得多，算进来会让握拳永远不成立（这就是之前握拳不清空的原因）。
   * 四指伸直时指尖到手腕约 2 倍掌长、蜷起来只剩 0.5 倍左右，区分度足够。
   * 拇指的值仍然写进调试读数，方便观察它差多少。
   *
   * @param isFist 四指是否已经蜷起来
   */
  function updateFistClear(isFist: boolean) {
    if (!isFist) {
      // 没攥住：重新武装
      fistSince = null
      fistConsumed = false
      return
    }

    const now = performance.now()
    if (fistSince === null) fistSince = now

    // 已经清过一次了，等松手；不然握着一秒就清一次
    if (fistConsumed) return
    if (now - fistSince < store.fistHoldMs) return

    fistConsumed = true
    pinchStreak = 0
    store.setState('idle')
    clearHandler?.()
  }

  /**
   * 每帧调用一次。
   * @param landmarks Worker 回传的 21 个关键点；手丢了传 null
   * @returns 更新后的状态
   */
  function update(landmarks: HandLandmark[] | null) {
    if (!landmarks || landmarks.length < 21) {
      reset()
      return state.value
    }

    // 画面宽高比每帧读一次：摄像头换分辨率（外接/内置切换）时自动跟上，不用重新加载页面
    const aspect = normalizeAspect(store.cameraAspect)

    // 手掌尺寸用手腕(0)到中指根(9)的距离，不能写死固定值
    const palmSize = distance(landmarks[0], landmarks[9], aspect) || 1

    const pinchRatio = distance(landmarks[4], landmarks[8], aspect) / palmSize

    // 四指里离手腕最远的那根：握拳判定看它，它也最能说明“这个拳攥紧了没有”
    const fingerRatio = store.fistFingers.reduce(
      (worst, index) => Math.max(worst, tipRatio(landmarks, index, palmSize, aspect)),
      0,
    )
    const thumbRatio = tipRatio(landmarks, 4, palmSize, aspect)

    // 读出来的数写进 store，Toolbar 实时显示，方便对着调滑杆
    store.setDebugRatios(pinchRatio, fingerRatio, thumbRatio)

    const isFist = fingerRatio < store.fistThreshold

    // 握拳的优先级高于捏合，而且必须放在捏合判定【前面】：
    // 攥拳的过程中拇指和食指本来就会互相靠近，先走捏合判定的话会先进入 drawing 画出一小段，
    // 一秒后清空时再一起抹掉 —— 看着就像 bug。所以只要四指收拢，立刻停笔且不再进入 drawing。
    if (isFist) {
      if (state.value === 'drawing') store.setState('idle')
      pinchStreak = 0
      updateFistClear(true)
      return state.value
    }

    // 手张开了：握拳计时归零、重新武装
    updateFistClear(false)

    // 迟滞的两个阈值必须 enter < exit；滑杆被拉反了状态会反复横跳，这里兜一道
    const enter = Math.min(store.pinchEnter, store.pinchExit)
    const exit = Math.max(store.pinchEnter, store.pinchExit)

    // 已经在画的时候用宽松的退出阈值，否则用进入阈值 —— 这就是迟滞
    const threshold = state.value === 'drawing' ? exit : enter

    if (pinchRatio < threshold) {
      pinchStreak += 1
    } else {
      // 松开不做连续帧确认，否则抬笔会拖一到两帧
      pinchStreak = 0
      store.setState('idle')
    }

    // 连续 confirmFrames 帧都捏合才真正落笔，避免单帧误判就画出一小段
    if (state.value !== 'drawing' && pinchStreak >= Math.max(1, store.confirmFrames)) {
      store.setState('drawing')
    }

    return state.value
  }

  /** 手丢失 / 关摄像头时复位，避免状态卡在 drawing */
  function reset() {
    pinchStreak = 0
    fistSince = null
    fistConsumed = false
    store.setState('idle')
    store.setDebugRatios(0, 0, 0)
  }

  return { state, update, onClear, reset }
}
