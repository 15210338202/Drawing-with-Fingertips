<template>
  <div class="border rounded p-4 bg-white">
    <h2 class="font-semibold">摄像头预览区</h2>

    <!-- 预览区域：固定 4:3，摄像头未开启时显示占位/错误文字 -->
    <div class="relative mt-2 w-[640px] max-w-full aspect-[4/3] bg-gray-200 flex items-center justify-center overflow-hidden rounded">
      <video
        ref="videoEl"
        width="640"
        height="480"
        autoplay
        playsinline
        muted
        class="w-full h-full object-contain bg-black"
      />

      <!-- 关键点覆盖层：盖在 video 上，尺寸和 video 一致，不接收鼠标事件 -->
      <canvas
        ref="overlayEl"
        width="640"
        height="480"
        class="absolute inset-0 w-full h-full pointer-events-none"
      />

      <!-- 性能 HUD：只在 ?perf=1 时出现，暂留作调参用，验收完再决定留还是删 -->
      <pre
        v-if="showPerf"
        class="pointer-events-none absolute right-2 top-2 z-10 rounded bg-black/70 px-2 py-1 font-mono text-[11px] leading-4 text-white whitespace-pre"
      >{{ perfText }}</pre>

      <p
        v-if="errorMessage"
        class="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-red-600 bg-gray-200"
      >
        {{ errorMessage }}
      </p>
    </div>

    <!-- 模型/识别相关的提示单独放，不遮挡摄像头画面 -->
    <p v-if="statusError" class="mt-2 text-sm text-amber-600">{{ statusError }}</p>

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button
        v-if="!isActive"
        class="px-3 py-1 bg-blue-500 text-white rounded disabled:opacity-50"
        :disabled="isStarting"
        @click="startCamera"
      >
        {{ isStarting ? '开启中…' : '开启摄像头' }}
      </button>
      <button
        v-else
        class="px-3 py-1 bg-red-500 text-white rounded"
        @click="stopCamera"
      >
        关闭摄像头
      </button>

      <span v-if="isActive && !ready && !statusError" class="text-sm text-gray-500">手部模型加载中…</span>
      <span v-else-if="isActive && ready" class="text-sm text-green-600">
        {{ landmarks ? '已识别到手' : '未检测到手' }}
      </span>

      <!-- 手势状态：调滑杆的时候靠它确认到底有没有判定成捏合 -->
      <span v-if="isActive && ready && landmarks" class="text-sm" :class="gestureState === 'drawing' ? 'text-blue-600' : 'text-gray-500'">
        {{ gestureState === 'drawing' ? '绘制中（已捏合）' : '待机：捏合开始画，握拳 1 秒清空' }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { clamp01 } from '~/utils/cursor'

const gesture = useGestureStore()

/** 手部关键点识别：推理跑在 Worker 里，结果异步写进 landmarks */
const {
  landmarks,
  ready,
  error: trackingError,
  load,
  detect,
  close,
  perfSnapshot,
} = useHandTracking()

/** 滑动平均：x、y 各自独立缓冲 */
const { smoothX, smoothY, reset: resetSmoothing } = useSmoothing()

/** 手势状态机：捏合进入绘制、松开退出、握拳清空 */
const {
  state: gestureState,
  update: updateGesture,
  onClear,
  reset: resetGesture,
} = useGesture()

// 握拳清空通过 store 计数器通知画布，不直接调 canvas 的方法，两边保持解耦
onClear(() => gesture.requestClear())

/** <video> 元素，MediaStream 挂到它的 srcObject 上 */
const videoEl = ref<HTMLVideoElement | null>(null)
/** 叠在 video 上的关键点画布 */
const overlayEl = ref<HTMLCanvasElement | null>(null)
/** 当前正在使用的媒体流，关闭时要逐条 stop 掉轨道 */
const stream = ref<MediaStream | null>(null)
const isActive = ref(false)
const isStarting = ref(false)
const errorMessage = ref('')
/** 抓帧失败（createImageBitmap 报错）的提示 */
const captureError = ref('')

/** 模板里只显示一条错误，模型错误优先 */
const statusError = computed(() => trackingError.value || captureError.value)

// ===== 性能 HUD（?perf=1 才启用）=====
// 采样本身在 useHandTracking 里跑，这里只负责每 250ms 把快照画到右上角。
// 断笔次数：绘制中手被跟丢 → 状态回 idle 且这一帧没有关键点，算一次断笔。
const showPerf = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('perf')

const perfText = ref(showPerf ? '采样中…' : '')
const brokenStrokes = ref(0)

if (showPerf) {
  watch(gestureState, (now, prev) => {
    if (prev === 'drawing' && now === 'idle' && !landmarks.value) brokenStrokes.value += 1
  })
}

/** 拼成两行文本：上面是吞吐，下面是丢帧与断笔 */
function formatPerf() {
  const stats = perfSnapshot()
  const dropPercent = (stats.dropRate * 100).toFixed(0)

  return [
    `处理FPS: ${stats.fps.toFixed(1)}  |  p95间隔: ${stats.p95Interval.toFixed(0)}ms  |  最大: ${stats.maxInterval.toFixed(0)}ms`,
    `丢帧: ${dropPercent}%  |  断笔: ${brokenStrokes.value}  |  抓帧: ${stats.captures}  处理: ${stats.done}`,
  ].join('\n')
}

let perfRafId = 0
let lastPerfPaint = 0

/** 用 rAF 而不是 setInterval：切到后台时浏览器会自动停掉，不会白算 */
function paintPerf(now: number) {
  perfRafId = requestAnimationFrame(paintPerf)
  if (now - lastPerfPaint < 250) return
  lastPerfPaint = now
  perfText.value = formatPerf()
}

onMounted(() => {
  if (!showPerf) return
  perfRafId = requestAnimationFrame(paintPerf)
})

/** requestAnimationFrame 句柄，关摄像头时必须 cancel，否则循环会一直跑 */
let rafId = 0
/** 上一帧的 video.currentTime，避免对同一帧重复推理 */
let lastVideoTime = -1
/** 上一次真正发起推理的时间 */
let lastDetectTs = 0

/**
 * 抓帧的帧率上限（推理吞吐由 Worker 决定，这里只限制「最多多久抓一帧」）。
 * 不按“每 2 帧处理一次”来卡：rAF 是跟着显示器刷新的（通常 60Hz），摄像头可能是 30 也可能是 60fps，
 * 按时间间隔卡才是稳定的 30 FPS。
 */
const MIN_FRAME_INTERVAL = 1000 / 30

/**
 * 送去推理的画面最大宽度。
 * 480 宽已经远超 MediaPipe 的模型输入，但比 640 少四成像素，
 * 解码、结构化传输、模型预处理的耗时都会跟着降；不做放大，避免画幅小时白费算力。
 */
const DETECT_MAX_WIDTH = 480

/** 打开摄像头：640×480 前置，不采集音频（分辨率不要调高，否则 MediaPipe 推理会慢） */
async function startCamera() {
  if (isStarting.value || isActive.value) return

  errorMessage.value = ''
  captureError.value = ''
  isStarting.value = true

  // file:// 或非安全上下文下 navigator.mediaDevices 直接不存在
  if (!navigator.mediaDevices?.getUserMedia) {
    errorMessage.value = '当前环境不支持摄像头采集，请用 http://localhost 或 https:// 打开页面'
    isStarting.value = false
    return
  }

  try {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    })

    stream.value = mediaStream

    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream
      // 自动播放策略或权限边界可能让 play() 失败，这里不阻断：autoplay 属性会兜底
      await videoEl.value.play().catch(() => {})
    }

    isActive.value = true

    // 摄像头通了才开始识别：先等 Worker 把模型加载完，再起逐帧循环
    await startTracking()
  } catch (err) {
    releaseStream()
    errorMessage.value = describeCameraError(err)
  } finally {
    isStarting.value = false
  }
}

