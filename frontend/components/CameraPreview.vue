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

      <p
        v-if="errorMessage"
        class="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-red-600 bg-gray-200"
      >
        {{ errorMessage }}
      </p>
    </div>

    <!-- 模型/识别相关的提示单独放，不遮挡摄像头画面 -->
    <p v-if="trackingError" class="mt-2 text-sm text-amber-600">{{ trackingError }}</p>

    <div class="mt-2 flex items-center gap-2">
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

      <span v-if="isActive && !ready && !trackingError" class="text-sm text-gray-500">手部模型加载中…</span>
      <span v-else-if="isActive && ready" class="text-sm text-green-600">
        {{ landmarks ? '已识别到手' : '未检测到手' }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
const gesture = useGestureStore()

/** 手部关键点识别：ready 之前不能调 detect */
const {
  landmarks,
  ready,
  error: trackingError,
  load,
  detect,
  close,
} = useHandTracking()

/** <video> 元素，MediaStream 挂到它的 srcObject 上 */
const videoEl = ref<HTMLVideoElement | null>(null)
/** 叠在 video 上的关键点画布 */
const overlayEl = ref<HTMLCanvasElement | null>(null)
/** 当前正在使用的媒体流，关闭时要逐条 stop 掉轨道 */
const stream = ref<MediaStream | null>(null)
const isActive = ref(false)
const isStarting = ref(false)
const errorMessage = ref('')

/** requestAnimationFrame 句柄，关摄像头时必须 cancel，否则循环会一直跑 */
let rafId = 0
/** 上一帧的 video.currentTime，用来保证同一帧只推理一次 */
let lastVideoTime = -1

/** 打开摄像头：640×480 前置，不采集音频（分辨率不要调高，否则 MediaPipe 推理会慢） */
async function startCamera() {
  if (isStarting.value || isActive.value) return

  errorMessage.value = ''
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

    // 摄像头通了才开始识别：先等模型 ready，再起逐帧循环
    await startTracking()
  } catch (err) {
    releaseStream()
    errorMessage.value = describeCameraError(err)
  } finally {
    isStarting.value = false
  }
}

/** 启动识别循环。模型加载失败时 load() 内部会把错误写进 trackingError，这里直接返回 */
async function startTracking() {
  await load()

  // 等模型的这几秒里用户可能已经关了摄像头
  if (!ready.value || !isActive.value) return
  if (rafId) return

  const loop = () => {
    rafId = requestAnimationFrame(loop)
    runDetection()
  }

  rafId = requestAnimationFrame(loop)
}

/** 每一帧：同一帧不重复推理 → 推理 → 画关键点 → 把食指尖写进 store */
function runDetection() {
  const video = videoEl.value
  if (!video || !isActive.value || !ready.value) return

  // video.currentTime 没变说明还是上一帧，重复调 detectForVideo 是浪费
  if (video.currentTime === lastVideoTime) return
  lastVideoTime = video.currentTime

  const points = detect(video, performance.now())

  drawLandmarks(points)
  syncIndexFingertip(points)
}

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

  // 食指尖（索引 8）单独标红：今天画线用的就是它
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
 * 存的就是 0–1，画布那边再乘自己的 width/height，两边宽高比不一致也不会错位。
 * 检测不到手时写 null，让画布断开当前笔画。
 */
function syncIndexFingertip(points: { x: number, y: number }[] | null) {
  const indexTip = points?.[8]

  if (!indexTip) {
    gesture.setLastPoint(null)
    return
  }

  // 【临时采集代码，实验结束后删除】
  const now = performance.now()
  if (now - lastSampleTs >= SAMPLE_INTERVAL) {
    lastSampleTs = now

    if (typeof window !== 'undefined') {
      ;(window as any).__fingerTrace = (window as any).__fingerTrace || []
      ;(window as any).__fingerTrace.push({
        t: now,
        x: 1 - indexTip.x,   // 用翻转后的 x，和写进 store 的坐标保持一致
        y: indexTip.y,
      })
    }
  }

  // 摄像头画面对用户来说是镜像的：人往自己右边挥手，画面里 x 反而变小。
  // 所以写进 store 之前把 x 翻过来，和用户自己的左右方向对齐；y 上下方向没问题，不动。
  // 注意：上面 drawLandmarks() 里的关键点不能翻，那一层必须和 video 画面像素对齐。
  gesture.setLastPoint({ x: 1 - indexTip.x, y: indexTip.y })
}

/** 关闭摄像头：释放设备，并清掉上一次的错误提示 */
function stopCamera() {
  releaseStream()
  errorMessage.value = ''
}

/** 停掉识别循环，并把覆盖层上残留的关键点擦掉 */
function stopTracking() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }

  lastVideoTime = -1
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

  // 摄像头都关了，残留在 store 里的手指坐标会让画布继续画
  gesture.setLastPoint(null)
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
  stopCamera()
  // 模型占着 WASM 和显存，整个组件销毁时一起释放
  close()
})

// 暴露给父组件（第 5 天要拿 landmarks 做手势判断时直接用）
defineExpose({ videoEl, stream, isActive, landmarks, startCamera, stopCamera })
</script>
