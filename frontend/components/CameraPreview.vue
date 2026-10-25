<template>
  <div class="camera-preview rounded-card border border-line bg-surface p-4 shadow-soft">
    <h2 class="font-semibold">摄像头预览区</h2>

    <!-- 预览区域：宽高比跟随真实画幅（而不是写死 4:3），否则 object-contain 会加黑边、
         红点和关键点覆盖层就跟画面内容错位 -->
    <div
      class="relative mt-2 flex w-full items-center justify-center overflow-hidden rounded bg-surface-2 transition-shadow duration-200"
      :class="thumbsUpFlash ? 'ring-4 ring-sage/40' : ''"
      :style="{ aspectRatio: String(gesture.cameraAspect || 4 / 3) }"
    >
      <!-- 画面镜像：摄像头看到的是"对面的人"，不镜像时用户往右挥手、画面里往左动，
           而准星和笔迹用的是镜像坐标（1−x）。不镜像的话三者朝向不一致，
           标定红点会落在手的反侧，永远停不中。 -->
      <video
        ref="videoEl"
        width="640"
        height="480"
        autoplay
        playsinline
        muted
        class="w-full h-full object-contain bg-black"
        style="transform: scaleX(-1)"
        @loadedmetadata="syncCameraAspect"
      />

      <!-- 关键点覆盖层：盖在 video 上，尺寸和 video 一致，不接收鼠标事件 -->
      <canvas
        ref="overlayEl"
        width="640"
        height="480"
        class="absolute inset-0 w-full h-full pointer-events-none"
      />

      <!-- 标定模式：四个靶点依次点亮，食指停在上面半秒即采集。
           靶点用百分比定位，和 video 的等比缩放自动对齐。 -->
      <template v-if="calibrating">
        <div
          v-for="(target, index) in CALIBRATION_TARGETS"
          :key="index"
          class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          :style="{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }"
        >
          <div
            class="h-6 w-6 rounded-full border-2 border-white transition-transform duration-150"
            :class="[
              index < capturedCount ? 'scale-125 bg-sage' : 'bg-peach',
              index === activeTarget && index >= capturedCount ? 'scale-150 ring-4 ring-sage/25' : '',
            ]"
          />
          <!-- 停留进度：宽度 500ms 线性变化，正好对上 DWELL_MS，不需要每帧算 -->
          <div v-if="index === activeTarget && index >= capturedCount" class="mt-1 h-0.5 w-6 overflow-hidden rounded bg-white/40">
            <div
              class="h-full bg-sage transition-[width] duration-500 ease-linear"
              :class="dwellActive ? 'w-full' : 'w-0'"
            />
          </div>
        </div>

        <div class="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs font-medium text-white drop-shadow">
          把食指移到圆点上停半秒，依次完成 4 个点（{{ capturedCount }}/4）
        </div>
      </template>

      <!-- 性能 HUD：只在 ?perf=1 时出现，暂留作调参用，验收完再决定留还是删 -->
      <pre
        v-if="showPerf"
        class="pointer-events-none absolute right-2 top-2 z-10 rounded bg-black/70 px-2 py-1 font-mono text-[11px] leading-4 text-white whitespace-pre"
      >{{ perfText }}</pre>

      <p
        v-if="errorMessage"
        class="absolute inset-0 flex items-center justify-center bg-surface-2 px-4 text-center text-sm text-danger"
      >
        {{ errorMessage }}
      </p>
    </div>

    <!-- 模型/识别相关的提示单独放，不遮挡摄像头画面 -->
    <p v-if="statusError" class="mt-2 text-sm text-amber-600">{{ statusError }}</p>

    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button
        v-if="!isActive"
        class="min-h-10 rounded-full bg-sage px-3.5 text-sm font-medium text-white transition-colors hover:bg-sage-strong disabled:opacity-50"
        :disabled="isStarting"
        @click="startCamera"
      >
        {{ isStarting ? '开启中…' : '开启摄像头' }}
      </button>
      <button
        v-else
        class="min-h-10 rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
        @click="stopCamera"
      >
        关闭摄像头
      </button>

      <span v-if="isActive && !ready && !statusError" class="text-sm text-muted">手部模型加载中…</span>
      <span v-else-if="isActive && ready" class="text-sm text-sage">
        {{ hands.length === 0 ? '未检测到手' : hands.length > 1 ? `已识别到 ${hands.length} 只手（自动锁定主手）` : '已识别到手' }}
      </span>

      <!-- 手势状态：调滑杆的时候靠它确认到底有没有判定成捏合 -->
      <span v-if="isActive && ready && landmarks" class="text-sm" :class="gestureState === 'drawing' ? 'text-sage' : 'text-muted'">
        {{ gestureState === 'drawing' ? '绘制中（已捏合）' : '待机：捏合画，握拳清空，👍 生成' }}
      </span>

      <!-- 状态机确认前就先给个提示，用户能知道“比对了、再保持一下” -->
      <span v-if="isActive && ready && thumbsUp" class="text-sm text-sage-strong">
        👍 已识别，保持一下…
      </span>

      <!-- 透视校正：4 点标定，解决边缘画线变歪 / 斜向漂移。
           不能加 :disabled="!landmarks"：手一离开画面（比如伸手去握鼠标）按钮就变灰，
           点了完全没反应，看起来像坏了。标定本身允许先点开、再把手放回画面。 -->
      <button
        v-if="isActive && ready && !calibrating"
        class="rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink transition-colors hover:bg-surface-2"
        @click="startCalibration"
      >
        标定
      </button>
      <button
        v-if="calibrating"
        class="rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink transition-colors hover:bg-surface-2"
        @click="cancelCalibration"
      >
        取消标定
      </button>
      <!-- 标定中的即时反馈：能看出「点击生效了没有」以及「系统当前认不认得到手」，
           这两条正好覆盖「点了没反应」的两种最常见原因 -->
      <span v-if="calibrating" class="text-sm text-sage">
        标定中 {{ Math.min(capturedCount + 1, 4) }}/4 · {{ landmarks ? '已识别到手' : '未检测到手' }}
      </span>
      <template v-if="calibration.calibrated && !calibrating">
        <span class="rounded-full bg-sage-soft px-2 py-1 text-xs text-sage-strong">已标定</span>
        <button class="text-xs text-muted underline" @click="clearCalibration">清除标定</button>
      </template>
    </div>

    <!-- 标定失败/成功的提示 -->
    <p v-if="calibrationError" class="mt-2 text-sm text-danger">{{ calibrationError }}</p>
  </div>