/** 启动抓帧循环。模型加载失败时 load() 内部会把错误写进 trackingError，这里直接返回 */
async function startTracking() {
  await load()

  // 等模型的这几秒里用户可能已经关了摄像头
  if (!ready.value || !isActive.value) return
  if (rafId) return

  lastVideoTime = -1
  lastDetectTs = 0
  resetSmoothing()
  resetGesture()

  const loop = () => {
    rafId = requestAnimationFrame(loop)
    captureFrame()
  }

  rafId = requestAnimationFrame(loop)
}

/**
 * 每一帧：过两道闸 → 把当前帧抓成 ImageBitmap → 交给 useHandTracking。
 *
 * 「推理中丢帧」那道闸已经去掉：现在由 detect() 的单槽 latest-wins 接住，
 * 抓到的帧要么被派发、要么覆盖待发槽里的旧帧，不会被直接扔掉。
 * 结果不在这一帧回来，等 landmarks 变化后由下面的 watch 处理。
 */
function captureFrame() {
  const video = videoEl.value
  if (!video || !isActive.value || !ready.value) return

  // 闸 1：video.currentTime 没变说明还是同一帧
  if (video.currentTime === lastVideoTime) return

  // 闸 2：抓帧帧率压到 30 FPS 以内
  const now = performance.now()
  if (now - lastDetectTs < MIN_FRAME_INTERVAL) return

  lastVideoTime = video.currentTime
  lastDetectTs = now

  // 尺寸还没就绪（刚 attach 好 srcObject 的那一两帧）就先跳过，
  // 否则下面算出来的 resizeWidth 会退化成 1，白送一张 1×1 的图给模型
  if (!video.videoWidth || !video.videoHeight) return

  // 降分辨率再送推理：MediaPipe 内部本来就要缩到模型输入尺寸（224/256），
  // 640×480 原样送进去纯属浪费解码与传输。只在画幅更大时缩，不做放大。
  const scale = Math.min(1, DETECT_MAX_WIDTH / video.videoWidth)
  const resizeWidth = Math.max(1, Math.round(video.videoWidth * scale))
  const resizeHeight = Math.max(1, Math.round(video.videoHeight * scale))

  // Worker 里没有 DOM，拿不到 <video>，所以先抓成一帧位图再转移过去
  createImageBitmap(video, { resizeWidth, resizeHeight, resizeQuality: 'medium' })
    .then((bitmap) => {
      if (!isActive.value) {
        // 抓图这段时间里摄像头被关了，这张图没人接手，自己关掉
        bitmap.close()
        return
      }
      // detect() 之后可能立刻转移给 Worker，也可能先进待发槽，close 由那边统一负责
      detect(bitmap, performance.now())
    })
    .catch((err) => {
      captureError.value = `抓帧失败：${(err as Error | undefined)?.message ?? String(err)}`
    })
}

