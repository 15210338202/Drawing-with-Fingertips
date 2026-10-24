/**
 * 免提常驻唤醒（Web Speech API）。
 *
 * 和 useVoiceInput 的「按一下说一句」不同：
 * - continuous = true，识别器自己结束后自动重启；
 * - 只有包含唤醒词「小绘」的最终结果才交给上层执行；
 * - TTS 开始前 pause()，结束后 resume()，避免麦克风把小绘自己的声音录进去。
 *
 * 浏览器限制：
 * - Chrome/Edge 的 Web Speech 依赖 Google 云服务，国内网络可能直接 network；这时免提不可用，
 *   不要假装能常驻，应该明确报错；
 * - 识别器在静音一段时间后会自动结束，所以 onend 必须重启；
 * - 常驻监听期间浏览器会一直显示麦克风使用中，这是正常的隐私提示。
 */

export interface HandsFreeOptions {
  /** 识别到「小绘 + 指令」时回调；指令已剥掉唤醒词 */
  onCommand: (command: string, raw: string) => void
}

interface SpeechAlternative {
  transcript: string
}

interface SpeechResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechAlternative
}

interface SpeechResultList {
  readonly length: number
  readonly [index: number]: SpeechResult
}

interface SpeechResultEvent {
  readonly resultIndex: number
  readonly results: SpeechResultList
}

interface SpeechErrorEvent {
  readonly error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechErrorEvent) => void) | null
  onresult: ((event: SpeechResultEvent) => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** 浏览器/口音可能把「小绘」识别成这些同音词 */
const WAKE_WORDS = ['小绘', '小会', '小慧', '小惠', '小灰', '小辉'] as const

const WAKE_PATTERN = new RegExp(
  `^\\s*[，,。.!！?？]?\\s*(?:${WAKE_WORDS.join('|')})[，,。.!！?？\\s]*(.*)$`,
  'u',
)

/** 从一句话里剥出唤醒词后的指令；没有唤醒词返回空串 */
export function extractWakeWordCommand(raw: string): string {
  const match = raw.trim().match(WAKE_PATTERN)
  return match?.[1]?.trim() ?? ''
}

function resolveRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null

  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }

  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

function formatError(code: string) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限被拒绝，免提模式无法启动'
    case 'network':
      return '语音服务网络不通，免提暂时不可用（可改用手动语音）'
    case 'audio-capture':
      return '没找到可用的麦克风'
    default:
      return `免提识别失败：${code}`
  }
}