</template>

<script setup lang="ts">
import { clamp01 } from '~/utils/cursor'
import { CALIBRATION_TARGETS, createDwellState, stepDwell } from '~/utils/calibration'
import type { DwellState } from '~/utils/calibration'
import { applyHomography, computeHomography, validateHomography } from '~/utils/homography'
import type { Point } from '~/utils/homography'
import type { DetectedHand } from '~/workers/hand.worker'
// 显式导入 store，不依赖 Pinia 的目录扫描：新加的 store 文件需要重启 dev server 才会被自动导入，
// 否则 useCalibrationStore 是 undefined，整个组件 setup 直接抛错（表现为按钮点了没反应）
import { useCalibrationStore } from '~/stores/calibration'
import { useAgentStore } from '~/stores/agent'
import { useAppStore } from '~/stores/app'
import { useUIStore } from '~/stores/ui'
import { useTTS } from '~/composables/useTTS'
import { OneEuroFilter } from '~/utils/oneEuroFilter'

const gesture = useGestureStore()
const calibration = useCalibrationStore()
const agent = useAgentStore()
const app = useAppStore()
const ui = useUIStore()
const { runAction } = useAgent()
const { speak, stop: stopSpeaking } = useTTS()

/**
 * 手部关键点识别：推理跑在 Worker 里，结果异步写进 hands / mainHand。
 * - hands：本帧全部手（用于覆盖层把所有手都画出来）
 * - mainHand：R4 选出的主手（手势、笔迹、准星只认它）
 * - landmarks：mainHand 的 2D 关键点（兼容原有调用与模板状态）
 */