/**
 * Worker 回传的关键点到了：画到覆盖层 → 推进手势状态机 → 决定要不要写 lastPoint。
 * landmarks 是异步回来的，所以放在 watch 里，而不是发起推理的那一帧里。
 */
watch(landmarks, (points) => {
  // 摄像头已经关了但这条结果才回来：丢掉，否则画布上会多画一笔
  if (!isActive.value) return

  drawLandmarks(points)

  // 顺序不能反：syncIndexFingertip 要看这一帧更新后的手势状态
  updateGesture(points)
  syncIndexFingertip(points)
})

/** 把 21 个关键点画到覆盖层上：归一化坐标 × canvas 宽高 */
function drawLandmarks(points: { x: number, y: number }[] | null) {
  const canvas = overlayEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!points?.length) return

  ctx.fillStyle = '#22c55e'
  for (const point of points) {
    ctx.fillRect(point.x * canvas.width - 3, point.y * canvas.height - 3, 6, 6)
  }

  // 食指尖（索引 8）单独标红：画线用的就是它
  const indexTip = points[8]
  if (indexTip) {
    ctx.fillStyle = '#ef4444'
    ctx.fillRect(indexTip.x * canvas.width - 5, indexTip.y * canvas.height - 5, 10, 10)
  }
}

// 【临时采集代码，实验结束后可删除】固定 30 FPS 采样，让不同轨迹的帧数差异小很多
let lastSampleTs = 0
const SAMPLE_INTERVAL = 1000 / 30

/**
 * 食指尖的归一化坐标写进 gesture store，给 DrawingCanvas 用。
 * 存的是「镜像翻转 + 平滑后」的 0–1 坐标，画布那边再乘自己的 width/height。
 *
 * 写两个位置：
 * - hoverPoint：只要有手就写（不依赖捏合），给悬停准星跟随用；用未平滑的原始坐标，
 *   视觉平滑交给画布那边的 Lerp（那边是 60FPS 渲染，比在这里按 30FPS 平滑更跟手）；
 * - lastPoint：只有 drawing 状态才写，松手/丢手写 null 让画布断开笔画。
 */
