/**
 * 浏览器原生语音识别（Web Speech API）封装。
 *
 * 定位：**快路径**。不经过任何后端，说一句出一句，延迟接近零。
 * 但它有个致命弱点：Chrome 的识别依赖 Google 的云服务，国内网络大概率报 network 错误。
 * 所以这个 Hook 只负责「能用就用」，失败要把原因暴露出来，交给上层决定是否降级到 Whisper。
 *
 * 兼容性：Chrome / Edge 走 webkitSpeechRecognition；Firefox 完全不支持；Safari 部分支持。
 */

// ===== 最小类型声明：DOM 标准库没有 SpeechRecognition，这里只声明用到的部分 =====

interface SpeechAlternative {
  transcript: string
  confidence: number
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
  readonly message?: string
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

/** 各浏览器把构造器挂在不同的名字上 */
function resolveRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null

  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }

  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/** 把浏览器给的错误码翻译成用户能看懂的话 */
function formatError(code: string) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '浏览器拒绝了麦克风权限'
    case 'network':
      return '语音服务网络不通（Chrome 走 Google 服务，国内需要代理）'
    case 'no-speech':
      return '没听清，再说一次试试'
    case 'audio-capture':
      return '没找到可用的麦克风'
    case 'aborted':
      return '语音识别已取消'
    default:
      return `语音识别失败：${code}`
  }
}

export function useSpeech() {
  /** 浏览器是否支持 */
  const isSupported = ref(false)
  /** 是否正在收音 */
  const isListening = ref(false)
  /** 已经确定下来的文字（逐句累加） */
  const transcript = ref('')
  /** 当前这句的实时草稿（会被不断替换） */
  const interim = ref('')
  /** 出错时的中文提示；正常结束为 null */
  const error = ref<string | null>(null)
  /** 浏览器原始错误码（network / not-allowed / no-speech…），用于决定要不要降级到 Whisper */
  const errorCode = ref<string | null>(null)

  let recognition: SpeechRecognitionLike | null = null
  /** 用户主动 stop() 时置 true，避免把 aborted 当成错误弹出来 */
  let stoppedByUser = false

  /** 懒创建：SSR 阶段不碰 window，也避免每次挂载都 new 一个 */
  function ensureRecognition(): SpeechRecognitionLike | null {
    if (recognition) return recognition

    const Ctor = resolveRecognitionCtor()
    // 非安全上下文（http + 非 localhost）下浏览器不给用麦克风，提前判掉
    if (!Ctor || (typeof window !== 'undefined' && window.isSecureContext === false)) return null

    const instance = new Ctor()
    instance.lang = 'zh-CN'
    // 单句模式：说完自动停，适合「说一句话填进输入框」
    instance.continuous = false
    // 实时出字，用户能看到自己说的话一个字一个字冒出来
    instance.interimResults = true
    instance.maxAlternatives = 1

    instance.onstart = () => {
      isListening.value = true
    }

    instance.onend = () => {
      isListening.value = false
      // 结束时把草稿并进正文，避免最后一句停在 interim 里
      if (interim.value) {
        transcript.value = (transcript.value + interim.value).trim()
        interim.value = ''
      }
    }

    instance.onerror = (event) => {
      isListening.value = false

      // 用户自己点的停止，浏览器也会回一个 aborted，不当错误处理
      if (stoppedByUser && event.error === 'aborted') return

      error.value = formatError(event.error)
      errorCode.value = event.error
      console.warn('[speech] 识别失败，可考虑降级到 Whisper：', event.error)
    }

    instance.onresult = (event) => {
      // 注意：不能只从 resultIndex 开始拼，否则最终文本会丢前面几句。
      // 这里每次都从头遍历，把「已确定」和「草稿」分开存。
      let finalText = ''
      let draftText = ''

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalText += text
        else draftText += text
      }

      transcript.value = finalText
      interim.value = draftText
    }

    recognition = instance
    return recognition
  }

  /** 开始收音。会清空上一次的文字 */
  function start() {
    const instance = ensureRecognition()
    if (!instance) {
      isSupported.value = false
      error.value = '当前浏览器不支持语音识别，建议用 Chrome/Edge'
      return
    }

    isSupported.value = true

    if (isListening.value) return

    transcript.value = ''
    interim.value = ''
    error.value = null
    errorCode.value = null
    stoppedByUser = false

    try {
      instance.start()
    }
    catch (err) {
      // 重复 start() 在 Chrome 里会抛 InvalidStateError，这里吞掉并复位
      isListening.value = false
      error.value = `启动语音识别失败：${(err as Error)?.message ?? String(err)}`
    }
  }

  /** 停止收音（已识别的内容保留） */
  function stop() {
    if (!recognition || !isListening.value) return
    stoppedByUser = true
    recognition.stop()
  }

  /** 清空文字与错误，不影响监听状态 */
  function reset() {
    transcript.value = ''
    interim.value = ''
    error.value = null
    errorCode.value = null
  }

  // 挂载时探一次能力：让按钮能提前显示/隐藏，而不是等用户点了才知道不支持。
  // 必须放在 onMounted 里：SSR 阶段没有 window，直接探会把结果写成 false 并带到水合后的页面。
  onMounted(() => {
    isSupported.value = resolveRecognitionCtor() !== null
      && (typeof window === 'undefined' || window.isSecureContext !== false)
  })

  // 组件销毁时必须 abort：否则麦克风指示灯会一直亮着
  onScopeDispose(() => {
    if (!recognition) return
    recognition.onstart = null
    recognition.onend = null
    recognition.onerror = null
    recognition.onresult = null
    try {
      recognition.abort()
    }
    catch {
      // 已经停了就算了
    }
  })

  return { isSupported, isListening, transcript, interim, error, errorCode, start, stop, reset }
}
