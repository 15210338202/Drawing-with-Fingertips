<template>
  <div class="rounded-card border border-line bg-surface p-4 shadow-soft">
    <h2 class="font-semibold">画布区</h2>

    <!-- 生成结果浮层要和画布像素级对齐，所以叠在同一个盒子里 -->
    <div class="relative mt-2 w-[50rem] max-w-full">
      <canvas
        ref="canvasEl"
        width="800"
        height="600"
        class="block w-full cursor-crosshair touch-none rounded-xl border border-line bg-[#fffdf8]"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onPointerUp"
        @mouseleave="onPointerUp"
        @touchstart.prevent="onTouchStart"
        @touchmove.prevent="onTouchMove"
        @touchend.prevent="onPointerUp"
        @touchcancel.prevent="onPointerUp"
      />

      <!-- 悬停准星：手在哪光标在哪，捏合时收成实心小点。
           pointer-events-none 不能少，否则它会吃掉鼠标事件、画不了线；
           mix-blend-difference 让白点在白底上自动反成黑点，深色生成图上变白，任何背景都看得见。
           位置由 rAF 直接写 style（见 stepCursor），不走响应式，避免每帧触发 patch。 -->
      <div
        ref="cursorEl"
        v-show="cursorVisible"
        class="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-full mix-blend-difference"
        :class="cursorDrawing ? 'h-3 w-3 bg-white' : 'h-8 w-8 border-2 border-white'"
        aria-hidden="true"
      />

      <!-- 10 秒没有新笔画才出现；不自动消失，避免用户还没看清就没了 -->
      <Transition name="fade-up">
        <div
          v-if="showSuggestion"
          class="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full border border-line bg-surface/95 px-4 py-2.5 shadow-xl backdrop-blur"
          role="status"
          aria-live="polite"
        >
          <span class="text-xl" aria-hidden="true">✨</span>
          <span class="text-sm font-medium text-ink">需要我帮你把这幅画变成艺术品吗？</span>
          <button
            class="rounded-full px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            @click="dismissSuggestion"
          >
            暂不
          </button>
          <button
            class="rounded-full bg-sage px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sage-strong disabled:opacity-50"
            :disabled="agent.isGenerating"
            @click="triggerSuggestionGenerate"
          >
            好呀
          </button>
        </div>
      </Transition>

      <!-- 生成失败/兜底提示；成功时画布上会出现“贴回画布”浮层，不再额外弹提示 -->
      <div
        v-if="suggestionNotice"
        class="absolute left-1/2 top-2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-amber-500/95 px-3 py-1 text-center text-xs text-white shadow-lg"
      >
        {{ suggestionNotice }}
      </div>
    </div>

    <p v-if="pasteError" class="mt-2 text-xs leading-5 text-danger">{{ pasteError }}</p>

    <!-- 共情式解读（P2-10）：看图 → 讲成温柔的话。
         两次大模型调用（llava ~17s + DeepSeek 3～8s），所以 loading 文案要说清在等什么。 -->
    <div class="mt-3 rounded-2xl border border-line bg-surface-2/50 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="rounded-lg bg-sage px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          :disabled="analyzing"
          @click="analyzeSketch"
        >
          {{ analyzing ? 'AI 正在认真观察…（约 20 秒）' : '让 AI 猜猜我画了什么' }}
        </button>

        <!-- 语气切换：同一张画，四种陪法 -->
        <div class="flex flex-wrap gap-1">
          <button
            v-for="item in INSIGHT_TONES"
            :key="item.key"
            class="rounded-full border px-2 py-0.5 text-xs"
            :class="tone === item.key ? 'border-sage bg-sage-soft text-sage-strong' : 'border-line text-muted hover:bg-surface-2'"
            :title="item.hint"
            @click="switchTone(item.key)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <p v-if="insightError" class="mt-2 text-xs text-amber-600">{{ insightError }}</p>

      <div v-if="insight" class="mt-3 space-y-1 rounded-xl border border-line bg-surface p-3 text-sm text-ink">
        <p><span class="font-semibold">它看到了：</span>{{ insight.observation }}</p>
        <p><span class="font-semibold">它感觉到：</span>{{ insight.feeling }}</p>
        <p><span class="font-semibold">想问问你：</span>{{ insight.invitation }}</p>

        <div class="flex flex-wrap items-center gap-2 pt-1">
          <span class="text-xs text-muted">试试这样画：</span>
          <button
            v-for="item in insight.suggestions"
            :key="item"
            class="rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-ink transition-colors hover:bg-surface-2"
            :title="`检索「${item}」相关风格`"
            @click="pickSuggestion(item)"
          >
            {{ item }}
          </button>
        </div>

        <p v-if="insight.degrade && insight.degrade !== 'none'" class="pt-1 text-[11px] text-muted">
          （{{ degradeText }}）
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { lerp, toPercent } from '~/utils/cursor'
import { DEFAULT_TONE, INSIGHT_TONES } from '~/utils/insight'
import type { Insight, InsightToneKey } from '~/utils/insight'
import type { StyleSuggestion } from '~/utils/styleSuggestions'
import { useTTS } from '~/composables/useTTS'
import { buildStoryCardDataUrl } from '~/utils/storyCard'
import { saveStoryCardToArchive } from '~/utils/archive'
import { buildStoryCaption, condenseInsight } from '~/utils/storyCaption'