function syncIndexFingertip(points: { x: number, y: number }[] | null) {
  const indexTip = points?.[8]

  // 悬停坐标：镜像 + 夹到 0–1（夹取只影响显示，不改落笔坐标，避免准星飘出画布）
  gesture.setHoverPoint(indexTip
    ? { x: clamp01(1 - indexTip.x), y: clamp01(indexTip.y) }
    : null)

  // 待机、手丢了、松开手指，都等于抬笔：
  // 必须写 null 断开笔画，否则画布会把上一笔的末尾和下一笔的起点连成一条长线。
  if (!indexTip || gestureState.value !== 'drawing') {
    // 顺便清空平滑缓冲，否则下一笔起点会被上一笔末尾“粘”住
    resetSmoothing()
    gesture.setLastPoint(null)
    return
  }

  // 摄像头画面对用户来说是镜像的：人往自己右边挥手，画面里 x 反而变小。
  // 先翻转再平滑——翻转是线性的，先后顺序不影响结果，但放一起更好读。
  // 注意：上面 drawLandmarks() 里的关键点不能翻，那一层必须和 video 画面像素对齐。
  const x = smoothX(1 - indexTip.x)
  const y = smoothY(indexTip.y)

  // 【临时采集代码，实验结束后删除】存的就是真正画到画布上的那个值（已翻转、已平滑）
  const now = performance.now()
  if (now - lastSampleTs >= SAMPLE_INTERVAL) {
    lastSampleTs = now

    if (typeof window !== 'undefined') {
      ;(window as any).__fingerTrace = (window as any).__fingerTrace || []
      ;(window as any).__fingerTrace.push({ t: now, x, y })
    }
  }

  gesture.setLastPoint({ x, y })
}

/** 关闭摄像头：释放设备，并清掉上一次的错误提示 */
function stopCamera() {
  releaseStream()
  errorMessage.value = ''
}

/** 停掉抓帧循环，并把覆盖层上残留的关键点擦掉 */
function stopTracking() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }

  lastVideoTime = -1
  lastDetectTs = 0
  drawLandmarks(null)
}

/**
 * 只释放设备资源，不碰错误提示。
 * 开启失败时必须走这里，否则刚写好的错误文字会被立刻清掉。
 * 它不接受任何参数，所以模板里能直接写 @click="stopCamera"，
 * 不会像带可选参数的函数那样和 PointerEvent 撞类型（TS2345）。
 */
function releaseStream() {
  stopTracking()

  stream.value?.getTracks().forEach(track => track.stop())
  stream.value = null

  if (videoEl.value) {
    videoEl.value.srcObject = null
  }

  isActive.value = false
  captureError.value = ''

  // 摄像头都关了：手势状态、平滑缓冲、残留坐标一起清掉，
  // 否则状态会卡在 drawing，重新开摄像头时画布会从旧位置继续画
  resetGesture()
  resetSmoothing()
  gesture.setLastPoint(null)
  // 准星也要跟着消失，否则会定格在画面里最后一个位置
  gesture.setHoverPoint(null)
}

/** 把 getUserMedia 的异常翻译成用户能看懂的中文提示 */
function describeCameraError(err: unknown): string {
  const name = (err as DOMException | undefined)?.name

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝，请在浏览器地址栏允许本页面使用摄像头后重试'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到可用的摄像头设备'
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用，无法读取'
    case 'OverconstrainedError':
      return '摄像头不支持 640×480 分辨率'
    case 'SecurityError':
      return '当前页面不是安全上下文，摄像头被浏览器禁用'
    default:
      return `摄像头开启失败：${(err as Error | undefined)?.message ?? String(err)}`
  }
}

// 切页面/组件卸载时一定要关流，否则摄像头指示灯会一直亮着
onBeforeUnmount(() => {
  if (perfRafId) {
    cancelAnimationFrame(perfRafId)
    perfRafId = 0
  }
  stopCamera()
  // Worker 占着 WASM 和显存，整个组件销毁时一起释放
  close()
})

// 暴露给父组件（要拿 landmarks 做手势判断时直接用）
defineExpose({ videoEl, stream, isActive, landmarks, startCamera, stopCamera })
</script>