const {
  landmarks,
  hands,
  mainHand,
  ready,
  error: trackingError,
  load,
  detect,
  close,
  perfSnapshot,
} = useHandTracking()

/**
 * R5：食指尖的 One Euro Filter，x/y 各一个实例。
 *
 * 这里的坐标是 0–1 的归一化坐标，速度数值比“像素/秒”小约 1000 倍；
 * beta 按屏幕宽度 1000px 换算，快速移动时才把截止频率抬起来。
 *
 * minCutoff 从 1.2 提到 3.0：30FPS 下 1.2 的阶跃响应 90% 要 10 帧（约 330ms），
 * 画线会明显“追着手指尾巴走”。3.0 仍然是平滑滤波，但 90% 约 4–5 帧，
 * 先把响应换回来；如果静止时抖动明显，再把 minCutoff 往 2.4 回调。
 */
const ONE_EURO_MIN_CUTOFF = 3
const ONE_EURO_BETA = 12
const xFilter = new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA)
const yFilter = new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA)
/** 上一帧是否在 drawing：只在上升沿清滤波，避免每帧都清掉平滑 */
let wasDrawing = false

/** 清空滤波历史：抬笔、丢手、换主手、关摄像头时用 */
function resetSmoothing() {
  xFilter.reset()
  yFilter.reset()
}

/** 同一帧的 x/y 必须用同一个时间戳，否则两个轴的自适应速度会不同步 */
function smoothPoint(point: Point): Point {
  const now = performance.now()
  return {
    x: xFilter.filter(point.x, now),
    y: yFilter.filter(point.y, now),
  }
}

/** 手势状态机：捏合进入绘制、松开退出、握拳清空 */
const {
  state: gestureState,
  update: updateGesture,
  onClear,
  onThumbsUp,
  thumbsUp,
  reset: resetGesture,
} = useGesture()

// 握拳清空通过 store 计数器通知画布，不直接调 canvas 的方法，两边保持解耦
onClear(() => gesture.requestClear())

// 👍 的“业务”放在这里：状态机只负责确认“用户确实比了一个 👍”，
// 具体用哪张画、哪个风格、要不要防重入，都是页面这层的事。
onThumbsUp(() => { void handleThumbsUp() })

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

// ===== 👍 → 生图 =====
/** 触发瞬间给预览框加一圈绿光；文字提示统一走页面顶部的 GestureNotice */
const thumbsUpFlash = ref(false)
/** 防重入：runAction 直接调 generate_image 时不会设置 agent.executing，得自己锁 */
const generatingByThumbsUp = ref(false)
let thumbsUpFlashTimer: ReturnType<typeof setTimeout> | null = null

/** 提示放在页面顶部中央，摄像头收起/关闭后仍然看得见 */
function showThumbsUpNotice(
  text: string,
  tone: 'info' | 'success' | 'warn' | 'error' = 'info',
  autoClearMs = 4000,
) {
  ui.showGestureNotice(text, tone, autoClearMs)
}

function flashThumbsUp() {
  thumbsUpFlash.value = true
  if (thumbsUpFlashTimer) clearTimeout(thumbsUpFlashTimer)
  thumbsUpFlashTimer = setTimeout(() => {
    thumbsUpFlash.value = false
  }, 1200)
}

/**
 * 👍 之前如果还没看过图，先补一次风格分析。
 *
 * 之前只把“不传 styleKey”当成“会用 AI 推荐”，但没点过“让 AI 猜猜”时
 * currentSuggestions 是空的，generate_image 只能退回第一条风格（水墨），
 * 所以手势生成永远像国风。这里先静默拿一次推荐，再走原来的生成链路。
 */