const brush = useBrushStore()
const gesture = useGestureStore()
const agent = useAgentStore()
const ui = useUIStore()

const emit = defineEmits<{ history: [state: { canUndo: boolean; canRedo: boolean }] }>()

/** 最多保留 20 步；每步是一张 800×600 PNG，足够覆盖常见绘画长度又不会吃爆内存 */
const MAX_HISTORY = 20

interface HistoryEntry {
  dataUrl: string
  empty: boolean
}

const history = ref<HistoryEntry[]>([])
const historyIndex = ref(-1)
const canUndo = computed(() => historyIndex.value > 0)
const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)

const canvasEl = ref<HTMLCanvasElement | null>(null)

/** 悬停准星的 DOM 元素与显示状态 */
const cursorEl = ref<HTMLDivElement | null>(null)
const cursorVisible = ref(false)
/** 捏合时准星收成实心小点，其余时间是大空心圈 */
const cursorDrawing = computed(() => gesture.state === 'drawing')

/** 视觉插值系数：0.35 在 60FPS 下 3 帧到 72%、6 帧到 92%，跟手又不抖 */
const CURSOR_LERP = 0.7

/** 平滑后的归一化位置：只在 rAF 里读写，不需要响应式 */
const cursorPos = { x: 0.5, y: 0.5 }
let cursorRafId = 0

/**
 * 每帧把准星挪向手的位置。
 *
 * 直接写 el.style 而不是绑 :style —— 准星是每帧都在动的东西，
 * 走响应式会让 Vue 每帧 patch 一次，得不偿失。
 * 真正需要响应式的只有两个低频状态：要不要显示、是不是在画。
 */
function stepCursor() {
  cursorRafId = requestAnimationFrame(stepCursor)

  const el = cursorEl.value
  if (!el) return

  const target = gesture.hoverPoint

  // 手不在画面里：隐藏。下次出现时先对齐再显示，避免从旧位置滑过来
  if (!target) {
    if (cursorVisible.value) cursorVisible.value = false
    return
  }

  if (!cursorVisible.value) {
    cursorPos.x = target.x
    cursorPos.y = target.y
    cursorVisible.value = true
  }
  else {
    cursorPos.x = lerp(cursorPos.x, target.x, CURSOR_LERP)
    cursorPos.y = lerp(cursorPos.y, target.y, CURSOR_LERP)
  }

  // 百分比定位：画布是等比缩放到容器宽度的，百分比能自动跟上缩放，
  // 不用量像素、也不用监听 resize
  el.style.left = toPercent(cursorPos.x)
  el.style.top = toPercent(cursorPos.y)
}

/** 贴回画布时的报错提示（比如生成图有跨域限制，画不进 canvas） */
const pasteError = ref('')
const pasting = ref(false)
const savingCard = ref(false)

