<template>
  <div :class="embedded
    ? 'flex w-full flex-col gap-2'
    : 'flex w-[360px] flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-soft'">
    <h2 v-if="!embedded" class="font-semibold">AI 助手</h2>

    <!-- 消息列表：固定高度 + 可滚动，新内容进来自动滚到底 -->
    <div ref="listEl" class="space-y-2 overflow-y-auto text-sm" :class="embedded ? 'h-64' : 'h-48'">
      <p v-if="!store.messages.length" class="text-muted/80">
        说点什么，比如「这个草图适合什么风格」
      </p>

      <div
        v-for="(message, index) in store.messages"
        :key="index"
        :class="message.role === 'user' ? 'text-right' : 'text-left'"
      >
        <span
          class="inline-block max-w-[85%] whitespace-pre-wrap rounded px-2 py-1 text-left"
          :class="message.role === 'user' ? 'bg-sage text-white' : 'bg-surface-2 text-ink'"
        >{{ message.role === 'assistant' ? displayAssistantName(message.content) : message.content }}</span>
        <!-- 流式回答刚开始、还没吐出字时给个光标，让用户知道在生成 -->
        <span
          v-if="store.streaming && index === store.messages.length - 1 && !message.content"
          class="ml-1 animate-pulse text-muted/80"
        >▍</span>
      </div>
    </div>

    <!-- 思考可视化：/api/agent 返回的判断依据，可滚动 -->
    <div
      v-if="store.reasoning.length"
      class="max-h-24 overflow-y-auto rounded bg-amber-50 p-2 text-xs text-amber-800"
    >
      <p class="font-semibold">AI 的判断依据</p>
      <ul class="list-disc pl-4">
        <li v-for="(item, index) in store.reasoning" :key="index">{{ item }}</li>
      </ul>
    </div>

    <p v-if="store.fallback" class="text-xs text-amber-600">
      上游不可用，这条是本地模板回复。
    </p>

    <div class="flex items-center gap-2">
      <!-- 语音输入：Web Speech 快路径 + Whisper 兜底。
           原生识别报 network（Chrome 走 Google 服务）或浏览器不支持时，
           自动切成「录音 → 转 WAV → /api/transcribe」，会提示再说一遍。 -->
      <button
        v-if="voiceSupported"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40"
        :class="isActive ? 'animate-pulse bg-danger text-white' : 'bg-surface-2 text-muted hover:bg-line/60'"
        :disabled="busy || handsFreeEnabled"
        :title="voiceTitle"
        @click="toggleVoice"
      >
        <svg v-if="!isActive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
          <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
          <path d="M19 11a7 7 0 0 1-14 0" />
          <path d="M12 18v3" />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="h-4 w-4">
          <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </button>

      <input
        v-model="input"
        :disabled="store.loading"
        class="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted/70 focus:border-sage/50 focus:ring-2 focus:ring-sage/15 disabled:bg-surface-2"
        placeholder="说点什么，比如「把它变成国风」"
        @keyup.enter="submitSend"
      />
    </div>

    <!-- 免提常驻唤醒：不用每次瞄准麦克风，说「小绘，…」即可 -->
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 disabled:opacity-40"
        :class="handsFreeEnabled
          ? 'border-sage bg-sage-soft text-sage-strong'
          : 'border-line bg-surface text-muted hover:bg-surface-2'"
        :aria-pressed="handsFreeEnabled"
        :disabled="!handsFreeSupported"
        :title="handsFreeEnabled ? '关闭免提模式' : '开启免提：说「小绘，帮我撤销一下」'"
        @click="toggleHandsFree"
      >
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 9v6h3l5 4V5L7 9H4Z" />
          <path d="M16 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
        </svg>
        {{ handsFreeEnabled ? '免提已开' : '免提' }}
      </button>
      <span
        v-if="handsFreeError"
        class="text-xs text-danger"
      >
        {{ handsFreeError }}
      </span>
      <span
        v-else-if="handsFreeEnabled"
        class="text-xs text-sage-strong"
      >
        {{ handsFreeListening ? '正在听…' : '已暂停，等小绘说完' }}
      </span>
      <span v-else class="text-xs text-muted">说「小绘，帮我撤销一下」</span>
    </div>

    <p v-if="handsFreeEnabled && handsFreeNotice" class="text-xs text-muted">
      {{ handsFreeNotice }}
    </p>

    <!-- 语音状态与提示：链路切换、录音中、识别中、失败原因 -->
    <p v-if="voiceNotice" class="text-xs text-sage-strong">{{ voiceNotice }}</p>
    <p v-if="recording" class="text-xs text-danger">
      录音中 {{ recordElapsed.toFixed(1) }}s · 说完停一下会自动结束（也可再点麦克风）
    </p>
    <p v-if="transcribing" class="text-xs text-muted">识别中…</p>
    <p v-if="speechError" class="text-xs text-amber-600">{{ speechError }}</p>

    <div class="flex gap-2">
      <!-- 主入口：走 /api/agent，解析意图并串行执行动作（改颜色 / 检索风格 / 生成图片） -->
      <button
        class="min-h-10 rounded-full bg-sage px-4 text-sm font-medium text-white transition-colors hover:bg-sage-strong disabled:opacity-50"
        :disabled="busy || !input.trim()"
        title="解析意图并执行动作：改颜色、检索风格、生成图片"
        @click="submitSend"
      >
        {{ store.executing ? '执行中...' : store.loading ? '解析中...' : '发送' }}
      </button>

      <!-- 次入口：走 /api/chat，只聊天，不执行任何动作 -->
      <button
        class="min-h-10 rounded-full border border-line px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-2/70 disabled:opacity-50"
        :disabled="busy || !input.trim()"
        title="只聊天，边生成边显示，不会改动画布"
        @click="submitStream"
      >
        {{ store.streaming ? '生成中...' : '流式对话' }}
      </button>

      <!-- 只有正在流式接收时才出现 -->
      <button
        v-if="store.streaming"
        class="rounded-full border border-line bg-surface-2 px-3 py-1 text-danger transition-colors hover:bg-line/50"
        @click="stop"
      >
        停止
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useHandsFree } from '~/composables/useHandsFree'

withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const store = useAgentStore()
const { send, chatStream, stop } = useAgent()
const { speak, stop: stopSpeaking, speaking: ttsSpeaking } = useTTS()

/**
 * 模型偶尔会把自己叫成“小惠”（用户也可能这样叫）。
 * 对话区统一显示“小绘”，语音唤醒词里仍保留小惠做识别容错。
 */
function displayAssistantName(text: string) {
  return text.replaceAll('小惠', '小绘')
}

const input = ref('')
/** 消息列表容器，用来控制自动滚动 */
const listEl = ref<HTMLDivElement | null>(null)

// ===== 语音输入（Web Speech 快路径 + Whisper 兜底）=====
const {
  isSupported: voiceSupported,
  isActive,
  recording,
  transcribing,
  recordElapsed,
  transcript,
  interim,
  error: speechError,
  notice: voiceNotice,
  start: startVoice,
  stop: stopVoice,
  reset: resetVoice,
} = useVoiceInput()

// 免提常驻唤醒：识别到「小绘 + 指令」后剥掉唤醒词，直接交给同一套 Agent。
// 这里不经过 voiceActive/输入框，避免和手动语音的“先说后填”逻辑打架。
const {
  supported: handsFreeSupported,
  enabled: handsFreeEnabled,
  listening: handsFreeListening,
  error: handsFreeError,
  notice: handsFreeNotice,
  start: startHandsFree,
  stop: stopHandsFree,
  pause: pauseHandsFree,
  resume: resumeHandsFree,
} = useHandsFree({
  onCommand: (command) => {
    void autoSendVoice(command)
  },
})

/** 按钮 title 随链路变化，方便现场确认自己在用哪条路 */
const voiceTitle = computed(() => {
  if (handsFreeEnabled.value) return '免提模式已开启，先关闭免提再用手动语音'
  if (isActive.value) return '停止语音输入'
  return '语音输入（Web Speech，失败自动切 Whisper）'
})

/**
 * 开始收音时输入框里已有的内容。
 * 语音结果追加在它后面，而不是把用户手打的一半文字冲掉。
 */
let voiceBase = ''

/**
 * 本次语音会话是否还该往输入框写。
 * 发送消息时必须置 false：识别器不会因为我们清了输入框就立刻停，
 * 迟到的结果会把旧内容重新灌回来（表现为「发送之后输入框又冒出刚才那句」）。
 */
let voiceActive = false

function toggleVoice() {
  if (isActive.value) {
    stopVoice()
    return
  }

  // 麦克风会录进扬声器里的声音：先把正在念的 TTS 掐掉，再开麦。
  stopSpeaking()

  voiceBase = input.value.trim() ? `${input.value.trim()} ` : ''
  voiceActive = true
  void startVoice()
}

function toggleHandsFree() {
  if (handsFreeEnabled.value) {
    stopHandsFree()
    return
  }

  if (!handsFreeSupported.value) return

  // 先掐掉 TTS，再开常驻麦；否则会把小绘自己的声音当成唤醒词。
  stopSpeaking()
  startHandsFree()
}

