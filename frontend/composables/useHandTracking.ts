import type { DetectRequest, HandLandmark, WorkerResponse } from '~/workers/hand.worker'

export type { HandLandmark }

/**
 * 手部关键点识别（跑在 Worker 里）。
 *
 * 推理放 Worker 是为了不卡 UI：MediaPipe 一帧要几十毫秒，放主线程会明显掉帧。
 * 主线程和 Worker 的约定：主线程把当前帧抓成 ImageBitmap 转移过去，Worker 回传关键点。
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
          return
        }

        // error 既可能出现在初始化阶段，也可能出现在后续推理中
        error.value = message.message
        busy.value = false
        reject(new Error(message.message))
      }

      instance.onerror = (event) => {
        const text = `识别 Worker 出错：${event.message || '未知错误'}`
        error.value = text
        busy.value = false
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
   * 把一帧画面丢给 Worker 推理。
   * 结果不进返回值，而是异步写进 landmarks，所以调用方要 watch 它。
   * @param imageBitmap createImageBitmap(videoEl) 抓到的当前帧，所有权会转移给 Worker
   * @param timestamp 用 performance.now()，必须比上一次大
   */
  function detect(imageBitmap: ImageBitmap, timestamp: number) {
    if (!worker || !ready.value || busy.value) {
      // 没用上就把图还回去。转移之前 close 是有意义的，转移之后主线程这份已经失效
      imageBitmap.close()
      return
    }

    busy.value = true
    const request: DetectRequest = { imageBitmap, timestamp }
    // ImageBitmap 不能被结构化克隆，必须放进 transfer 列表转移所有权
    worker.postMessage(request, [imageBitmap])
  }

  /** 关掉 Worker。只关摄像头不用调，切页面或不再识别时才调 */
  function close() {
    worker?.terminate()
    worker = null
    ready.value = false
    loading.value = false
    busy.value = false
    landmarks.value = null
  }

  // 组件销毁时自动兜底，调用方忘了调 close() 也不会漏
  onScopeDispose(close)

  return { landmarks, ready, loading, busy, error, load, detect, close }
}
