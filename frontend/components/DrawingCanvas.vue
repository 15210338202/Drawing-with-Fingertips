<template>
  <div class="border rounded p-4 bg-white">
    <h2 class="font-semibold">画布区</h2>

    <!-- 引导层要和画布像素级对齐，所以两层必须叠在同一个盒子里 -->
    <div class="relative mt-2 w-[800px] max-w-full">
      <canvas
        ref="canvasEl"
        width="800"
        height="600"
        class="block w-full border bg-white cursor-crosshair touch-none"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onPointerUp"
        @mouseleave="onPointerUp"
        @touchstart.prevent="onTouchStart"
        @touchmove.prevent="onTouchMove"
        @touchend.prevent="onPointerUp"
        @touchcancel.prevent="onPointerUp"
      />

      <!-- 【实验引导线，实验结束后删除】只当采集参照，pointer-events-none 不挡鼠标画线 -->
      <canvas
        ref="guideEl"
        width="800"
        height="600"
        class="absolute inset-0 w-full h-full pointer-events-none opacity-20"
      />

      <!-- 生成结果：先盖在上面给用户看，点「贴回画布」才真正画进去 -->
      <div
        v-if="agent.generatedImage"
        class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-4"
      >
        <img
          :src="agent.generatedImage"
          alt="生成结果"
          class="max-h-[75%] max-w-full rounded object-contain"
        />

        <p v-if="pasteError" class="max-w-full text-center text-xs text-amber-300">{{ pasteError }}</p>

        <div class="flex gap-2">
          <button
            class="rounded bg-blue-500 px-3 py-1 text-sm text-white disabled:opacity-50"
            :disabled="pasting"
            @click="pasteGenerated"
          >
            {{ pasting ? '贴回中...' : '贴回画布' }}
          </button>
          <button
            class="rounded border border-white/60 px-3 py-1 text-sm text-white"
            @click="closeGenerated"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const brush = useBrushStore()
const gesture = useGestureStore()
const agent = useAgentStore()

const canvasEl = ref<HTMLCanvasElement | null>(null)
/** 【实验引导线，实验结束后删除】参照层，clear() 不会碰它 */
const guideEl = ref<HTMLCanvasElement | null>(null)

/** 贴回画布时的报错提示（比如生成图有跨域限制，画不进 canvas） */
const pasteError = ref('')
const pasting = ref(false)

let ctx: CanvasRenderingContext2D | null = null
/** 是否处于“按下并拖动”状态 */
let drawing = false
/** 上一个点（canvas 内部坐标系），用于和当前点连成线段 */
let lastPoint: { x: number; y: number } | null = null
/** 上一帧食指尖的位置（canvas 内部坐标），手势画线靠它连成线段 */
let lastGesturePoint: { x: number; y: number } | null = null

onMounted(() => {
  // 把导出方法挂到 store 上：useAgent 在 AgentPanel 里跑，拿不到这里的模板 ref。
  // 必须放在下面那个提前 return 之前，否则 canvas 没就绪时桥就断了。
  agent.setSketchExporter(exportSketch)

  ctx = canvasEl.value?.getContext('2d') ?? null
  if (!ctx) return

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  drawGuide()
})

onBeforeUnmount(() => {
  agent.setSketchExporter(null)
})

/**
 * 导出草图的放大目标高度。
 * 图像 API 对输入尺寸有下限（高 ≥ 512），导出时统一放大到这个高度更稳妥。
 */
const EXPORT_TARGET_HEIGHT = 768

/**
 * 导出当前草图（PNG dataURL），供 /api/generate 使用。
 *
 * 三个要点：
 * 1. 新建临时 canvas 先铺白底再画上去 —— 画布本身是透明的，直接 toDataURL 出来的 PNG
 *    透明区在图像 API 那边会变成黑色。
 * 2. 等比放大到高度 EXPORT_TARGET_HEIGHT：画布是 800×600，放大后是 1024×768，
 *    max(1, …) 保证只在高度不足时才放大，原图本来就大就不动它，避免无谓重采样。
 * 3. 引导层是独立的 canvas，不会被导出。
 */