async function ensureStyleSuggestions(): Promise<boolean> {
  if (agent.currentSuggestions.length) return true

  try {
    await runAction({ tool: 'analyze_sketch', args: { silent: true } })
  }
  catch (err) {
    console.warn('[thumbs-up] 风格分析失败，回退默认风格', err)
  }

  return agent.currentSuggestions.length > 0
}

/**
 * 👍 确认后的业务入口。
 *
 * 直接走 useAgent 的 generate_image，而不是自己再拼一遍 /api/generate：
 * 这条链路已经处理了“画布导出 → 白底 PNG → styleKey / promptOverride → 占位图兜底”，
 * 也绕开 LLM，少了十几秒的对话往返。
 */
async function handleThumbsUp() {
  if (generatingByThumbsUp.value) {
    showThumbsUpNotice('👍 正在生成，画完这一张再比', 'warn')
    return
  }

  if (agent.loading || agent.streaming || agent.executing || agent.isGenerating) {
    showThumbsUpNotice('AI 正在忙，等它完成再比 👍', 'warn')
    return
  }

  if (!agent.hasSketch) {
    showThumbsUpNotice('先画几笔，再比 👍 生成', 'warn')
    return
  }

  // 和 10 秒空闲邀请共用一把锁。先认领的入口负责这次生成，
  // 另一个入口直接退出，不能再各自 analyze + generate。
  if (!agent.claimGeneration('thumbs-up')) {
    showThumbsUpNotice('另一个生成请求正在处理中，稍等一下', 'warn')
    return
  }

  generatingByThumbsUp.value = true
  flashThumbsUp()

  try {
    // 没看过图时，先静默分析一次，否则 currentSuggestions 为空，
    // 生成会退回第一条水墨风格，看起来“永远都是国风”。
    let picked = agent.currentSuggestions.length > 0
    if (!picked) {
      showThumbsUpNotice('👍 收到，先看看画，挑个风格…', 'success', 0)
      speak('我先看看你的画，挑个风格。')
      picked = await ensureStyleSuggestions()
    }

    showThumbsUpNotice(
      picked ? '👍 风格挑好了，开始生成…' : '👍 先按默认风格生成…',
      'success',
      0,
    )
    speak('好嘞，马上为你变魔法！')

    // 不传 styleKey：让 generate_image 优先用 AI 看图后推荐的最高分风格
    const message = await runAction({
      tool: 'generate_image',
      args: {
        strength: 0.6,
      },
    })

    const done = message.startsWith('生成完成')
    showThumbsUpNotice(
      done ? '👍 生成完成，点画布上的“贴回画布”查看' : `👍 ${message}`,
      done ? 'success' : 'warn',
      6000,
    )
  } catch (err) {
    console.error('[thumbs-up] 生成失败：', err)
    const reason = (err as Error | undefined)?.message ?? String(err)
    showThumbsUpNotice(`👍 生成失败：${reason}`, 'error', 7000)
  } finally {
    generatingByThumbsUp.value = false
    agent.releaseGeneration('thumbs-up')
  }
}

/** 关摄像头时只收绿光和语音；顶部提示保留到计时结束，用户关了摄像头也能看到 */
function clearThumbsUpFeedback() {
  thumbsUpFlash.value = false
  if (thumbsUpFlashTimer) {
    clearTimeout(thumbsUpFlashTimer)
    thumbsUpFlashTimer = null
  }
  // 关摄像头时把没念完的反馈语音停掉
  stopSpeaking()
}

/** 模板里只显示一条错误，模型错误优先 */
const statusError = computed(() => trackingError.value || captureError.value)

