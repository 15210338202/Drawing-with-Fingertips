import { bytesToBase64, encodeWav16k } from '~/utils/audio'

/**
 * 语音输入：Web Speech 快路径 + Whisper 兜底。
 *
 * 双轨策略：
 * 1. **快路径**：浏览器原生识别（Chrome 走 Google、Edge 走微软），零延迟、边说边出字；
 * 2. **兜底**：原生识别报 network / service-not-allowed，或浏览器根本不支持时，
 *    自动切成「录音 → 转 16kHz WAV → POST /api/transcribe（Cloudflare Whisper）」。
 *
 * 为什么兜底要重新说一遍：原生识别的音频不会交给我们，失败时那段话已经没了，
 * 只能提示用户再说一次并直接开始录音。
 */

/** 录音上限：超过自动停止，避免上传过大的文件 */
const MAX_RECORD_MS = 15000

/** 静音判定：RMS 低于它算「没在说话」 */
const SILENCE_RMS = 0.015

/** 说完之后静音多久自动结束录音（比 15 秒硬上限友好得多） */
const SILENCE_HANGOVER_MS = 1200

/** 音频监测轮询间隔 */
const MONITOR_INTERVAL_MS = 100

/** 兜底触发条件：这两类是「服务不可用」，换条链路就能救 */
const FALLBACK_CODES = new Set(['network', 'service-not-allowed'])

export type VoiceProvider = 'web-speech' | 'whisper'

interface TranscribeResponse {
  text: string
  costMs: number
  provider: string
}

