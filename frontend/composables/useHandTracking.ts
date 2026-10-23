import type { DetectRequest, DetectedHand, HandLandmark, WorkerResponse } from '~/workers/hand.worker'
import { isGeometricallyValid } from '~/utils/handGeometry'

export type { DetectedHand, HandLandmark }

/**
 * 性能采样开关：dev 默认开；生产环境要带 ?perf=1 才开（HUD 也只在 ?perf=1 时显示）。
 * 必须判 location 是否存在：Nuxt 默认 SSR，服务端没有 location。
 */
const PERF_ENABLED = typeof location !== 'undefined'
  && (import.meta.dev || new URLSearchParams(location.search).has('perf'))

/**
 * R6 几何过滤默认关闭，先用回 R6 之前的识别链路。
 *
 * 原因：真实 OK/捏合手型会被“四指骨长关系”误杀——MediaPipe 明明返回了手，
 * 过滤后 hands 变成空数组，界面就显示“未检测到手”，第二只手出现时还会顶替主手。
 * 代码保留，方便以后继续调规则；要重新测试过滤，在 URL 加 ?r6=1。
 */
const R6_ENABLED = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('r6')

/** 秒级样本最多留 300 条（约 5 分钟）；相邻完成帧间隔最多留 240 条（约 8 秒）—— 都是有界缓冲，长跑不会吃内存 */
const PERF_MAX_FPS_SAMPLES = 300
const PERF_MAX_INTERVALS = 240

/**
 * R4：主手丢失多久后才清空身份。
 *
 * 不能一丢手就清：抬手、眨眼、手短暂出画都很常见，
 * 立刻清空会让下一帧的“另一只手”被当成主手，画布上就会出现横跳的笔迹。
 */
const MAIN_HAND_LOST_MS = 1000

/**
 * R6：几何过滤全部拒绝时，上一帧“有效手”最多再显示这么久。
 *
 * 不能一帧不合格就立刻清空：MediaPipe 偶尔抖一帧，清空会让准星/覆盖层闪烁。
 * 但也不能无限保留：正常手被 R6 连续误杀时，旧关键点会冻结在画面上，
 * 看起来像“点位不跟手/延迟”，实际是过滤后没有更新 hands。超过这个宽限期就清空。
 */
const STALE_HAND_GRACE_MS = 250

/**
 * R4：最近邻匹配时，给 handedness 与上一帧不一致的手加的惩罚（归一化坐标单位）。
 *
 * 只加 0.08：两只手交叉时距离项仍然占主导（交叉瞬间两手掌心本来就重合，谁都不是“最近”），
 * 但在距离接近时优先保持原身份，避免 MediaPipe 标签抖一下就把主手换掉。
 */
const HANDEDNESS_SWITCH_PENALTY = 0.08

/**
 * R4：只剩一只手、且 handedness 与主手身份不一致时，判断它是“主手标签抖了”还是“换了只手”。
 *
 * 掌中心离上一帧主手锚点在这个半径内 → 当作同一只手的标签抖动，立即接管；
 * 超出半径 → 认为真的换了只手，要等 MAIN_HAND_LOST_MS 超时才允许接管，
 * 避免主手只是短暂出画（去喝水、拿鼠标）时画布立刻跟着另一只手跑。
 * 归一化坐标单位，0.15 约等于画面短边的 15%。
 */
const MAIN_HAND_LABEL_FLIP_RADIUS = 0.15

/** HUD / 调试面板读取的性能快照 */
export interface PerfSnapshot {
  /** 采样是否启用（生产环境未带 ?perf=1 时为 false，其余字段全 0） */
  enabled: boolean
  /** 最近一个完整 1 秒窗口内的完成帧数，约等于有效 FPS */
  fps: number
  /** 相邻完成帧间隔的 p95（毫秒） */
  p95Interval: number
  /** 相邻完成帧间隔的最大值（毫秒） */
  maxInterval: number
  /** 丢帧率 = 1 − 完成帧数 / 入队帧数（被单槽覆盖掉的帧就算丢了） */
  dropRate: number
  /** 入队（交给 Worker 或被覆盖）的帧数 */
  captures: number
  /** Worker 真正回结果并参与统计的帧数 */
  done: number
}

/**
 * 手部关键点识别（跑在 Worker 里）。
 *
 * 推理放 Worker 是为了不卡 UI：MediaPipe 一帧要几十毫秒，放主线程会明显掉帧。
 * 主线程和 Worker 的约定：主线程把当前帧抓成 ImageBitmap 转移过去，Worker 回传关键点。
 *
 * 派发策略是 **latest-wins 单槽**：推理期间只保留最新一帧，回来后立刻补发。
 * 早期版本在 busy 时直接丢帧，CPU 推理 40–60ms 的前提下有效帧率只有 15–20FPS，
 * 快速移动时手已在两帧之间跑远，表现为断笔 / 跟丢。
 */