// ===== 4 点透视标定（R7）=====
/**
 * 标定含义：把「手实际能够到的那块区域」拉成正矩形再映射到整块画布。
 * 靶点落在预览的 20%–80%（避开摄像头边缘，那里的关键点最不稳），
 * 映射目标取画布四角 (0,0)–(1,1)，所以标定后 20%–80% 这块区域就能画满整张画布。
 */
const CANVAS_CORNERS: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

const calibrating = ref(false)
const calibrationError = ref('')
/** 正在等第几个靶点（UI 高亮用） */
const activeTarget = ref(0)
/** 已采集到的点数 */
const capturedCount = ref(0)
/** 是否正停在靶点上（触发进度条动画） */
const dwellActive = ref(false)

/** 停留状态机用普通对象：每帧都推进，没必要做成响应式 */
let dwell: DwellState = createDwellState()

function startCalibration() {
  // 包一层 try/catch：万一 setHoverPoint/矩阵等依赖有问题，错误要显示在界面上，
  // 而不是让点击静默失败（"点了没反应"是最难查的故障）
  try {
    dwell = createDwellState()
    activeTarget.value = 0
    capturedCount.value = 0
    dwellActive.value = false
    calibrationError.value = ''
    calibrating.value = true
  }
  catch (err) {
    calibrationError.value = `标定启动失败：${(err as Error)?.message ?? String(err)}`
  }
}

function cancelCalibration() {
  calibrating.value = false
  dwellActive.value = false
  calibrationError.value = ''
  dwell = createDwellState()
}

function clearCalibration() {
  calibration.clear()
  calibrationError.value = ''
}

/** 每帧推进停留判定；四点采齐就结算 */
function advanceCalibration(point: Point | null) {
  const step = stepDwell(dwell, point, performance.now(), { aspect: gesture.cameraAspect })
  dwell = step.state

  // 只把发生变化的值写进响应式状态：否则 30FPS 每帧都会触发一次组件更新
  if (activeTarget.value !== dwell.index) activeTarget.value = dwell.index
  if (capturedCount.value !== dwell.captured.length) capturedCount.value = dwell.captured.length
  if (dwellActive.value !== step.active) dwellActive.value = step.active

  if (step.done) finishCalibration()
}

function finishCalibration() {
  const src = dwell.captured
  const matrix = computeHomography(src, CANVAS_CORNERS)

  if (matrix) {
    const check = validateHomography(matrix, src, CANVAS_CORNERS)
    if (check.ok) {
      calibration.save(matrix)
      calibrating.value = false
      dwellActive.value = false
      calibrationError.value = ''
      dwell = createDwellState()
      return
    }

    // 校验不过：重来一轮，但把原因留在界面上
    const reason = check.reason ?? '标定结果不可用，请重试'
    startCalibration()
    calibrationError.value = reason
    return
  }

  startCalibration()
  calibrationError.value = '矩阵求解失败，请重新标定'
}

/**
 * 归一化坐标 → 画布坐标。
 * 没标定时原样返回：这是兜底路径，缺矩阵绝不能崩。
 */
function mapPoint(point: Point): Point {
  return calibration.matrix ? applyHomography(point, calibration.matrix) : point
}

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
  // 语音助手/Agent 拿不到本组件的模板 ref；注册桥，open_camera 才能启动摄像头。
  // 这里只注册函数，不自动开摄像头（浏览器仍要求权限和用户手势）。
  agent.setCameraController({
    start: startCamera,
    stop: stopCamera,
    isActive: () => isActive.value,
  })

  // 从 localStorage 恢复上次的标定；没标定过就保持 null，映射退化为原样
  calibration.load()

  // 欢迎页已完成权限预检，并通过 Pinia 交接了一次性“自动开摄像头”标记。
  // 这里消费后启动；直接打开 /studio 时不会自动申请权限。
  if (app.consumeAutoCameraRequest()) {
    void startCamera()
  }

  if (!showPerf) return
  perfRafId = requestAnimationFrame(paintPerf)
})

