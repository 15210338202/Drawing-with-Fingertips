/**
 * 手部关键点识别 Worker。
 *
 * ⚠️ 这个文件里不能有运行时 import/export，只有 `import type` 可以（编译期会被抹掉）。
 * 两条原因：
 *
 * 1. Vite 只有 build 时才把 Worker 打成独立产物；dev 下它只是把 .ts 转成 .js 直接丢给浏览器。
 *    传统 Worker 拿到带 ESM import 的脚本就会报
 *    "Cannot use import statement outside a module"。
 * 2. MediaPipe 加载 WASM 加载器的逻辑是：
 *      if (typeof importScripts !== 'function') { document.createElement('script') }
 *      else { importScripts(...) }
 *    模块 Worker 里 importScripts 和 document 都没有，两条路全断（报 "document is not defined"）。
 *    所以 Worker 必须是传统模式。
 *
 * 结论：MediaPipe 用 importScripts 加载它的 IIFE 版本（vision_bundle.js，执行后挂全局 Vision），
 * 而不是让打包器把它当成模块 import 进来——dev 下 Vite 会往那个文件里注入 ESM 语句，importScripts 会挂。
 */

import type { HandLandmarker } from '@mediapipe/tasks-vision'

/** 模型文件放在 public/models/ 下 */
const MODEL_PATH = '/models/hand_landmarker.task'

/**
 * 两份运行时资源的地址，都是「本地优先、CDN 兜底」。
 * 想彻底离线：把 node_modules/@mediapipe/tasks-vision 下的 wasm 目录拷到 public/wasm，
 * 再把 vision_bundle.js 拷到 public/vendor/，代码不用改。
 */
const LOCAL_WASM_PATH = '/wasm'
const CDN_WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm'
const LOCAL_BUNDLE_PATH = '/vendor/vision_bundle.js'
const CDN_BUNDLE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/vision_bundle.js'

/** 检测、存在、跟踪三个 confidence 阈值都设 0.5 */
const CONFIDENCE = 0.5

/** 归一化的关键点：x、y 在 0–1（z 是相对深度，今天不用） */
export interface HandLandmark {
  x: number
  y: number
  z: number
}

/** 主线程 → Worker */
export interface DetectRequest {
  imageBitmap: ImageBitmap
  timestamp: number
}

/** Worker → 主线程 */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'result', landmarks: HandLandmark[] | null }
  | { type: 'error', message: string }

/** MediaPipe 传统脚本版挂出来的全局对象，类型直接借用 npm 包的声明 */
type VisionApi = typeof import('@mediapipe/tasks-vision')

/**
 * Worker 里没有 window，self 就是 DedicatedWorkerGlobalScope。
 * 这里不引 webworker 类型库（会和项目里的 DOM 类型互相冲突），手写一个最小接口。
 * importScripts 是传统 Worker 独有的，模块 Worker 里没有。
 */
const workerScope = self as unknown as {
  postMessage: (message: WorkerResponse) => void
  onmessage: ((event: MessageEvent<DetectRequest>) => void) | null
  importScripts: (...urls: string[]) => void
  Vision?: VisionApi
}

let landmarker: HandLandmarker | null = null
let ready = false
/** 上一次传给 detectForVideo 的时间戳，必须严格递增 */
let lastTimestamp = -1

function post(message: WorkerResponse) {
  workerScope.postMessage(message)
}

function errorText(err: unknown) {
  return (err as Error | undefined)?.message ?? String(err)
}

/** 本地放了一份就用本地，否则用 CDN */
async function resolveBundleUrl() {
  try {
    const res = await fetch(LOCAL_BUNDLE_PATH, { method: 'HEAD' })
    if (res.ok) return LOCAL_BUNDLE_PATH
  } catch {
    // 探测失败就当本地没有，继续走 CDN
  }
  return CDN_BUNDLE_URL
}

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

/**
 * 用 importScripts 加载 MediaPipe 的传统脚本版。
 * 它是个 IIFE，执行完会在全局挂出 Vision（Vision.FilesetResolver / Vision.HandLandmarker）。
 */
function loadVision(bundleUrl: string): VisionApi {
  workerScope.importScripts(bundleUrl)

  const vision = workerScope.Vision
  if (!vision) throw new Error('vision_bundle.js 已加载，但全局没有 Vision')

  return vision
}

/** 除 delegate 之外两套配置完全一样，抽出来避免抄两遍 */
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

/** Worker 一启动就加载模型，好了主动通知主线程 */
async function init() {
  try {
    const vision = loadVision(await resolveBundleUrl())

    const fileset = await vision.FilesetResolver.forVisionTasks(await resolveWasmPath())

    try {
      landmarker = await vision.HandLandmarker.createFromOptions(fileset, optionsWith('GPU'))
    } catch {
      // Worker 里通常没有 WebGL，直接降级到 CPU
      landmarker = await vision.HandLandmarker.createFromOptions(fileset, optionsWith('CPU'))
    }

    ready = true
    post({ type: 'ready' })
  } catch (err) {
    post({ type: 'error', message: `手部模型加载失败：${errorText(err)}` })
  }
}

workerScope.onmessage = (event) => {
  const { imageBitmap, timestamp } = event.data

  if (!landmarker || !ready) {
    // 模型还没好也得把这张图还回去，不然显存一直占着
    imageBitmap.close()
    return
  }

  try {
    // 时间戳必须递增，否则 detectForVideo 直接抛错
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1)

    const result = landmarker.detectForVideo(imageBitmap, lastTimestamp)
    // 今天只识别一只手，固定取第 0 只
    post({ type: 'result', landmarks: result.landmarks?.[0] ?? null })
  } catch (err) {
    post({ type: 'error', message: `推理失败：${errorText(err)}` })
  } finally {
    // bitmap 的所有权已经转移到这里了，用完必须 close，否则显存会一直涨
    imageBitmap.close()
  }
}

void init()