let ctx: CanvasRenderingContext2D | null = null
/** 是否处于“按下并拖动”状态 */
let drawing = false
/** 当前这一笔有没有真的落下墨；抬笔时才决定要不要存快照 */
let strokeDirty = false
/** 上一个点（canvas 内部坐标系），用于和当前点连成线段 */
let lastPoint: { x: number; y: number } | null = null
/** 上一帧食指尖的位置（canvas 内部坐标），手势画线靠它连成线段 */
let lastGesturePoint: { x: number; y: number } | null = null

onMounted(() => {
  // 把导出方法挂到 store 上：useAgent 在 AgentPanel 里跑，拿不到这里的模板 ref。
  // 必须放在下面那个提前 return 之前，否则 canvas 没就绪时桥就断了。
  agent.setSketchExporter(exportSketch)
  agent.setStoryCardSaver(archiveStoryCard)

  // 准星的跟随循环独立于画布初始化：canvas 上下文拿不到也要能显示光标
  cursorRafId = requestAnimationFrame(stepCursor)

  ctx = canvasEl.value?.getContext('2d') ?? null
  if (!ctx) return

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  agent.setUndoHandler(undo)
  window.addEventListener('keydown', onHistoryKey)
  saveSnapshot(true)
})

onBeforeUnmount(() => {
  agent.setSketchExporter(null)
  agent.setStoryCardSaver(null)
  agent.setUndoHandler(null)
  window.removeEventListener('keydown', onHistoryKey)

  if (cursorRafId) {
    cancelAnimationFrame(cursorRafId)
    cursorRafId = 0
  }
})

function notifyHistory() {
  emit('history', { canUndo: canUndo.value, canRedo: canRedo.value })
}

/** 把当前画布存进历史；empty 用于标记“这是一张空白画布” */
function saveSnapshot(empty = false) {
  const canvas = canvasEl.value
  if (!canvas) return

  const dataUrl = canvas.toDataURL('image/png')
  const current = history.value[historyIndex.value]

  // 同一张图不重复入栈：清空空白画布、连续 undo 后保存等情况都会走到这里
  if (current?.dataUrl === dataUrl) return

  // 从中间撤销后重新落笔：后面的重做记录作废
  if (historyIndex.value < history.value.length - 1) {
    history.value = history.value.slice(0, historyIndex.value + 1)
  }

  history.value.push({ dataUrl, empty })

  if (history.value.length > MAX_HISTORY) {
    history.value.shift()
  }

  historyIndex.value = history.value.length - 1
  notifyHistory()
}

/** 当前这一笔结束：只有真的落过墨才保存，避免每次点击都塞一张重复图 */
function finishStrokeSnapshot() {
  if (!strokeDirty) return
  strokeDirty = false
  saveSnapshot(false)
}

let restoreToken = 0

/** 用 drawImage 把某个快照画回画布；图片解码是异步的，用 token 防止快速连点时旧图覆盖新图 */
function restoreSnapshot(entry: HistoryEntry) {
  const canvas = canvasEl.value
  if (!canvas || !ctx) return

  const token = ++restoreToken
  const image = new Image()

  // 立刻停掉上一段语音/建议；不能等 onload 再停：
  // 语音撤销时 runAction 会先返回，播报已经排上，等图片解码完再 cancel 会把“已经帮你撤销啦”吞掉。
  hideSuggestion()
  stopSpeaking()

  image.onload = () => {
    if (token !== restoreToken) return

    ctx?.clearRect(0, 0, canvas.width, canvas.height)
    ctx?.drawImage(image, 0, 0)

    drawing = false
    strokeDirty = false
    lastPoint = null
    lastGesturePoint = null
    pasteError.value = ''
    agent.setHasSketch(!entry.empty)
  }

  image.src = entry.dataUrl
}

function undo(): boolean {
  if (!canUndo.value) return false
  historyIndex.value--
  restoreSnapshot(history.value[historyIndex.value])
  notifyHistory()
  return true
}

function redo(): boolean {
  if (!canRedo.value) return false
  historyIndex.value++
  restoreSnapshot(history.value[historyIndex.value])
  notifyHistory()
  return true
}