export function useHandsFree(options: HandsFreeOptions) {
  const supported = ref(false)
  /** 用户是否打开了免提开关 */
  const enabled = ref(false)
  /** 当前是否真的在收音 */
  const listening = ref(false)
  const error = ref('')
  const notice = ref('')
  const lastHeard = ref('')

  let recognition: SpeechRecognitionLike | null = null
  let paused = false
  let disposed = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let lastCommand = ''
  let lastCommandAt = 0

  function clearRestart() {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  function ensureRecognition(): SpeechRecognitionLike | null {
    if (recognition) return recognition

    const Ctor = resolveRecognitionCtor()
    if (!Ctor || (typeof window !== 'undefined' && window.isSecureContext === false)) return null

    const instance = new Ctor()
    instance.lang = 'zh-CN'
    // 常驻监听：浏览器仍可能在静音后自动 end，靠 onend 重启
    instance.continuous = true
    // 常驻模式只要最终结果；否则每一帧草稿都会触发唤醒判断
    instance.interimResults = false
    instance.maxAlternatives = 1

    instance.onstart = () => {
      listening.value = true
      error.value = ''
    }

    instance.onend = () => {
      listening.value = false
      if (!enabled.value || paused || disposed) return
      // Chrome 会在静音后结束；稍等再拉起，避免和权限/设备状态打架
      clearRestart()
      restartTimer = setTimeout(() => {
        restartTimer = null
        startEngine()
      }, 450)
    }

    instance.onerror = (event) => {
      listening.value = false

      if (event.error === 'aborted' && (paused || !enabled.value)) return
      if (event.error === 'no-speech') {
        // 常驻监听里没听到声音是常态，不计错误；onend 会负责重启
        return
      }

      error.value = formatError(event.error)

      // 这些错误继续重试只会刷屏/反复弹权限，直接关掉开关
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed'
        || event.error === 'audio-capture' || event.error === 'network') {
        enabled.value = false
        paused = true
        clearRestart()
      }
    }

    instance.onresult = (event) => {
      // 常驻模式只处理 final；从 resultIndex 开始避免重复处理历史结果
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result?.isFinal) continue

        const raw = (result[0]?.transcript ?? '').trim()
        if (!raw) continue

        lastHeard.value = raw
        const command = extractWakeWordCommand(raw)

        if (!command) {
          // 有声音但没有唤醒词：给一个轻提示，但不要打断常驻监听
          if (WAKE_WORDS.some(word => raw.includes(word))) {
            notice.value = '我在，想让我做什么？'
          }
          continue
        }

        const now = Date.now()
        if (command === lastCommand && now - lastCommandAt < 1200) return

        lastCommand = command
        lastCommandAt = now
        notice.value = `听到：${command}`

        // 指令交给上层执行；先暂停，避免把接下来的 TTS 录进去。
        // 上层处理完（或 TTS 结束）会调用 resume()。
        paused = true
        clearRestart()
        stopEngine()
        options.onCommand(command, raw)
        return
      }
    }

    recognition = instance
    return recognition
  }

  function startEngine() {
    if (!enabled.value || paused || disposed) return
    const instance = ensureRecognition()
    if (!instance) return

    if (listening.value) return

    clearRestart()
    try {
      instance.start()
    }
    catch {
      // Chrome 在尚未完全 end 时重复 start 会抛 InvalidStateError；稍后再试
      clearRestart()
      restartTimer = setTimeout(() => {
        restartTimer = null
        startEngine()
      }, 600)
    }
  }

  function stopEngine() {
    if (!recognition) return
    try {
      recognition.stop()
    }
    catch {
      try {
        recognition.abort()
      }
      catch {
        // 已经停了
      }
    }
    listening.value = false
  }

  /** 打开免提；已经在免提中则恢复监听 */
  function start() {
    if (enabled.value) {
      resume()
      return
    }

    const instance = ensureRecognition()
    if (!instance) {
      supported.value = false
      error.value = '当前浏览器不支持常驻语音识别，建议用 Chrome/Edge'
      return
    }

    supported.value = true
    enabled.value = true
    paused = false
    error.value = ''
    notice.value = ''
    startEngine()
  }

  /** 关闭免提，麦克风也一起停 */
  function stop() {
    enabled.value = false
    paused = false
    clearRestart()
    stopEngine()
    notice.value = ''
  }

  /** TTS 开始前暂停；不改变 enabled，TTS 结束后可 resume */
  function pause() {
    paused = true
    clearRestart()
    stopEngine()
  }

  /** 恢复常驻监听；只在 enabled 时有效 */
  function resume() {
    if (!enabled.value) return
    paused = false
    error.value = ''
    startEngine()
  }

  onMounted(() => {
    supported.value = resolveRecognitionCtor() !== null
      && (typeof window === 'undefined' || window.isSecureContext !== false)
  })

  onScopeDispose(() => {
    disposed = true
    clearRestart()
    if (!recognition) return
    recognition.onstart = null
    recognition.onend = null
    recognition.onerror = null
    recognition.onresult = null
    try {
      recognition.abort()
    }
    catch {
      // 已经停了
    }
  })

  return {
    supported,
    enabled,
    listening,
    error,
    notice,
    lastHeard,
    start,
    stop,
    pause,
    resume,
  }
}
