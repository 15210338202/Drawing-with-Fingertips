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

/**
 * R6 三级过滤的第一层：模型侧置信度。
 *
 * - detection / presence 从 0.5 提到 0.6：先砍掉低质量的“疑似手”，
 *   否则第二只手会频繁以半只手的形态闪进闪出，主手最近邻匹配会被带着跳。
 * - tracking 反而降到 0.4：tracking 掉到 0.6 以下时 MediaPipe 会丢弃上一帧的跟踪状态，
 *   侧手/快速移动时特别容易“丢手 → 重新检测 → 标签翻转”。放宽它，宁可多跟几帧。
 */
const DETECTION_CONFIDENCE = 0.6
const PRESENCE_CONFIDENCE = 0.6
const TRACKING_CONFIDENCE = 0.4

/** 最多同时检测两只手：一只手画画，另一只手留给后续的辅助手势 */
const MAX_HANDS = 2

/** 归一化的关键点：x、y 在 0–1，z 是相对深度（2D 结果里只用于调试） */
export interface HandLandmark {
  x: number
  y: number
  z: number
}

/** MediaPipe 输出的左右手标签；模型给不出时归为 Unknown */
export type Handedness = 'Left' | 'Right' | 'Unknown'

/**
 * 一只手的完整结果。
 *
 * landmarks      → 2D 归一化坐标。画布、准星、覆盖层、R7 透视校正**只准用它**。
 * worldLandmarks → 3D 世界坐标（米，原点在手掌中心）。
 *                  侧手/自遮挡时深度会漂，当前只作诊断，不参与捏合判定；
 *                  画布、准星、覆盖层仍然只准用 landmarks。
 */
export interface DetectedHand {
  /** 21 个 2D 归一化关键点 */
  landmarks: HandLandmark[]
  /** 21 个 3D 世界坐标关键点；模型异常时可能为 null，调用方要兜底 */
  worldLandmarks: HandLandmark[] | null
  /** 模型判定的左右手；前端只用它做身份标签，不用于显示语义 */
  handedness: Handedness
  /** 左右手分类置信度，主手初始选择时作为第二排序依据 */
  handednessScore: number
}

/** 主线程 → Worker */
export interface DetectRequest {
  imageBitmap: ImageBitmap
  timestamp: number
}

/** Worker → 主线程 */
export type WorkerResponse =
  | { type: 'ready' }
  /** 这一帧检测到的所有手（0–2 只），按 MediaPipe 的输出顺序 */
  | { type: 'result', hands: DetectedHand[] }
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
    // 关键：从 1 改成 2。双手模式下推理耗时会上涨，
    // 但主线程的 latest-wins 单槽会自然把有效帧率稳定在 Worker 的吞吐上。
    numHands: MAX_HANDS,
    minHandDetectionConfidence: DETECTION_CONFIDENCE,
    minHandPresenceConfidence: PRESENCE_CONFIDENCE,
    minTrackingConfidence: TRACKING_CONFIDENCE,
  }
}

/** MediaPipe 的 categoryName 是 string，这里收窄成前端约定的三种值 */
function normalizeHandedness(name: string | undefined): Handedness {
  return name === 'Left' || name === 'Right' ? name : 'Unknown'
}

/**
 * 把一帧的 MediaPipe 结果整理成主线程需要的结构。
 *
 * 注意 handedness 字段：新版包同时提供 `handedness`（推荐）和 `handednesses`（已废弃）。
 * 这里优先用新字段，再退回旧字段，避免 CDN 上不同小版本之间出现 undefined。
 */
function toDetectedHands(result: {
  landmarks?: HandLandmark[][]
  worldLandmarks?: HandLandmark[][]
  handedness?: { categoryName: string, score: number }[][]
  handednesses?: { categoryName: string, score: number }[][]
}): DetectedHand[] {
  const hands: DetectedHand[] = []
  const landmarksList = result.landmarks ?? []
  const worldList = result.worldLandmarks ?? []
  const categoriesList = result.handedness ?? result.handednesses ?? []

  for (let index = 0; index < landmarksList.length; index++) {
    const landmarks = landmarksList[index]
    // 正常一定是 21 个点；残缺结果直接丢，免得下游数组越界读到半个手掌
    if (!landmarks || landmarks.length < 21) continue

    const category = categoriesList[index]?.[0]

    hands.push({
      landmarks,
      worldLandmarks: worldList[index] ?? null,
      handedness: normalizeHandedness(category?.categoryName),
      handednessScore: category?.score ?? 0,
    })
  }

  return hands
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

    // R3 + R4：2D 给画布/准星/捏合，3D 只作诊断，handedness 给主手身份维持。
    // 没检测到手时也回一个空数组 —— 主线程靠这一帧做「丢手」计时。
    post({ type: 'result', hands: toDetectedHands(result) })
  } catch (err) {
    post({ type: 'error', message: `推理失败：${errorText(err)}` })
  } finally {
    // bitmap 的所有权已经转移到这里了，用完必须 close，否则显存会一直涨
    imageBitmap.close()
  }
}

void init()
