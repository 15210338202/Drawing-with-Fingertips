import type { DetectRequest, HandLandmark, WorkerResponse } from '~/workers/hand.worker'

export type { HandLandmark }

/**
 * 性能采样开关：dev 默认开；生产环境要带 ?perf=1 才开（HUD 也只在 ?perf=1 时显示）。
 * 必须判 location 是否存在：Nuxt 默认 SSR，服务端没有 location。
 */
const PERF_ENABLED = typeof location !== 'undefined'
  && (import.meta.dev || new URLSearchParams(location.search).has('perf'))

/** 秒级样本最多留 300 条（约 5 分钟）；相邻完成帧间隔最多留 240 条（约 8 秒）—— 都是有界缓冲，长跑不会吃内存 */
const PERF_MAX_FPS_SAMPLES = 300
const PERF_MAX_INTERVALS = 240

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
  /** 21 个关键点；这一帧没检测到手时是 null */
  const landmarks = ref<HandLandmark[] | null>(null)
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
          landmarks.value = message.landmarks
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
    landmarks.value = null

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

  return { landmarks, ready, loading, busy, error, load, detect, close, perf, perfSnapshot }
}