function onHistoryKey(event: KeyboardEvent) {
  const target = event.target
  if (target instanceof HTMLElement && target.matches('input, textarea, [contenteditable="true"]')) return

  if (!(event.ctrlKey || event.metaKey)) return

  const key = event.key.toLowerCase()
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  }
  else if (key === 'y') {
    event.preventDefault()
    redo()
  }
}

/** 送模型的草图长边上限：klein 的输入按 512 处理，再大也会被它缩，白费带宽 */
const EXPORT_MAX_SIZE = 512

/** 源画布上 alpha 高于它的像素才算笔迹（滤掉抗锯齿边缘那圈近乎透明的像素） */
const INK_ALPHA_THRESHOLD = 16

/**
 * 导出当前草图（PNG dataURL），供 /api/generate 使用。
 *
 * 目的只有一个：让模型「看得懂」。早先是把 800×600 画布等比放大到 1024×768 直接送过去，
 * 白边占了大半、线只有 2px 还带抗锯齿灰阶，模型基本把它当噪声，只能靠 prompt 自由发挥，
 * 于是生成结果跟草图没关系。现在分四步处理：
 *
 * 1. 扫像素求笔迹包围盒 —— 项目没有保存 stroke 点集（画布是纯栅格，橡皮擦也因此没做），
 *    所以直接读 alpha，比维护一份点集更省事也更准；
 * 2. 外扩 8%，避免线条贴边被模型当成「被裁断的图形」；
 * 3. 等比缩到长边 ≤ 512，让线稿撑满画面；
 * 4. 形态学膨胀 + 二值化成纯黑白：把 2px 细线变成模型认得出的粗线稿，并去掉灰阶。
 *
 * 注意坐标系：画布的 width/height 属性就是 800×600，绘图坐标也按它算，
 * 没有 devicePixelRatio 缩放，所以包围盒直接用画布像素坐标，不需要换算。
 */
function exportSketch() {
  const source = canvasEl.value
  if (!source) return null

  // 没有笔迹（或像素读不出来）时退回整块画布：导出动作依赖「总能拿到一张图」
  const bbox = findInkBounds(source) ?? { x: 0, y: 0, w: source.width, h: source.height }

  // 外扩 8%，并限制在画布内
  const pad = Math.round(Math.max(bbox.w, bbox.h) * 0.08)
  const sx = Math.max(0, bbox.x - pad)
  const sy = Math.max(0, bbox.y - pad)
  const sw = Math.min(source.width - sx, bbox.w + pad * 2)
  const sh = Math.min(source.height - sy, bbox.h + pad * 2)

  // 等比缩放到长边 512：小图放大、大图缩小，两个方向都是为了「让线撑满」
  const scale = Math.min(EXPORT_MAX_SIZE / sw, EXPORT_MAX_SIZE / sh)
  const tw = Math.min(EXPORT_MAX_SIZE, Math.max(32, Math.round(sw * scale)))
  const th = Math.min(EXPORT_MAX_SIZE, Math.max(32, Math.round(sh * scale)))

  const out = document.createElement('canvas')
  out.width = tw
  out.height = th

  const outCtx = out.getContext('2d')
  if (!outCtx) return null

  // 白底：透明区送到图像 API 那边会变黑，先铺掉
  outCtx.fillStyle = '#ffffff'
  outCtx.fillRect(0, 0, tw, th)

  // 形态学膨胀：先画一次本体，再在 R 圈、每圈 8 个方向各画一次。
  // 用「多次偏移重绘」而不是遍历像素做卷积，是因为这条路径走的是合成器，比 JS 逐像素快得多。
  outCtx.drawImage(source, sx, sy, sw, sh, 0, 0, tw, th)

  // 半径固定 1。实测半径 2~3 会让线变得很粗，模型会「照着粗线条描」，
  // 生成图里留着生硬的描边；半径 1 足够让线连续，又把画面让给风格化渲染。
  const radius = 1
  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ]

  for (let r = 1; r <= radius; r++) {
    for (const [dx, dy] of dirs) {
      outCtx.drawImage(source, sx, sy, sw, sh, dx * r, dy * r, tw, th)
    }
  }

  // 二值化：抗锯齿的灰阶会让模型难以判断「线到底在哪」
  const image = outCtx.getImageData(0, 0, tw, th)
  binarizeStrokes(image.data)
  outCtx.putImageData(image, 0, 0)

  return out.toDataURL('image/png')
}