/** requestAnimationFrame 句柄，关摄像头时必须 cancel，否则循环会一直跑 */
let rafId = 0
/** 上一帧的 video.currentTime，避免对同一帧重复推理 */
let lastVideoTime = -1
/** 上一次真正发起推理的时间 */
let lastDetectTs = 0
/** 上一帧主手的 handedness；用来发现 R4 主手换人并在换人帧断笔 */
let lastMainHandedness: DetectedHand['handedness'] | null = null

/**
 * 抓帧的帧率上限。
 * 60 会让普通室内摄像头把曝光时间砍半：画面变暗、运动模糊变重，
 * MediaPipe 的掌部检测置信度跟着掉，于是出现“经常识别不到手”。
 * 先固定回 30，优先保证识别稳定；性能优化必须在曝光不变的前提下做。
 */
const MIN_FRAME_INTERVAL = 1000 / 30

/**
 * 送去推理的画面最大宽度。
 * MediaPipe 的模型输入只有 224/256，但 320 宽对“手贴着脸/侧着捏合”这种姿态
 * 细节仍然不够，线上出现过关键点落到脸上、真实手没被检测到的情况。
 * 恢复 480 宽，优先保证捏合识别；30fps 下仍可接受。
 */
const DETECT_MAX_WIDTH = 480

/**
 * 把真实画幅的宽高比写进手势 store。
 *
 * 手势判定的距离要按它换算：MediaPipe 的 x 是按画面【宽】归一化、y 是按【高】归一化，
 * 640×480 下同样 51 像素的横竖位移，算出来是 0.08 和 0.107 —— 相差 33%（R2 的根因）。
 * 写真实值而不是写死 4:3，是为了外接摄像头或浏览器协商出别的分辨率时也能自动跟上。
 */
function syncCameraAspect() {
  const video = videoEl.value
  if (!video?.videoWidth || !video.videoHeight) return
  gesture.setCameraAspect(video.videoWidth / video.videoHeight)
}

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
      // 不用 60：普通室内摄像头为了跑 60fps 会缩短曝光，手一快就糊，
      // 掌部检测会频繁丢手。30fps 的曝光更稳，识别率优先。
      video: {
        width: 640,
        height: 480,
        facingMode: 'user',
        frameRate: { ideal: 30 },
      },
      audio: false,
    })

    stream.value = mediaStream

    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream
      // 自动播放策略或权限边界可能让 play() 失败，这里不阻断：autoplay 属性会兜底
      await videoEl.value.play().catch(() => {})

      // play() 之后 metadata 通常已就绪；没就绪的话 loadedmetadata 事件会再补一次
      syncCameraAspect()
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

  // Worker 里没有 DOM，拿不到 <video>，所以先抓成一帧位图再转移过去。
  // 用 low：手部关键点不需要相册级锐度，这里是每帧都跑的热路径，省的是真金白银。
  createImageBitmap(video, { resizeWidth, resizeHeight, resizeQuality: 'low' })
    .then((bitmap) => {
      if (!isActive.value) {
        // 抓图这段时间里摄像头被关了，这张图没人接手，自己关掉
        bitmap.close()
        return
      }
      // 用“发起抓帧”的时间，而不是 bitmap resolve 的时间：
      // 这样旧图晚到时能按真实捕获顺序被丢弃，结果时间也对应实际画面。
      detect(bitmap, now)
    })
    .catch((err) => {
      captureError.value = `抓帧失败：${(err as Error | undefined)?.message ?? String(err)}`
    })
}

/**
 * Worker 回传的双手结果到了：画到覆盖层 → 用主手推进手势状态机 → 决定要不要写 lastPoint。
 * hands 是异步回来的，所以放在 watch 里，而不是发起推理的那一帧里。
 *
 * 用 watch(hands) 而不是 watch(landmarks)：主手切换时 2D 数组可能来自同一只手但对象变了，
 * 而 hands 每帧都是新数组，能保证覆盖层把两只手一起刷新。
 */