/**
 * 把「已确定 + 实时草稿」拼回输入框：一边说一边就能看到字冒出来。
 * 注意监听的是两个 ref：interim 每帧都在变，但 Vue 只会更新这一处文本，开销可以忽略。
 */
watch([transcript, interim], () => {
  if (!voiceActive) return

  const text = (voiceBase + transcript.value + interim.value).trim()
  // 语音完全没内容时不要动输入框（否则清空会误删用户手打的文字）
  if (!text) return
  input.value = text
})

/**
 * 语音自动发送：识别结束（麦克风停、Whisper 也转完）且拿到最终文本后，
 * 不经过输入框和发送按钮，直接交给 Agent。
 */
let autoSending = false

async function autoSendVoice(text: string) {
  if (autoSending) return

  autoSending = true
  try {
    input.value = ''
    endVoiceSession()

    if (busy.value) {
      voiceNotice.value = '还在处理上一条，请稍后再试'
      return
    }

    const result = await send(text)
    // 动作结果比模型自己的 reply 可信：撤销成功才说“已经帮你撤销啦”。
    if (result?.spoken) {
      speak(result.spoken, { rate: 0.95, pitch: 1.05 })
    }
  }
  finally {
    autoSending = false
    // 免提在识别到指令后会自动暂停；如果这次没有 TTS，就立刻恢复监听。
    // 有 TTS 时由下面的 watch(ttsSpeaking) 在说完后恢复。
    if (handsFreeEnabled.value && !ttsSpeaking.value) {
      resumeHandsFree()
    }
  }
}

/**
 * TTS 与免提互斥：小绘一开口就暂停常驻麦，避免把自己的声音录成新指令；
 * 说完再恢复。TTS 的 speaking 是全局 ref，其他组件触发的播报也能被感知。
 */
let ttsResumeTimer: ReturnType<typeof setTimeout> | null = null

watch(ttsSpeaking, (speaking) => {
  if (!handsFreeEnabled.value) return

  if (ttsResumeTimer) {
    clearTimeout(ttsResumeTimer)
    ttsResumeTimer = null
  }

  if (speaking) {
    pauseHandsFree()
    return
  }

  // 留一点余量，避免扬声器尾音被麦克风收进去
  ttsResumeTimer = setTimeout(() => {
    ttsResumeTimer = null
    if (handsFreeEnabled.value && !ttsSpeaking.value) resumeHandsFree()
  }, 280)
})

onScopeDispose(() => {
  if (ttsResumeTimer) {
    clearTimeout(ttsResumeTimer)
    ttsResumeTimer = null
  }
  stopHandsFree()
})

watch([transcript, isActive], ([text, active]) => {
  if (!voiceActive || active || autoSending) return

  const clean = text.trim()
  if (!clean) return

  // 先关掉回填，避免发送过程中识别器迟到的结果又把输入框填满
  voiceActive = false
  void autoSendVoice(clean)
})

// 注意：这里**不要**再监听 isActive 去清 voiceActive。
// 降级到 Whisper 的那一瞬间（原生识别已停、录音还没起来）isActive 会短暂变 false，
// 监听它就会把「还要不要回填」关掉，导致 Whisper 千辛万苦识别出来的文字被丢弃。
// voiceActive 只在两个地方结束：用户发送（endVoiceSession）和开始新一轮（toggleVoice）。

/**
 * 结束本次语音会话：停麦 + 清空语音状态 + 解除回填。
 * 发送/流式对话前都要调用，否则迟到的识别结果会把输入框重新填满。
 */
function endVoiceSession() {
  if (isActive.value) stopVoice()
  voiceActive = false
  voiceBase = ''
  resetVoice()
}

/** 三种状态都不能并发提交：等模型 / 收流 / 执行动作 */
const busy = computed(() => store.loading || store.streaming || store.executing)

/**
 * 主入口：走 send（/api/agent）。
 * 它会一次性拿到 reply + actions，然后串行执行动作 ——
 * 改颜色、检索风格、生成图片都在这条路上，点「发送」和回车都走这里。
 */
async function submitSend() {
  const text = input.value.trim()
  if (!text || busy.value) return

  // 先结束语音会话再发：否则识别器迟到的结果会把输入框重新填满
  endVoiceSession()

  // 先清空输入框：等 await 回来再清，用户会以为没发出去、又点一次
  input.value = ''
  await send(text)
}

/** 次入口：走 chatStream（/api/chat），只聊天、不执行动作 */
async function submitStream() {
  const text = input.value.trim()
  if (!text || busy.value) return

  endVoiceSession()

  input.value = ''
  await chatStream(text)
}

// 消息一多、或者流式内容变长，就滚到底部
watch(
  () => store.messages,
  () => {
    nextTick(() => {
      const el = listEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
  { deep: true },
)
</script>