/**
 * 扫一遍画布像素，求笔迹（alpha 足够高）的包围盒。
 * 读不出像素（跨域图片污染画布）或画布为空时返回 null。
 */
function findInkBounds(source: HTMLCanvasElement) {
  const context = source.getContext('2d')
  if (!context) return null

  let pixels: Uint8ClampedArray
  try {
    pixels = context.getImageData(0, 0, source.width, source.height).data
  }
  catch {
    // 被污染的画布读像素会抛 SecurityError，别让它把整个导出搞挂
    return null
  }

  let minX = source.width
  let minY = source.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < source.height; y++) {
    const rowStart = y * source.width
    for (let x = 0; x < source.width; x++) {
      if (pixels[(rowStart + x) * 4 + 3] > INK_ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // 一像素笔迹都没有
  if (maxX < minX || maxY < minY) return null

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 纯黑 / 纯白：只要有颜色就压成黑，保证模型看到的是线稿而不是带灰阶的照片 */
function binarizeStrokes(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += 4) {
    const isInk = pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240
    const value = isInk ? 0 : 255

    pixels[i] = value
    pixels[i + 1] = value
    pixels[i + 2] = value
    pixels[i + 3] = 255
  }
}

// ===== 共情式解读（P2-10）=====
const { runAction } = useAgent()
const { speak, stop: stopSpeaking } = useTTS()

const analyzing = ref(false)
/** 解读结果；degrade 表示哪一级模型降级了 */
const insight = ref<(Insight & {
  degrade?: string
  keywords?: string
  costMs?: number
  styleSuggestions?: StyleSuggestion[]
}) | null>(null)
const insightError = ref('')
const tone = ref<InsightToneKey>(DEFAULT_TONE)

const currentStyleTitle = computed(() =>
  agent.styleResults.find(item => item.id === agent.lastStyleKey)?.title ?? '自由创作',
)

/**
 * 故事卡底部的正文：
 * 有 AI 解读时优先用解读（它真的看过画），但压成 1–2 句，并把当前风格的语气并进第一句；
 * 没有解读时不要写死一句，交给 buildStoryCaption 按画面特征 + 风格现编。
 */
const insightStoryText = computed(() => condenseInsight(insight.value, currentStyleTitle.value))

// ===== 10 秒空闲：邀请生图 =====
const IDLE_SUGGESTION_MS = 10_000
/** 是否显示邀请气泡 */
const showSuggestion = ref(false)
/**
 * 这一版画是否已经提示过/处理过。
 * 用户点“暂不”、点“好呀”、或生成被别处触发后置 true；再次落笔才清零，
 * 所以同一张画停着不动不会反复弹，也不会反复念。
 */
const suggestionDismissed = ref(false)
/** 生成失败/兜底时的一句提示 */
const suggestionNotice = ref('')
let idleTimer: ReturnType<typeof setTimeout> | null = null
let suggestionNoticeTimer: ReturnType<typeof setTimeout> | null = null

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function hideSuggestion() {
  showSuggestion.value = false
  clearIdleTimer()
}

function showSuggestionNotice(text: string) {
  suggestionNotice.value = text.length > 72 ? `${text.slice(0, 72)}…` : text
  if (suggestionNoticeTimer) clearTimeout(suggestionNoticeTimer)
  suggestionNoticeTimer = setTimeout(() => {
    suggestionNotice.value = ''
  }, 6000)
}

/**
 * 重置空闲计时器。
 *
 * 空画布、正在生图、这一版已经提示过，都不启动计时。
 * 只要用户还在落笔，这个函数就会被 lastStrokeTime 的 watch 反复调用，
 * 所以 10 秒是从“最后一段笔迹”开始算，而不是从起笔开始算。
 */
function resetIdleTimer() {
  const wasVisible = showSuggestion.value
  hideSuggestion()

  // 用户一动笔，就把没念完的邀请打断，别让气泡和笔迹抢注意力
  if (wasVisible) stopSpeaking()

  if (!agent.hasSketch || agent.isGenerating || agent.generationTrigger || suggestionDismissed.value) return
  if (agent.loading || agent.streaming || agent.executing) return

  idleTimer = setTimeout(() => {
    idleTimer = null

    if (!agent.hasSketch || agent.isGenerating || agent.generationTrigger || suggestionDismissed.value) return
    if (agent.loading || agent.streaming || agent.executing) return

    // 先标记再显示：气泡不自动消失，用户没点“暂不”也不会在下一轮重复弹/重复念
    suggestionDismissed.value = true
    showSuggestion.value = true
    speak('你画好啦？需要我帮你变个魔法吗？')
  }, IDLE_SUGGESTION_MS)
}

function dismissSuggestion() {
  suggestionDismissed.value = true
  hideSuggestion()
  stopSpeaking()
}

/**
 * 空闲气泡/手势生成前，确保已经有 AI 风格推荐。
 *
 * 只“不传 styleKey”并不等于会用 AI 推荐：没点过“让 AI 猜猜”时
 * currentSuggestions 是空的，generate_image 会退回第一条水墨风格。
 */
async function ensureStyleSuggestions(): Promise<boolean> {
  if (agent.currentSuggestions.length) return true

  try {
    await runAction({ tool: 'analyze_sketch', args: { silent: true } })
  }
  catch (err) {
    console.warn('[suggestion] 风格分析失败，回退默认风格', err)
  }

  return agent.currentSuggestions.length > 0
}

/** 用当前/上次风格直接生图；失败只显示一句话，成功走画布上的“贴回画布”浮层 */
async function triggerSuggestionGenerate() {
  if (agent.isGenerating) return
  if (agent.loading || agent.streaming || agent.executing) {
    showSuggestionNotice('AI 正在忙，稍等一下再生成')
    return
  }

  // 和 👍 共用一个“先到先得”的锁：如果 thumbs-up 已经在准备，这里直接退出，
  // 避免两个入口同时走 analyze + generate。
  if (!agent.claimGeneration('idle-suggestion')) {
    showSuggestionNotice('另一个生成请求正在处理中，稍等一下')
    return
  }

  suggestionDismissed.value = true
  hideSuggestion()

  try {
    if (!agent.currentSuggestions.length) {
      showSuggestionNotice('先看看画，挑个风格…')
      await ensureStyleSuggestions()
    }

    // 把邀请语收掉，换成“马上做”的确认；不打断的话两句会叠在一起
    speak('好嘞，马上为你变魔法！')

    // 不传 styleKey：generate_image 会优先用 AI 推荐的最高分风格
    const message = await runAction({
      tool: 'generate_image',
      args: {
        strength: 0.6,
      },
    })

    if (!message.startsWith('生成完成')) showSuggestionNotice(message)
  }
  catch (err) {
    showSuggestionNotice(`生成失败：${(err as Error)?.message ?? String(err)}`)
  }
  finally {
    agent.releaseGeneration('idle-suggestion')
  }
}

// 每落一笔都重排计时；同时清掉“这一版已提示过”的标记，下一轮空闲可以再邀请
watch(() => agent.lastStrokeTime, () => {
  suggestionDismissed.value = false
  resetIdleTimer()
})

// 清空画布：收起气泡，取消计时
watch(() => agent.hasSketch, (hasSketch) => {
  if (!hasSketch) {
    suggestionDismissed.value = false
    hideSuggestion()
  }
})

// 任何入口开始生图：收起气泡并锁死这一版，生成结束后不再追着问
watch(() => agent.isGenerating, (busy) => {
  if (!busy) return

  suggestionDismissed.value = true
  hideSuggestion()
})

// 竖大拇指先认领了这次生成时，也要立刻把气泡收掉；
// 两个确认入口共用 generationTrigger，不能各弹各的、各生成各的。
watch(() => agent.generationTrigger, (trigger) => {
  if (!trigger) return
  suggestionDismissed.value = true
  hideSuggestion()
})

onUnmounted(() => {
  clearIdleTimer()
  if (suggestionNoticeTimer) {
    clearTimeout(suggestionNoticeTimer)
    suggestionNoticeTimer = null
  }
})

/** 降级说明：让用户知道现在看到的是"真解读"还是"兜底文案"，答辩时也好讲 */
const degradeText = computed(() => {
  switch (insight.value?.degrade) {
    case 'llava':
      return '看图这一步没成功，文案是按通用想象写的'
    case 'deepseek':
      return '这段是本地兜底文案；配置 DEEPSEEK_API_KEY 后会变成个性化解读'
    case 'both':
      return '模型都没连上，先用固定文案顶上'
    default:
      return ''
  }
})

/**
 * 让 AI 看当前的图并给出一段共情式解读。
 * 用的是 exportSketch()：已经裁过白边、加粗、二值化成 512 线稿，正好适合 llava。
 */
async function analyzeSketch() {
  if (analyzing.value) return

  const imageBase64 = exportSketch()
  if (!imageBase64) {
    insightError.value = '画布还没准备好，先画几笔'
    return
  }

  analyzing.value = true
  insightError.value = ''
  // 新一次看图开始，旧推荐立即失效；失败时也不会拿上一次的旧结果去生图
  agent.setCurrentSuggestions([])

  try {
    const res = await $fetch<{
      success: boolean
      data: Insight & {
        degrade?: string
        keywords?: string
        costMs?: number
        styleSuggestions?: StyleSuggestion[]
      }
    }>('/api/analyze-sketch', {
      method: 'POST',
      body: { imageBase64, tone: tone.value },
      // 服务端最坏情况是 llava 45s + DeepSeek 30s，客户端给足 90s
      timeout: 90000,
    })

    if (!res.success || !res.data) {
      insightError.value = 'AI 没有返回解读结果，再试一次吧'
      return
    }

    insight.value = res.data

    // AI 推荐进 store：之后 👍 / 空闲气泡不指定风格时，默认用最高分那条
    agent.setCurrentSuggestions(res.data.styleSuggestions ?? [])

    // 念“感受 + 邀请”，观察文字留在卡片里；语速稍慢、音调稍高，像陪孩子说话
    const spoken = [res.data.feeling, res.data.invitation]
      .map(part => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('。')
    if (spoken) speak(spoken, { rate: 0.95, pitch: 1.06 })
  }
  catch (err) {
    insightError.value = describeInsightError(err)
  }
  finally {
    analyzing.value = false
  }
}

/** 切换语气：已经有结果时立刻重算一次，方便现场对比四种语气 */
function switchTone(next: InsightToneKey) {
  if (tone.value === next) return

  tone.value = next
  if (insight.value && !analyzing.value) void analyzeSketch()
}

/** 点建议 → 走已有的风格检索，结果出现在风格库里 */
function pickSuggestion(text: string) {
  void runAction({ tool: 'search_style', args: { style: text, k: 3 } })
}

/** Nitro 的 createError 会把原因放在 data.statusMessage 里 */
function describeInsightError(err: unknown) {
  const error = err as {
    statusMessage?: string
    data?: { statusMessage?: string, message?: string }
    message?: string
  }

  return error?.data?.statusMessage
    ?? error?.statusMessage
    ?? error?.data?.message
    ?? error?.message
    ?? '解读失败，请稍后再试'
}

/**
 * 画出故事卡并返回 dataURL。
 *
 * 草图用画布原始 toDataURL，而不是送模型的 exportSketch：
 * exportSketch 会裁白边 + 二值化，适合模型识别，但会把孩子的颜色弄丢。
 */
async function buildStoryCard(): Promise<{ dataUrl: string, styleTitle: string, caption: string } | null> {
  const generated = agent.generatedImage
  const canvas = canvasEl.value
  if (!generated || !canvas) {
    pasteError.value = '还没有可保存的作品'
    return null
  }

  const sketch = canvas.toDataURL('image/png')
  const styleTitle = currentStyleTitle.value
  // 没有 AI 解读时，按画面留白/冷暖/风格现编一句；不再固定成同一句。
  const caption = insightStoryText.value || buildStoryCaption(canvas, styleTitle)
  const dataUrl = await buildStoryCardDataUrl(sketch, generated, caption, styleTitle)

  return { dataUrl, styleTitle, caption }
}

/**
 * 把故事卡存进本机「成长档案」。
 *
 * 语音/异步任务没有用户手势，直接触发下载会被浏览器拦截，所以这里绝不下载；
 * 用户在档案页显式点击时，才走 downloadStoryCard()。
 */
async function archiveStoryCard(): Promise<boolean> {
  // 连点保存时直接视为已处理，避免第二次调用把第一次的成功误报成失败。
  if (savingCard.value) return true

  savingCard.value = true
  pasteError.value = ''

  try {
    const card = await buildStoryCard()
    if (!card) return false

    await saveStoryCardToArchive(card)
    ui.showToast('已存入「档案」，想拿原图时去那里点下载')
    ui.flashArchive()
    return true
  }
  catch (err) {
    console.error('[canvas] 故事卡存入档案失败：', err)
    pasteError.value = `故事卡保存失败：${(err as Error)?.message ?? '请重试'}`
    return false
  }
  finally {
    savingCard.value = false
  }
}

/**
 * 把生成图贴回画布。
 * 贴上去是 drawImage 而不是替换画布，用户之后还能继续在上面画。
 */
async function pasteGenerated(): Promise<boolean> {
  const src = agent.generatedImage
  const canvas = canvasEl.value
  if (!src || !ctx || !canvas) return false

  pasting.value = true
  pasteError.value = ''

  try {
    const image = await loadImage(src)

    // 按比例缩放居中：生成图尺寸和画布多半不一样，硬拉会变形
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const width = image.width * scale
    const height = image.height * scale

    ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)

    // 贴上去也是画布内容；但不再刷新 lastStrokeTime，避免刚贴完就提示“要不要生成”
    agent.setHasSketch(true)
    suggestionDismissed.value = true
    hideSuggestion()
    agent.setGeneratedImage(null)
    saveSnapshot(false)
    return true
  } catch (err) {
    console.error('[canvas] 贴回失败：', err)
    pasteError.value = '这张图贴不进画布（多半是跨域限制），可以先右键另存，或让服务端转存后再试'
    return false
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
    if (lastGesturePoint) {
      // 手势抬笔：这里没有 pointerup，必须在离开 drawing 状态时补一张快照
      finishStrokeSnapshot()
    }
    lastGesturePoint = null
    return
  }

  const current = { x: point.x * canvas.width, y: point.y * canvas.height }

  if (lastGesturePoint) {
    strokeSegment(lastGesturePoint, current)
  }

  lastGesturePoint = current
})

// 手势没有 pointerup，状态从 drawing 退出时补一次快照；strokeDirty 保证不会重复保存
watch(() => gesture.state, (state, previous) => {
  if (previous === 'drawing' && state !== 'drawing') {
    finishStrokeSnapshot()
    lastGesturePoint = null
  }
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

  // 画布上落墨了：/api/agent 的 context.hasSketch 靠这个标记；
  // lastStrokeTime 同时刷新，空闲邀请从“这一段笔迹”重新计时
  strokeDirty = true
  agent.markStroke()

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
  strokeDirty = true
  lastPoint = point

  // 单击留下的这个点也算画布有内容，并刷新空闲计时
  agent.markStroke()

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
  finishStrokeSnapshot()
  drawing = false
  lastPoint = null
}

/** 清空画布，供父组件通过模板 ref 调用 */
function clear() {
  const canvas = canvasEl.value
  if (!ctx || !canvas) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  drawing = false
  strokeDirty = false
  lastPoint = null
  lastGesturePoint = null

  // 画布空了，告诉 AI 现在没有草图可参考；空闲邀请也一起收掉
  suggestionDismissed.value = false
  hideSuggestion()
  stopSpeaking()
  agent.setHasSketch(false)
  saveSnapshot(true)
}

defineExpose({ clear, undo, redo, canUndo, canRedo, exportSketch, buildStoryCard, archiveStoryCard, pasteGenerated })
</script>

<style scoped>
.fade-up-enter-active,
.fade-up-leave-active {
  transition: opacity 0.35s ease, translate 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  translate: 0 12px;
}
</style>

