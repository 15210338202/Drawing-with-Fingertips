import type { DetectedHand, HandLandmark } from './useHandTracking'

/** 拿不到真实画幅时的兜底宽高比（摄像头默认 640×480） */
const DEFAULT_ASPECT = 4 / 3

/**
 * 控制台捏合读数开关：dev 默认开，生产环境带 ?pinch=1 才开。
 *
 * 2D 归一化改成按掌长/掌宽两个方向分别归一化，阈值仍建议用 Toolbar 的「记录进入/退出」现场标定；
 * 控制台每 500ms 一条的日志适合回看一次“捏合 → 松开”的完整数值区间。
 */
const LOG_PINCH = typeof location !== 'undefined'
  && (import.meta.dev || new URLSearchParams(location.search).has('pinch'))

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

/** 捏合读数；source 目前固定 2d，保留字段方便以后加 3D 诊断 */
export interface PinchReading {
  /** 2D 指尖向量按掌长/掌宽各向异性归一化后的比例，无量纲 */
  pinchRatio: number
  /** 原始 2D 指尖距离（以画面高度为单位） */
  tipDistance: number
  /** 等效掌尺 = 指尖距离 ÷ 比例；不是单一掌宽，只用于把读数还原成“分子/分母”看 */
  palmScale: number
  /** 原始 2D 掌宽（5→17 在垂直掌长方向上的投影），只用于调试对比 */
  palmWidth: number
  /** 2D 掌长（0→9），各向异性归一化的另一个轴 */
  palmLength: number
  /** worldLandmarks 的点数；只作诊断，不参与捏合判定 */
  worldCount: number
  source: '2d'
  /** 拿 threshold 直接比较的结果；手势状态机用迟滞，不直接采用它 */
  isPinching: boolean
}

/**
 * 2D 捏合度量：把“拇指尖→食指尖”的向量，按手掌的两个轴分别归一化。
 *
 * 只用一个标量掌长（比如 0→9）时，手向另一个方向转，指尖向量和掌长被透视
 * 压缩的比例不同，比值还是会漂；这里把向量拆成“沿掌长”和“横穿手掌”两个分量，
 * 各自除以对应的掌长/掌宽。这样每个分量和它的分母被同一个 cos(角度) 压缩，
 * 侧手、俯仰、正对屏幕都能约掉，读数更接近。
 *
 * 掌宽退化（手几乎侧成一条线）时把分母夹到掌长的 5%，避免除以接近 0 的数。
 */
function pinchMetrics2D(landmarks: HandLandmark[], aspect: number) {
  const tip = landmarks[4]
  const indexTip = landmarks[8]
  const wrist = landmarks[0]
  const middleMcp = landmarks[9]
  const indexMcp = landmarks[5]
  const pinkyMcp = landmarks[17]

  if (!tip || !indexTip || !wrist || !middleMcp) {
    return { ratio: Number.POSITIVE_INFINITY, tipDistance: Number.POSITIVE_INFINITY, palmWidth: 0, palmLength: 0 }
  }

  // x 先乘宽高比，全部换到正方形像素空间后再算方向/投影
  const x = (p: HandLandmark) => p.x * aspect
  const alongX = x(middleMcp) - x(wrist)
  const alongY = middleMcp.y - wrist.y
  const palmLength = Math.hypot(alongX, alongY)

  const tipX = x(tip) - x(indexTip)
  const tipY = tip.y - indexTip.y
  const tipDistance = Math.hypot(tipX, tipY)

  if (palmLength <= 1e-6) {
    return { ratio: Number.POSITIVE_INFINITY, tipDistance, palmWidth: 0, palmLength: 0 }
  }

  const ux = alongX / palmLength
  const uy = alongY / palmLength

  // 掌宽 5→17 在“垂直于掌长”方向上的投影；不投影的话斜着的手会把宽度算大
  let palmWidth = 0
  if (indexMcp && pinkyMcp) {
    const wx = x(indexMcp) - x(pinkyMcp)
    const wy = indexMcp.y - pinkyMcp.y
    palmWidth = Math.abs(wx * -uy + wy * ux)
  }

  // 掌宽太小说明手侧得几乎只剩一条线；夹一个下限，防止比例被噪声放大
  const acrossScale = palmWidth > 1e-6
    ? Math.max(palmWidth, palmLength * 0.05)
    : palmLength

  const alongComp = tipX * ux + tipY * uy
  const acrossComp = tipX * -uy + tipY * ux
  const ratio = Math.hypot(alongComp / palmLength, acrossComp / acrossScale)

  return { ratio, tipDistance, palmWidth, palmLength }
}

/**
 * R3：计算捏合比例。
 *
 * 用 2D 的拇指尖(4)–食指尖(8) 向量，按掌长(0→9)和掌宽(5→17)两个方向
 * 分别归一化：手大手小、离镜头远近都被约掉，剩下的才是“捏没捏上”。
 *
 * 为什么不用 3D worldLandmarks：实测同一只手的捏合读数，正对屏幕约 0.2，
 * 侧手会涨到 0.8+。这是 MediaPipe 在侧手/自遮挡时深度估计漂移造成的，
 * 换分母、换基准点都救不回来；而 2D 投影里“捏住”就是两个指尖在图像上重合，
 * 再按手掌两个轴做各向异性归一化，侧手和正对屏幕的读数更接近。
 *
 * @param threshold 直接判定用的阈值，仅供调试/外部调用；状态机内部走迟滞
 */