watch(hands, (list) => {
  // 摄像头已经关了但这条结果才回来：丢掉，否则画布上会多画一笔
  if (!isActive.value) return

  const hand = mainHand.value
  drawHands(list, hand)

  const handedness = hand?.handedness ?? null
  const mainHandSwitched = lastMainHandedness !== null
    && handedness !== null
    && handedness !== lastMainHandedness
  lastMainHandedness = handedness

  // 顺序不能反：syncIndexFingertip 要看这一帧更新后的手势状态
  updateGesture(hand)

  if (mainHandSwitched) {
    // R4 主手换人：先断笔，且这一帧不写 lastPoint。
    // 不这么做的话，画布会把「上一只手的最后位置 → 新主手的食指尖」连成一条横贯画面的线。
    resetSmoothing()
    gesture.setLastPoint(null)
    return
  }

  syncIndexFingertip(hand?.landmarks ?? null)
})

/**
 * 把本帧所有手画到覆盖层上：归一化坐标 × canvas 宽高。
 * 主手绿色、副手蓝色，食指尖（索引 8）标红；
 * ?perf=1 时额外在手腕旁标 L/R 与 *（主手），方便调主手身份。
 */
function drawHands(list: DetectedHand[], main: DetectedHand | null) {
  const canvas = overlayEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!list.length) return

  // 这里必须和 video 一起镜像：画面已经被 scaleX(-1) 翻过，关键点如果不翻，
  // 调试点就会落在手的反侧。镜像后的 x = 1 - x，和准星/笔迹是同一个朝向。
  const mirrorX = (x: number) => (1 - x) * canvas.width

  ctx.font = '12px sans-serif'
  ctx.textBaseline = 'top'

  for (const hand of list) {
    // mainHand 就是 hands 里的同一个对象引用（useHandTracking 直接返回元素）
    const isMain = hand === main
    const color = isMain ? '#22c55e' : '#60a5fa'

    ctx.fillStyle = color
    for (const point of hand.landmarks) {
      ctx.fillRect(mirrorX(point.x) - 3, point.y * canvas.height - 3, 6, 6)
    }

    // 食指尖单独标记：画线用的就是它
    const indexTip = hand.landmarks[8]
    if (indexTip) {
      ctx.fillStyle = isMain ? '#ef4444' : '#f59e0b'
      ctx.fillRect(mirrorX(indexTip.x) - 5, indexTip.y * canvas.height - 5, 10, 10)
    }

    // handedness 标签只在 ?perf=1 调试时画：输入给模型的是未镜像的原始帧，
    // MediaPipe 的 Left/Right 是按“自拍镜像”假设给的，直接展示给用户会看着左右反了。
    // 身份维持只用它做内部区分，不影响准星/笔迹方向。
    const wrist = hand.landmarks[0]
    if (showPerf && wrist) {
      const label = hand.handedness === 'Left' ? 'L' : hand.handedness === 'Right' ? 'R' : '?'
      ctx.fillStyle = color
      ctx.fillText(`${label}${isMain ? '*' : ''}`, mirrorX(wrist.x) + 8, wrist.y * canvas.height)
    }
  }
}

// 【临时采集代码，实验结束后可删除】固定 30 FPS 采样，让不同轨迹的帧数差异小很多
let lastSampleTs = 0
const SAMPLE_INTERVAL = 1000 / 30

/**
 * 食指尖的归一化坐标写进 gesture store，给 DrawingCanvas 用。
 * 存的是「镜像翻转 → 透视校正 → 平滑」后的 0–1 坐标，画布那边再乘自己的 width/height。
 *
 * 写两个位置：
 * - hoverPoint：只要有手就写（不依赖捏合），给悬停准星跟随用；和 lastPoint 共用
 *   同一份 One Euro 结果，准星和笔迹不会分叉（画布那边还有一层 60FPS 的 rAF 插值）；
 * - lastPoint：只有 drawing 状态才写，松手/丢手写 null 让画布断开笔画。
 *
 * 标定模式下走另一条分支：用**未做透视校正**的镜像坐标，这样食指能和屏幕上的红点对上；
 * 同时不落笔，避免在标定过程中往画布上画线。
 */