function exportSketch() {
  const source = canvasEl.value
  if (!source) return null

  const scale = Math.max(1, EXPORT_TARGET_HEIGHT / source.height)

  const out = document.createElement('canvas')
  out.width = Math.round(source.width * scale)
  out.height = Math.round(source.height * scale)

  const outCtx = out.getContext('2d')
  if (!outCtx) return null

  outCtx.fillStyle = '#ffffff'
  outCtx.fillRect(0, 0, out.width, out.height)
  // 直接给目标尺寸，让浏览器一次完成缩放，不要分两步画
  outCtx.drawImage(source, 0, 0, out.width, out.height)

  return out.toDataURL('image/png')
}

/** 关掉生成结果浮层，画布保持原样 */
function closeGenerated() {
  pasteError.value = ''
  agent.setGeneratedImage(null)
}

/**
 * 把生成图贴回画布。
 * 贴上去是 drawImage 而不是替换画布，用户之后还能继续在上面画。
 */
async function pasteGenerated() {
  const src = agent.generatedImage
  const canvas = canvasEl.value
  if (!src || !ctx || !canvas) return

  pasting.value = true
  pasteError.value = ''

  try {
    const image = await loadImage(src)

    // 按比例缩放居中：生成图尺寸和画布多半不一样，硬拉会变形
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale
    const height = image.height * scale

    ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)

    agent.setHasSketch(true)
    agent.setGeneratedImage(null)
  } catch (err) {
    console.error('[canvas] 贴回失败：', err)
    pasteError.value = '这张图贴不进画布（多半是跨域限制），可以先右键另存，或让服务端转存后再试'
  } finally {
    pasting.value = false
  }
}

/**
 * 加载图片。
 * 上游给的 https 图直接画进 canvas 会污染画布，之后 toDataURL 会抛安全错误，
 * 所以先 fetch 成 dataURL 再用；跨域不允许时抛错，由调用方提示用户。
 */