export function checkPinch(
  hand: DetectedHand,
  threshold = 0.25,
  aspect = DEFAULT_ASPECT,
): PinchReading {
  const landmarks = hand.landmarks
  const worldCount = hand.worldLandmarks?.length ?? 0

  const tip = landmarks?.[4]
  const indexTip = landmarks?.[8]
  const wrist = landmarks?.[0]
  const indexMcp = landmarks?.[5]

  if (!tip || !indexTip || !wrist || !indexMcp || landmarks.length < 21) {
    return {
      pinchRatio: Number.POSITIVE_INFINITY,
      tipDistance: Number.POSITIVE_INFINITY,
      palmScale: 0,
      palmWidth: 0,
      palmLength: 0,
      worldCount,
      source: '2d',
      isPinching: false,
    }
  }

  const { ratio, tipDistance, palmWidth, palmLength } = pinchMetrics2D(landmarks, aspect)

  // 还原一个“等效掌尺”，让 Toolbar 仍然能用 指尖 ÷ 掌尺 解释这个比例；
  // 真正的比例是上面按两个轴分别归一化后的结果，不是单一分母。
  const palmScale = ratio > 1e-6 && Number.isFinite(ratio) ? tipDistance / ratio : 0

  return {
    pinchRatio: ratio,
    tipDistance,
    palmScale,
    palmWidth,
    palmLength,
    worldCount,
    source: '2d',
    isPinching: ratio < threshold,
  }
}

/** 控制台采样节流：500ms 一条，避免 30FPS 把 Console 刷爆 */
let lastPinchLogAt = 0

function logPinch(reading: PinchReading) {
  if (!LOG_PINCH) return

  const now = performance.now()
  if (now - lastPinchLogAt < 500) return
  lastPinchLogAt = now

  console.log(
    `[pinch] ${reading.source} ratio=${reading.pinchRatio.toFixed(3)}`
    + ` tip=${reading.tipDistance.toFixed(4)} scale=${reading.palmScale.toFixed(4)}`
    + ` palmW=${reading.palmWidth.toFixed(4)} palmL=${reading.palmLength.toFixed(4)}`
    + ` world=${reading.worldCount}`,
  )
}

/**
 * 手势状态机：捏合进入绘制、松开退出、握拳清空。
 *
 * 输入是 R4 选出的主手（DetectedHand：2D + 3D + handedness），输出是 state（idle / drawing）。
 * 捏合走 2D 指尖向量按掌长/掌宽各向异性归一化（R3），握拳走 2D 掌长归一化；两套尺度不要混用。
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
   * 每帧调用一次，**只传主手**。
   *
   * 主手由 useHandTracking 的 R4 逻辑选出；这里不做“哪只手该画”的判断，
   * 只负责把手势状态机推进一格。
   *
   * @param hand 主手结果（2D + 3D + handedness）；丢手时传 null
   * @returns 更新后的状态
   */
  function update(hand: DetectedHand | null) {
    const landmarks = hand?.landmarks

    if (!hand || !landmarks || landmarks.length < 21) {
      reset()
      return state.value
    }

    // 画面宽高比每帧读一次：摄像头换分辨率（外接/内置切换）时自动跟上，不用重新加载页面
    const aspect = normalizeAspect(store.cameraAspect)

    // 手掌尺寸用手腕(0)到中指根(9)的距离，不能写死固定值。
    // 注意：这是握拳判定用的 2D 掌长，和 R3 捏合用的各向异性掌尺是两套尺度。
    const palmSize = distance(landmarks[0], landmarks[9], aspect) || 1

    // R3：捏合走 2D——指尖向量按掌长/掌宽各向异性归一化，侧手更稳；3D 只留作诊断
    const pinch = checkPinch(hand, store.pinchEnter, aspect)
    const pinchRatio = pinch.pinchRatio

    // 四指里离手腕最远的那根：握拳判定看它，它也最能说明“这个拳攥紧了没有”
    const fingerRatio = store.fistFingers.reduce(
      (worst, index) => Math.max(worst, tipRatio(landmarks, index, palmSize, aspect)),
      0,
    )
    const thumbRatio = tipRatio(landmarks, 4, palmSize, aspect)

    // 读出来的数写进 store，Toolbar 实时显示，方便对着调滑杆
    store.setDebugRatios(pinchRatio, fingerRatio, thumbRatio, pinch.source)
    // 可选调用：dev 下 HMR 可能只替换了 useGesture、还没替换 store，
    // 旧 store 实例没有这个新 action；不能让它把整帧手势更新打崩。
    store.setPinchDiagnostics?.(pinch.tipDistance, pinch.palmScale, pinch.worldCount)
    logPinch(pinch)

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
    store.setPinchDiagnostics?.(0, 0, 0)
  }

  return { state, update, onClear, reset }
}
