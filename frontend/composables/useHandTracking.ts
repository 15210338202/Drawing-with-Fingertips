import type { HandLandmarker } from '@mediapipe/tasks-vision'

/** 模型文件放在 public/models/ 下，浏览器里就是 /models/hand_landmarker.task */
const MODEL_PATH = '/models/hand_landmarker.task'

/**
 * WASM 运行时位置。
 * 优先用 public/mediapipe/wasm 下的本地副本（断网也能跑），没有就退回 CDN。
 * 想离线跑：把 node_modules/@mediapipe/tasks-vision/wasm 整个拷到 frontend/public/mediapipe/wasm。
 * CDN 上的版本号要和 package.json 里的 @mediapipe/tasks-vision 保持一致。
 */
const LOCAL_WASM_PATH = '/mediapipe/wasm'
const CDN_WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm'

/** 检测、存在、跟踪三个 confidence 阈值都设 0.5 */
const CONFIDENCE = 0.5

/** MediaPipe 返回的归一化关键点：x、y 都在 0–1（z 是相对深度，今天不用） */
export interface HandLandmark {
  x: number
  y: number
  z: number
}

export function useHandTracking() {
  /** 21 个关键点；这一帧没检测到手时是 null */
  const landmarks = ref<HandLandmark[] | null>(null)
  /** 模型是否加载完成，detect 前必须先为 true */
  const ready = ref(false)
  const loading = ref(false)
  const error = ref('')

  let landmarker: HandLandmarker | null = null
  /** 上一次传给 detectForVideo 的时间戳，用来保证严格递增 */
  let lastTimestamp = -1

  /** 本地有 WASM 就用本地，否则用 CDN */
  async function resolveWasmPath() {
    try {
      const res = await fetch(`${LOCAL_WASM_PATH}/vision_wasm_internal.js`, { method: 'HEAD' })
      if (res.ok) return LOCAL_WASM_PATH
    } catch {
      // 探测失败就当本地没有，继续走 CDN
    }
    return CDN_WASM_PATH
  }

  /** 除 delegate 之外的两套配置完全一样，抽出来避免抄两遍 */
  function optionsWith(delegate: 'GPU' | 'CPU') {
    return {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'VIDEO' as const,
      numHands: 1,
      minHandDetectionConfidence: CONFIDENCE,
      minHandPresenceConfidence: CONFIDENCE,
      minTrackingConfidence: CONFIDENCE,
    }
  }

  /** 加载模型。幂等：加载中或已就绪时再调直接返回，失败后可以再调一次重试 */
  async function load() {
    if (ready.value || loading.value) return

    loading.value = true
    error.value = ''

    try {
      // 动态 import：MediaPipe 是浏览器专用的，写在模块顶层的话 SSR 阶段就会执行
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision')

      const vision = await FilesetResolver.forVisionTasks(await resolveWasmPath())

      try {
        landmarker = await HandLandmarker.createFromOptions(vision, optionsWith('GPU'))
      } catch {
        // 没有 WebGL 或显卡不支持时降级到 CPU
        landmarker = await HandLandmarker.createFromOptions(vision, optionsWith('CPU'))
      }

      ready.value = true
    } catch (err) {
      landmarker = null
      ready.value = false
      error.value = `手部模型加载失败：${(err as Error | undefined)?.message ?? String(err)}`
    } finally {
      loading.value = false
    }
  }

  /**
   * 对一帧视频做推理。
   * @param video 正在播放的 <video>
   * @param timestamp 用 performance.now()，必须比上一次大
   * @returns 这一帧的 21 个关键点，没检测到手返回 null
   */
  function detect(video: HTMLVideoElement, timestamp: number) {
    if (!landmarker || !ready.value) return null

    // 时间戳必须递增，否则 detectForVideo 会直接抛错
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1)

    const result = landmarker.detectForVideo(video, lastTimestamp)
    // 今天只识别一只手，固定取第 0 只
    landmarks.value = result.landmarks?.[0] ?? null

    return landmarks.value
  }

  /** 释放模型资源。只关摄像头不用调它，切页面或不再识别时才调 */
  function close() {
    landmarker?.close()
    landmarker = null
    ready.value = false
    loading.value = false
    landmarks.value = null
    lastTimestamp = -1
  }

  // 组件销毁时自动兜底释放，调用方忘了调 close() 也不会漏
  onScopeDispose(close)

  return { landmarks, ready, loading, error, load, detect, close }
}