async function loadImage(src: string) {
  const dataUrl = src.startsWith('data:') ? src : await toDataUrl(src)

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function toDataUrl(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`拉取生成图失败：HTTP ${response.status}`)

  const blob = await response.blob()

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片转 dataURL 失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 【实验引导线，实验结束后删除】
 * 每次采一组前只留一条：把另外两条注释掉，手沿着留下的那条画。
 * 坐标用的是画布内部坐标系（800×600），和真实笔迹同一个参考系。
 */
function drawGuide() {
  const guide = guideEl.value?.getContext('2d')
  if (!guide) return

  /**
   * 三条引导线共用的样式。
   * 抽成函数是为了切换图形时不用手动搬样式——否则取消注释圆的时候，
   * 画笔会还是上一条线的 #ccc / lineWidth 3，画出来又细又浅。
   */
  const baseStyle = () => {
    guide.strokeStyle = '#aaa'   // 浅灰，不抢视线
    guide.lineWidth = 8          // 从 3 加粗到 8
    guide.lineCap = 'round'
  }

  // ===== 每次采一组前只留一条：把不用的那两条注释掉 =====

  // 1. 水平线：y = 300
  baseStyle()

  // 主线：x 从 120 到 680，占画布宽的 70%
  guide.beginPath()
  guide.moveTo(120, 300)
  guide.lineTo(680, 300)
  guide.stroke()

  // 起笔区：左端一个小圆，提示从这里开始
  guide.fillStyle = '#ccc'
  guide.beginPath()
  guide.arc(120, 300, 20, 0, Math.PI * 2)
  guide.fill()

  // 终点区：右端一个方框，线正好落在它中心
  guide.strokeStyle = '#ccc'
  guide.lineWidth = 3
  guide.strokeRect(660, 280, 40, 40)

  // 2. 圆：圆心 (400,300)，半径 150
  // baseStyle()
  // guide.beginPath(); guide.arc(400, 300, 150, 0, Math.PI * 2); guide.stroke()

  // 3. 字母 S：两个半圆拼起来
  // baseStyle()
  // guide.beginPath(); guide.arc(400, 220, 80, Math.PI * 0.5, Math.PI * 1.5); guide.stroke()
  // guide.beginPath(); guide.arc(400, 380, 80, Math.PI * 1.5, Math.PI * 0.5); guide.stroke()
}

/**
 * 食指尖坐标一变就画一段线。
 * CameraPreview 存的是按视频画面归一化的 0–1 坐标，这里乘画布自身宽高重新映射，
 * 所以画布和视频宽高比不一样也不会错位。
 */
watch(() => gesture.lastPoint, (point) => {
  const canvas = canvasEl.value
  if (!ctx || !canvas) return

  // 手离开画面、或还没进入绘制状态：断开笔画，下次重新起笔。
  // 状态不是 drawing 时也断开：CameraPreview 会把 lastPoint 置空，但抬笔那一帧两者可能
  // 先后到达，这里兜一层，免得画出一条横贯画布的长线。
  if (!point || gesture.state !== 'drawing') {
    lastGesturePoint = null
    return
  }

  const current = { x: point.x * canvas.width, y: point.y * canvas.height }

  if (lastGesturePoint) {
    strokeSegment(lastGesturePoint, current)
  }

  lastGesturePoint = current
})

/**
 * 握拳清空：useGesture 触发后 CameraPreview 会把 store 里的计数器 +1，这里监听到变化就清画布。
 * 【坑】必须写成 watch(() => gesture.clearRequested, ...)：直接传 gesture.clearRequested
 * 只是把当时那个数字当快照传进去，之后计数器再怎么变都不会再触发。
 * AI 的 clear 动作走的也是这条通路。
 */
watch(() => gesture.clearRequested, () => {
  clear()
})

/**
 * 把屏幕坐标换算成 canvas 内部坐标。
 * canvas 的 CSS 尺寸和 width/height 像素尺寸可能不一致，必须按比例换算。
 */
function toCanvasPoint(clientX: number, clientY: number) {
  const canvas = canvasEl.value
  if (!canvas) return { x: 0, y: 0 }

  const rect = canvas.getBoundingClientRect()

  return {
    x: (clientX - rect.left) / rect.width * canvas.width,
    y: (clientY - rect.top) / rect.height * canvas.height,
  }
}

/** 在两个 canvas 坐标点之间连一条线段；颜色和粗细每次现读 store，改了立刻生效 */
function strokeSegment(from: { x: number; y: number }, to: { x: number; y: number }) {
  if (!ctx) return

  // 画布上落墨了：/api/agent 的 context.hasSketch 靠这个标记
  agent.setHasSketch(true)

  ctx.strokeStyle = brush.color
  ctx.lineWidth = brush.size

  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
}

/** 落笔：画一个圆点，保证“单击”也能留下痕迹 */
function startStroke(clientX: number, clientY: number) {
  if (!ctx) return

  const point = toCanvasPoint(clientX, clientY)

  drawing = true
  lastPoint = point

  // 单击留下的这个点也算画布有内容
  agent.setHasSketch(true)

  ctx.fillStyle = brush.color
  ctx.beginPath()
  ctx.arc(point.x, point.y, brush.size / 2, 0, Math.PI * 2)
  ctx.fill()
}

/** 拖动：从上一个点连一条线段到当前点 */
function continueStroke(clientX: number, clientY: number) {
  if (!drawing || !lastPoint) return

  const point = toCanvasPoint(clientX, clientY)

  strokeSegment(lastPoint, point)

  lastPoint = point
}

function onMouseDown(event: MouseEvent) {
  startStroke(event.clientX, event.clientY)
}

function onMouseMove(event: MouseEvent) {
  continueStroke(event.clientX, event.clientY)
}

function onTouchStart(event: TouchEvent) {
  const touch = event.touches[0]
  if (!touch) return

  startStroke(touch.clientX, touch.clientY)
}

function onTouchMove(event: TouchEvent) {
  const touch = event.touches[0]
  if (!touch) return

  continueStroke(touch.clientX, touch.clientY)
}

/** 松手/移出画布都要结束当前笔画，否则鼠标在画布外松开后会一直画 */
function onPointerUp() {
  drawing = false
  lastPoint = null
}

/** 清空画布，供父组件通过模板 ref 调用 */
function clear() {
  const canvas = canvasEl.value
  if (!ctx || !canvas) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  drawing = false
  lastPoint = null
  lastGesturePoint = null

  // 画布空了，告诉 AI 现在没有草图可参考
  agent.setHasSketch(false)
}

defineExpose({ clear, exportSketch })
</script>