export function useVoiceInput() {
  const speech = useSpeech()

  /** 当前走的链路 */
  const provider = ref<VoiceProvider>('web-speech')
  /** 正在录音 */
  const recording = ref(false)
  /** 录音已结束、正在等 Whisper 返回 */
  const transcribing = ref(false)
  /** 出错提示（中文） */
  const error = ref<string | null>(null)
  /** 非错误的提示，比如「已切换到 Whisper」 */
  const notice = ref('')
  /** 识别出的最终文本 */
  const transcript = ref('')

  /** 实时草稿只在快路径有；Whisper 是一次性返回 */
  const interim = computed(() => (provider.value === 'web-speech' ? speech.interim.value : ''))

  /** 任一链路正在工作 */
  const isActive = computed(() => speech.isListening.value || recording.value || transcribing.value)

  /** 录音已进行了多少秒（UI 显示用，0.1 秒精度） */
  const recordElapsed = ref(0)

  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let mediaStream: MediaStream | null = null
  let autoStopTimer = 0

  // ---- 静音检测：说完自动结束，而不是让用户干等 15 秒 ----
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let monitorTimer = 0
  let recordStartedAt = 0
  let lastVoiceAt = 0
  /** 是否已经听到过人声：没听到之前不触发静音结束，避免刚开录就停 */
  let sawSpeech = false

  // 快路径的文字同步到统一出口
  watch(speech.transcript, (value) => {
    if (provider.value === 'web-speech' && value) transcript.value = value
  })

  const speechSupported = computed(() => speech.isSupported.value)
  const recorderSupported = computed(() =>
    typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined')

  /** 只要有一条路能走，按钮就该出现 */
  const isSupported = computed(() => speechSupported.value || recorderSupported.value)

  // ===== 快路径失败 → 自动切兜底 =====
  watch(speech.errorCode, (code) => {
    if (!code || !FALLBACK_CODES.has(code)) return
    if (!recorderSupported.value) return

    provider.value = 'whisper'
    notice.value = '原生语音服务不可用，已切换到 Whisper，请再说一遍'
    void startRecording()
  })

  /** 开始一次语音输入 */
  async function start() {
    error.value = null
    notice.value = ''
    transcript.value = ''

    if (speechSupported.value) {
      provider.value = 'web-speech'
      speech.reset()
      speech.start()
      return
    }

    // 原生识别不可用（Firefox / 非安全上下文）：直接走录音
    provider.value = 'whisper'
    notice.value = '当前浏览器不支持原生语音识别，已使用 Whisper 兜底'
    await startRecording()
  }

  /** 结束一次语音输入 */
  function stop() {
    if (speech.isListening.value) {
      speech.stop()
      return
    }

    if (recording.value) stopRecording()
  }

  async function startRecording() {
    if (recording.value || transcribing.value) return

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })

      chunks = []
      recorder = new MediaRecorder(mediaStream)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => { void finishRecording() }

      recorder.start()
      recording.value = true
      error.value = null
      recordElapsed.value = 0

      startSilenceMonitor(mediaStream)

      // 兜底上限：就算一直有环境噪音、静音检测不触发，也不会录太久
      autoStopTimer = window.setTimeout(stopRecording, MAX_RECORD_MS)
    }
    catch (err) {
      error.value = describeMediaError(err)
      releaseStream()
    }
  }

  /**
   * 静音检测：一边录一边看音量。
   * 说过话之后静音超过 SILENCE_HANGOVER_MS 就自动结束 —— 用户不需要再点一次麦克风。
   */
  function startSilenceMonitor(stream: MediaStream) {
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    // 浏览器不支持就退回「手动点停 + 15 秒上限」
    if (!Ctx) return

    audioCtx = new Ctx()
    // 有些浏览器创建出来是 suspended，不 resume 拿到的全是 0，静音检测会永远不触发
    void audioCtx.resume()

    const source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)

    const buffer = new Float32Array(analyser.fftSize)
    recordStartedAt = performance.now()
    lastVoiceAt = recordStartedAt
    sawSpeech = false

    monitorTimer = window.setInterval(() => {
      if (!analyser) return

      analyser.getFloatTimeDomainData(buffer)

      let sum = 0
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
      const rms = Math.sqrt(sum / buffer.length)

      const now = performance.now()
      recordElapsed.value = Math.round((now - recordStartedAt) / 100) / 10

      if (rms > SILENCE_RMS) {
        sawSpeech = true
        lastVoiceAt = now
        return
      }

      if (sawSpeech && now - lastVoiceAt > SILENCE_HANGOVER_MS) stopRecording()
    }, MONITOR_INTERVAL_MS)
  }

  function stopSilenceMonitor() {
    if (monitorTimer) {
      clearInterval(monitorTimer)
      monitorTimer = 0
    }

    analyser = null

    if (audioCtx) {
      void audioCtx.close()
      audioCtx = null
    }
  }

  function stopRecording() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer)
      autoStopTimer = 0
    }

    // 先停监测，再停录音：监测里也会调 stopRecording，避免重复触发
    stopSilenceMonitor()

    recording.value = false

    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      }
      catch {
        // 已经停了，忽略
      }
    }
  }

  /** 录音结束：解码 → 转 WAV → 上传识别 */
  async function finishRecording() {
    releaseStream()

    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
    chunks = []

    if (blob.size === 0) {
      error.value = '没有录到声音，请检查麦克风'
      return
    }

    transcribing.value = true

    try {
      const wav = await blobToWav(blob)
      const res = await $fetch<TranscribeResponse>('/api/transcribe', {
        method: 'POST',
        body: { audioBase64: bytesToBase64(wav) },
        // 服务端自己给 60s，这里给 90s 留出网络余量
        timeout: 90000,
      })

      transcript.value = (res.text ?? '').trim()
      if (!transcript.value) error.value = '没有听清，请再说一次'
    }
    catch (err) {
      error.value = describeFetchError(err)
    }
    finally {
      transcribing.value = false
    }
  }

  /**
   * 任意音频容器 → 16kHz 单声道 WAV。
   * 用 AudioContext 解码：浏览器的解码器天然支持自己录出来的 webm/opus，
   * 所以不论 MediaRecorder 产出什么格式，最后统一成 Whisper 一定吃的 WAV。
   */
  async function blobToWav(blob: Blob): Promise<Uint8Array> {
    const buffer = await blob.arrayBuffer()
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!Ctx) throw new Error('当前浏览器不支持音频解码')

    const ctx = new Ctx()
    try {
      const audio = await ctx.decodeAudioData(buffer)
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
      return encodeWav16k(channels, audio.sampleRate)
    }
    finally {
      void ctx.close()
    }
  }

  function releaseStream() {
    mediaStream?.getTracks().forEach(track => track.stop())
    mediaStream = null
    recorder = null
  }

  /** 清空文字与提示，便于开始下一轮 */
  function reset() {
    speech.reset()
    transcript.value = ''
    error.value = null
    notice.value = ''
    provider.value = 'web-speech'
  }

  onScopeDispose(() => {
    if (autoStopTimer) clearTimeout(autoStopTimer)
    stopSilenceMonitor()
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      }
      catch {
        // 忽略
      }
    }
    releaseStream()
  })

  return {
    isSupported,
    isActive,
    isListening: isActive,
    provider,
    speechSupported,
    recording,
    transcribing,
    recordElapsed,
    transcript,
    interim,
    error,
    notice,
    start,
    stop,
    reset,
  }
}

/** getUserMedia 的异常翻译 */
function describeMediaError(err: unknown) {
  const name = (err as DOMException | undefined)?.name

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '麦克风权限被拒绝，请在地址栏允许后重试'
    case 'NotFoundError':
      return '没有检测到可用的麦克风'
    case 'NotReadableError':
      return '麦克风被其他程序占用'
    default:
      return `录音启动失败：${(err as Error)?.message ?? String(err)}`
  }
}

/** /api/transcribe 的异常翻译 */
function describeFetchError(err: unknown) {
  const error = err as { statusMessage?: string, data?: { statusMessage?: string, message?: string }, message?: string }

  // Nitro 的 createError 会把 statusMessage 带到 data 里
  return error?.data?.statusMessage
    ?? error?.statusMessage
    ?? error?.data?.message
    ?? error?.message
    ?? '语音识别失败'
}