function syncIndexFingertip(points: { x: number, y: number }[] | null) {
  const indexTip = points?.[8]

  // 镜像：关键点 x 是"画面左边缘为 0"的原始坐标，而预览画面和覆盖层都已经 scaleX(-1) 翻过，
  // 所以这里换算成「屏幕上的位置」—— 1 - x。这样准星、笔迹、标定红点、调试点四者同向。
  const raw: Point | null = indexTip
    ? { x: clamp01(1 - indexTip.x), y: clamp01(indexTip.y) }
    : null

  if (calibrating.value) {
    advanceCalibration(raw)
    gesture.setHoverPoint(raw)
    // 标定期间不落笔，也不让滤波历史影响标定点：红点必须和屏幕上的实际指尖重合
    resetSmoothing()
    wasDrawing = false
    gesture.setLastPoint(null)
    return
  }

  if (!raw) {
    resetSmoothing()
    wasDrawing = false
    gesture.setHoverPoint(null)
    gesture.setLastPoint(null)
    return
  }

  // 刚捏合落笔时清一次滤波历史：否则 hover 阶段攒下的平滑滞后会原样带进笔画，
  // 表现为“笔尖先慢半拍再追”。只在 idle → drawing 的上升沿清，不会影响连续画线。
  const drawingNow = gestureState.value === 'drawing'
  if (drawingNow && !wasDrawing) resetSmoothing()
  wasDrawing = drawingNow

  // 透视校正后的坐标：准星和笔迹都用它，两者才能始终重合
  const mapped = mapPoint(raw)
  // R5：滤波放在透视之后，存的都是同一套画布坐标；准星和笔迹共用同一个滤波结果
  const smoothed = smoothPoint(mapped)
  gesture.setHoverPoint(smoothed)

  // 待机、松开手指都等于抬笔：必须写 null 断开笔画，
  // 否则画布会把上一笔的末尾和下一笔的起点连成一条长线。
  if (gestureState.value !== 'drawing') {
    gesture.setLastPoint(null)
    return
  }

  // 【临时采集代码，实验结束后删除】存的就是真正画到画布上的那个值（已翻转、已校正、已平滑）
  const now = performance.now()
  if (now - lastSampleTs >= SAMPLE_INTERVAL) {
    lastSampleTs = now

    if (typeof window !== 'undefined') {
      ;(window as any).__fingerTrace = (window as any).__fingerTrace || []
      ;(window as any).__fingerTrace.push({ t: now, x: smoothed.x, y: smoothed.y })
    }
  }

  gesture.setLastPoint(smoothed)
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
  lastMainHandedness = null
  drawHands([], null)
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

  // 👍 的提示/绿光/计时器一起收掉；生成请求本身继续跑完，由 finally 解锁
  clearThumbsUpFeedback()

  // 标定做到一半就关摄像头：退出标定模式，否则红点会挂在一个没有画面的框上
  calibrating.value = false
  dwellActive.value = false
  dwell = createDwellState()
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
  agent.setCameraController(null)
  if (perfRafId) {
    cancelAnimationFrame(perfRafId)
    perfRafId = 0
  }
  stopCamera()
  // 离开画室时才清掉全局提示；单纯关闭摄像头不清，保证提示仍可见
  ui.hideGestureNotice()
  // Worker 占着 WASM 和显存，整个组件销毁时一起释放
  close()
})

// 暴露给父组件（要拿关键点/双手结果做手势判断时直接用）
defineExpose({ videoEl, stream, isActive, landmarks, hands, mainHand, startCamera, stopCamera })
</script>
