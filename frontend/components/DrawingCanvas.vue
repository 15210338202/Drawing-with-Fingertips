<template>
  <div class="border rounded p-4 bg-white">
    <h2 class="font-semibold">画布区</h2>

    <canvas
      ref="canvasEl"
      width="800"
      height="600"
      class="mt-2 border bg-white cursor-crosshair max-w-full touch-none"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onPointerUp"
      @mouseleave="onPointerUp"
      @touchstart.prevent="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend.prevent="onPointerUp"
      @touchcancel.prevent="onPointerUp"
    />
  </div>
</template>

<script setup lang="ts">
const brush = useBrushStore()
const gesture = useGestureStore()

const canvasEl = ref<HTMLCanvasElement | null>(null)

let ctx: CanvasRenderingContext2D | null = null
/** 是否处于“按下并拖动”状态 */
let drawing = false
/** 上一个点（canvas 内部坐标系），用于和当前点连成线段 */
let lastPoint: { x: number; y: number } | null = null
/** 上一帧食指尖的位置（canvas 内部坐标），手势画线靠它连成线段 */
let lastGesturePoint: { x: number; y: number } | null = null

onMounted(() => {
  ctx = canvasEl.value?.getContext('2d') ?? null
  if (!ctx) return

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
})

/**
 * 食指尖坐标一变就画一段线。
 * CameraPreview 存的是按视频画面归一化的 0–1 坐标，这里乘画布自身宽高重新映射，
 * 所以画布和视频宽高比不一样也不会错位。
 */
watch(() => gesture.lastPoint, (point) => {
  const canvas = canvasEl.value
  if (!ctx || !canvas) return

  // 手离开画面：断开笔画，下次重新起笔
  if (!point) {
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
}

defineExpose({ clear })
</script>