export function useHandTracking() {
  /**
   * 本帧检测到的所有手（0–2 只）。
   * shallowRef：每帧都是一个全新的普通数组，深层响应式会把 42 个关键点全包成 Proxy，
   * 纯属白烧 CPU；替换整个数组就足以触发更新。
   */
  const hands = shallowRef<DetectedHand[]>([])
  /** R4 选出的主手；画布和手势只认它 */
  const mainHand = shallowRef<DetectedHand | null>(null)
  /** 主手的 21 个 2D 关键点；没手时是 null。准星/覆盖层/画布都只该用这个 2D 数据 */
  const landmarks = computed(() => mainHand.value?.landmarks ?? null)
  /** 主手的 handedness（'Left' / 'Right' / 'Unknown'），调试和身份维持用 */
  const mainHandLabel = computed(() => mainHand.value?.handedness ?? null)

  /** Worker 是否加载完模型，ready 之前 detect 会被丢掉 */
  const ready = ref(false)
  const loading = ref(false)
  const error = ref('')
  /** 上一条帧还在推理中：此时不要再发新帧，否则队列会越积越多、画面越拖越晚 */
  const busy = ref(false)

  let worker: Worker | null = null

  /**
   * 待发槽（latest-wins）：推理进行中时，新帧只覆盖这里，永远保留最新的一帧。
   * 之前是 busy 时整帧丢弃，等于把有效帧率砍掉一半，快速移动时手在两帧之间已经跑远。
   */
  let pending: { bitmap: ImageBitmap, timestamp: number } | null = null

  /** 上一次通过 R6 并真正更新 hands 的时刻；0 表示还没有有效帧 */
  let lastValidAt = 0

  /**
   * 最近一次真正入队的帧时间戳。
   * createImageBitmap 是异步的，连续抓帧时旧图可能比新图晚 resolve；
   * 不挡住的话，旧图会覆盖待发槽里的新图，关键点会向后跳一帧。
   */
  let lastQueuedTs = 0

  /**
   * 性能计数器。故意做成普通对象而不是 ref：
   * HUD 每 250ms 主动读一次，没必要每帧触发响应式更新（那本身就会干扰要测的东西）。
   */
  const perf = {
    /** 当前 1 秒窗口的起点（performance.now 时间轴），0 表示还没开窗 */
    windowStart: 0,
    /** 当前窗口内完成的帧数 */
    count: 0,
    /** 每秒一个样本：窗口结束时的 count 就等于那一秒的 FPS */
    fpsHistory: [] as number[],
    /** 相邻完成帧的间隔，用于算 p95 / max */
    intervals: [] as number[],
    /** 上一帧完成时刻，0 表示还没开始 */
    lastDoneAt: 0,
    /** 入队帧数（用于算丢帧率） */
    captures: 0,
    /** 完成帧数 */
    done: 0,
  }

  /**
   * 每完成一帧记一次。
   * 直接算「总帧数 / 总时长」会被 warmup 和卡顿段污染，所以这里按秒切窗口采样，
   * 再看分布（p95 / max）。
   */
  function noteFrameDone() {
    const now = performance.now()

    perf.done += 1
    perf.count += 1

    if (perf.lastDoneAt) {
      perf.intervals.push(now - perf.lastDoneAt)
      if (perf.intervals.length > PERF_MAX_INTERVALS) perf.intervals.shift()
    }
    perf.lastDoneAt = now

    // 第一帧到了才开窗：从 0 起算会把启动耗时算进第一个样本
    if (!perf.windowStart) {
      perf.windowStart = now
      return
    }

    if (now - perf.windowStart >= 1000) {
      // 窗口实际长度会多出几十毫秒（由「下一帧到了才发现窗口过期」决定），
      // 直接 push(count) 会系统性低估 FPS，所以按真实窗口时长归一
      const elapsed = now - perf.windowStart
      perf.fpsHistory.push(Math.round((perf.count / elapsed) * 1000 * 10) / 10)
      if (perf.fpsHistory.length > PERF_MAX_FPS_SAMPLES) perf.fpsHistory.shift()

      perf.count = 0
      perf.windowStart = now
    }
  }

  /**
   * 读一次快照给 HUD。p95 用「复制后排序」实现：
   * 窗口最多 240 条、每 250ms 调一次，这点开销可以忽略。
   */
  function perfSnapshot(): PerfSnapshot {
    if (!PERF_ENABLED) {
      return { enabled: false, fps: 0, p95Interval: 0, maxInterval: 0, dropRate: 0, captures: 0, done: 0 }
    }

    const sorted = [...perf.intervals].sort((a, b) => a - b)
    const p95Index = sorted.length ? Math.ceil(sorted.length * 0.95) - 1 : -1

    return {
      enabled: true,
      fps: perf.fpsHistory.length ? perf.fpsHistory[perf.fpsHistory.length - 1]! : 0,
      p95Interval: p95Index >= 0 ? (sorted[p95Index] ?? 0) : 0,
      maxInterval: sorted.length ? (sorted[sorted.length - 1] ?? 0) : 0,
      dropRate: perf.captures > 0 ? Math.max(0, 1 - perf.done / perf.captures) : 0,
      captures: perf.captures,
      done: perf.done,
    }
  }

  // 采样期间把计数器挂到 window 上，方便在 Console 直接看（不启用时不留全局变量）
  if (PERF_ENABLED && typeof window !== 'undefined') {
    ;(window as unknown as { __handPerf?: typeof perf }).__handPerf = perf
  }

  // ===== R4 主手追踪 =====
  /** 当前主手的 handedness，null 表示还没锁定 / 已经丢失超时 */
  let mainHandedness: DetectedHand['handedness'] | null = null
  /** 上一帧主手的掌中心（归一化坐标），最近邻匹配的锚点 */
  let lastPalm: { x: number, y: number } | null = null
  /** 上一次真正看到主手的时刻，用于 MAIN_HAND_LOST_MS 超时 */
  let lastSeenAt = 0

  /**
   * 掌中心 = 手腕(0) 与中指根(9) 的中点。
   * 比直接用手腕(0) 稳：手腕在画面边缘时抖动大，而且它并不是手掌的几何中心。
   * 只用 2D 归一化坐标，和画布坐标系一致。
   */
  function palmPoint(hand: DetectedHand): { x: number, y: number } | null {
    const wrist = hand.landmarks[0]
    const middleMcp = hand.landmarks[9]
    if (!wrist || !middleMcp) return null
    return { x: (wrist.x + middleMcp.x) / 2, y: (wrist.y + middleMcp.y) / 2 }
  }

  /**
   * 手掌在画面里的近似面积（归一化单位，越大 = 离摄像头越近）。
   * 首次锁定主手时用它：两只手同时出现时，默认选离镜头更近、更像“正在操作”的那只。
   */
  function palmArea(hand: DetectedHand) {
    const wrist = hand.landmarks[0]
    const indexMcp = hand.landmarks[5]
    const middleMcp = hand.landmarks[9]
    if (!wrist || !indexMcp || !middleMcp) return 0

    const width = Math.hypot(indexMcp.x - wrist.x, indexMcp.y - wrist.y)
    const length = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y)
    return width * length
  }

  /** 两只手都没有历史锚点时：手掌面积最大者优先，面积接近时 handedness 置信度高者优先 */
  function pickLargestHand(list: DetectedHand[]) {
    return [...list].sort((a, b) => {
      const areaDiff = palmArea(b) - palmArea(a)
      if (Math.abs(areaDiff) > 1e-6) return areaDiff
      return b.handednessScore - a.handednessScore
    })[0]!
  }

  /** 记住这一帧的主手身份，下一帧的最近邻匹配以它为锚点 */
  function rememberMain(hand: DetectedHand, now: number) {
    mainHandedness = hand.handedness
    const palm = palmPoint(hand)
    if (palm) lastPalm = palm
    lastSeenAt = now
  }

  /**
   * 每帧从 0–2 只手里选出主手。
   *
   * 规则（对应 R4）：
   * 1. 一只手 → 默认直接当主手（启动时本来就只有一只手）；
   *    但如果 handedness 和主手不同、且它离主手锚点较远，说明可能是“另一只手”，
   *    在 1 秒身份维持期内先不接管，等主手回来或超时后再换；
   * 2. 两只手且没有历史身份 → 选面积大的（离镜头近）；
   * 3. 两只手且有历史身份 → 选掌中心离上一帧主手最近的那只，
   *    同 handedness 的手获得 0.08 的匹配优势，防止标签抖动导致主手互换；
   * 4. 0 只手 → 保持身份最多 1 秒，超时才清空，避免短暂丢手后主手被另一只手顶替。
   */
  function selectMainHand(list: DetectedHand[], now: number): DetectedHand | null {
    if (list.length === 0) {
      if (mainHandedness !== null && now - lastSeenAt > MAIN_HAND_LOST_MS) {
        mainHandedness = null
        lastPalm = null
      }
      return null
    }

    if (list.length === 1) {
      const only = list[0]!
      const palm = palmPoint(only)

      // 只剩一只手、标签又和主手不一样：先看它是不是还在主手原来的位置附近。
      // 近 → 大概率是同一只手的 handedness 抖了，直接接管；
      // 远 → 这只是“另一只手”，在 1 秒身份维持期内不抢主手。
      if (mainHandedness !== null && only.handedness !== mainHandedness && lastPalm && palm) {
        const distance = Math.hypot(palm.x - lastPalm.x, palm.y - lastPalm.y)
        if (distance > MAIN_HAND_LABEL_FLIP_RADIUS && now - lastSeenAt <= MAIN_HAND_LOST_MS) {
          return null
        }
      }

      rememberMain(only, now)
      return only
    }

    let picked: DetectedHand

    if (!mainHandedness || !lastPalm) {
      picked = pickLargestHand(list)
    } else {
      const anchor = lastPalm
      const expected = mainHandedness
      let best: DetectedHand | null = null
      let bestScore = Number.POSITIVE_INFINITY

      for (const hand of list) {
        const palm = palmPoint(hand)
        if (!palm) continue

        const distance = Math.hypot(palm.x - anchor.x, palm.y - anchor.y)
        const score = distance + (hand.handedness === expected ? 0 : HANDEDNESS_SWITCH_PENALTY)

        if (score < bestScore) {
          bestScore = score
          best = hand
        }
      }

      // 两只手都缺少手腕/中指根（极端残缺结果）：退回按面积选
      picked = best ?? pickLargestHand(list)
    }

    rememberMain(picked, now)
    return picked
  }

  /** 起 Worker 并等它把模型加载完；加载失败会 reject */
  function startWorker() {
    return new Promise<void>((resolve, reject) => {
      // Worker 必须用 new URL(..., import.meta.url) 创建，Vite 靠这个静态分析去打独立产物。
      // 相对路径而不是 ~/workers/...：new URL() 里的别名解析要靠 Vite 的额外处理，相对路径是稳的。
      //
      // 故意【不加】{ type: 'module' }：加了确实能让 dev 下那个 import 报错消失，但 MediaPipe 会挂。
      // 它加载 WASM 加载器的逻辑是 `if (typeof importScripts !== 'function')` 才去
      // document.createElement('script')；模块 Worker 里 importScripts 和 document 都没有，
      // 两条路全断（报 "document is not defined"）。所以 Worker 必须是传统模式，里面也不能有 import。
      // 详见 workers/hand.worker.ts 顶部的说明。
      const instance = new Worker(new URL('../workers/hand.worker.ts', import.meta.url))

      instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data

        if (message.type === 'ready') {
          resolve()
          return
        }

        if (message.type === 'result') {
          // 先落双手结果，再跑 R4 选主手：两者必须在同一帧里同步更新，
          // 否则 CameraPreview 的 watch 可能读到「新 hands + 旧 mainHand」的组合。
          // ?? [] 兜住旧 Worker 缓存/HMR 残留的旧格式消息，避免一帧 undefined 把选主手打崩。
          const detected = message.hands ?? []

          // R6：Worker 只保证点数够 21，管不了“肉色被子/后脑勺”凑出来的假手。
          // 默认关闭（见文件顶部 R6_ENABLED）：真实 OK/捏合手型会被几何规则误杀。
          const valid = R6_ENABLED
            ? detected.filter(hand => isGeometricallyValid(hand.landmarks))
            : detected

          if (valid.length === 0) {
            busy.value = false
            if (PERF_ENABLED) noteFrameDone()
            // 推理槽必须继续转，否则一次误检会让识别永久停摆
            flushPending()

            const now = performance.now()
            // 真的没检测到手：立即清空。
            // 不要在这里“保留上一帧”等下一帧：45FPS 下保留 120ms 就是 5 帧冻结，
            // 手回来时笔迹会从旧点直接连到新点，形成一条很直的跳线。
            // 单帧漏检导致的断笔，应该在笔画层做极短的桥接，而不是冻结点位。
            if (detected.length === 0 || now - lastValidAt > STALE_HAND_GRACE_MS) {
              hands.value = []
              mainHand.value = selectMainHand([], now)
            }
            return
          }

          const now = performance.now()
          lastValidAt = now
          hands.value = valid
          mainHand.value = selectMainHand(valid, now)
          busy.value = false
          if (PERF_ENABLED) noteFrameDone()
          // 推理期间攒下的最新一帧立刻补发 —— 这一句是把有效帧率提上去的关键
          flushPending()
          return
        }

        // error 既可能出现在初始化阶段，也可能出现在后续推理中
        error.value = message.message
        busy.value = false
        // 出错就不续发待发帧，否则会一路报错刷屏
        clearPending()
        reject(new Error(message.message))
      }

      instance.onerror = (event) => {
        const text = `识别 Worker 出错：${event.message || '未知错误'}`
        error.value = text
        busy.value = false
        clearPending()
        reject(new Error(text))
      }

      worker = instance
    })
  }

  /** 加载模型。幂等：加载中或已就绪时再调直接返回 */
  async function load() {
    if (ready.value || loading.value) return

    loading.value = true
    error.value = ''

    try {
      await startWorker()
      ready.value = true
    } catch {
      // 具体原因已经写在 error 里了，这里只负责把 Worker 收干净
      close()
    } finally {
      loading.value = false
    }
  }

  /**
   * 把待发槽里最新的一帧交给 Worker。
   * 没 Worker、模型没好、或还在推理时什么都不做；onmessage 回来后会再调一次。
   */
  function flushPending() {
    if (!worker || !ready.value || busy.value) return

    const next = pending
    if (!next) return

    // 先出槽再派发：否则结果回来时会把同一帧又发一遍
    pending = null
    busy.value = true

    const request: DetectRequest = { imageBitmap: next.bitmap, timestamp: next.timestamp }
    // ImageBitmap 是 transferable：不放进 transfer 列表会走结构化克隆，反而更慢
    worker.postMessage(request, [next.bitmap])
  }

  /**
   * 丢掉待发槽里的帧。
   * ImageBitmap 必须 close：只丢引用浏览器不一定及时回收，显存会一直累积。
   */
  function clearPending() {
    if (!pending) return
    pending.bitmap.close()
    pending = null
  }

  /**
   * 提交一帧待识别画面，语义是 **latest-wins**：
   * 推理进行中时这一帧只进待发槽并覆盖更旧的一帧，Worker 回结果后立刻补发，
   * 不再像以前那样整帧丢弃（丢弃会让有效帧率从 25+ 掉到 15–20）。
   * 结果不进返回值，而是异步写进 landmarks，所以调用方要 watch 它。
   * @param imageBitmap createImageBitmap 抓到的当前帧；所有权交给 Worker 或待发槽
   * @param timestamp 用 performance.now()，必须比上一次大
   */
  function detect(imageBitmap: ImageBitmap, timestamp: number) {
    if (!worker || !ready.value) {
      // 没人会接手这一帧，自己关掉。转移给 Worker 之前 close 是有意义的
      imageBitmap.close()
      return
    }

    // 旧图晚 resolve：直接丢掉，否则会把已经排队的新图顶掉，关键点向后跳
    if (timestamp <= lastQueuedTs) {
      imageBitmap.close()
      return
    }
    lastQueuedTs = timestamp

    // 覆盖旧帧前先 close，否则旧的那张会一直占着显存
    clearPending()
    pending = { bitmap: imageBitmap, timestamp }

    // 只统计真正入队的帧（模型没就绪就 return 的那些不算，否则启动期会把丢帧率拉爆）
    if (PERF_ENABLED) perf.captures += 1

    flushPending()
  }

  /** 关掉 Worker。只关摄像头不用调，切页面或不再识别时才调 */
  function close() {
    // 槽里的帧还没送出去，Worker 一 terminate 就没人接手了，必须先 close
    clearPending()
    worker?.terminate()
    worker = null
    ready.value = false
    loading.value = false
    busy.value = false

    // 主手身份是会话级的：重开摄像头必须从零锁定，否则会拿上一次的锚点去匹配
    hands.value = []
    mainHand.value = null
    mainHandedness = null
    lastPalm = null
    lastSeenAt = 0
    lastValidAt = 0
    lastQueuedTs = 0

    // 计数器跟着会话复位：重新开摄像头要重新采样，不然 p95 会混进上一次的数据
    if (PERF_ENABLED) {
      perf.windowStart = 0
      perf.count = 0
      perf.fpsHistory.length = 0
      perf.intervals.length = 0
      perf.lastDoneAt = 0
      perf.captures = 0
      perf.done = 0
    }
  }

  // 组件销毁时自动兜底，调用方忘了调 close() 也不会漏
  onScopeDispose(close)

  return {
    landmarks,
    hands,
    mainHand,
    mainHandLabel,
    ready,
    loading,
    busy,
    error,
    load,
    detect,
    close,
    perf,
    perfSnapshot,
  }
}
