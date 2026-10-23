/**
 * 浏览器原生语音合成（Web Speech API）封装。
 *
 * 只做“念出来”这一件事：
 * - 优先选自然中文声：晓晓 / 云希 / 慧慧 / Ting-Ting / Mei-Jia；
 * - 浏览器的语音列表是异步加载的：空列表时等 voiceschanged，再带一个超时兜底，
 *   避免刚进页面就退回机械的默认音；
 * - 上一句还在念时才取消，并留 60ms 给 Chrome 稳定，避免 cancel 把新一句吞掉；
 * - 不支持时静默降级，不影响生图/猜画主流程。
 *
 * 注意：Chrome 的 speechSynthesis 通常要页面有过一次用户交互才允许发声。
 * 我们都是在“开摄像头 / 点按钮 / 比 👍”之后调用，正常不会被拦。
 */

import { onScopeDispose, ref } from 'vue'

export interface SpeakOptions {
  /** 语速，0.5–2，默认 0.95（比新闻播报慢一点，更自然） */
  rate?: number
  /** 音调，0–2，默认 1.05（稍微柔和一点，不机械） */
  pitch?: number
  /** 音量，0–1，默认 1 */
  volume?: number
  /** 语言，默认 zh-CN */
  lang?: string
}

/** 浏览器是否支持语音合成（SSR 阶段恒为 false，不要拿它做首屏渲染分支） */
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

/** 等 voiceschanged 的上限；等不到就先用默认音，不让用户干等 */
const VOICE_WAIT_MS = 1000

/**
 * Chrome 的 speechSynthesis 有个老问题：cancel() 之后立刻 speak()，
 * 新的一句可能被吞掉（表现就是“时有时没有”）。取消后留一点时间让引擎稳定。
 */
const CANCEL_SETTLE_MS = 60

/**
 * 按“自然音质”排的优先关键词。
 * 云希是男声；如果只想要女声，把 Yunxi 两项删掉即可。
 */
const NATURAL_VOICE_PRIORITY = [
  'Xiaoxiao Online',
  'Xiaoxiao',
  'Yunxi Online',
  'Yunxi',
  'Huihui Online',
  'Huihui',
  'Ting-Ting',
  'Mei-Jia',
  'Yaoyao',
  'Xiaoyi',
] as const

/** 只在开发环境或 ?tts=1 时打印选中的音色，生产控制台不刷屏 */
const LOG_TTS = typeof location !== 'undefined'
  && (import.meta.dev || new URLSearchParams(location.search).has('tts'))

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function readVoices(): SpeechSynthesisVoice[] {
  if (!canSpeak) return []
  try {
    return window.speechSynthesis.getVoices()
  }
  catch {
    return []
  }
}

/**
 * 挑一个中文声音。
 *
 * 先限定 zh-CN，找不到再放宽到所有 zh，避免 macOS 的 Mei-Jia（zh-TW）永远选不到；
 * 优先级列表里命中哪个用哪个，最后才退回第一个中文音。
 */
function pickBestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const zhVoices = voices.filter(voice => /^zh(?:[-_]|$)/i.test(voice.lang ?? ''))
  if (!zhVoices.length) return null

  const zhCNVoices = zhVoices.filter(voice => /^zh[-_]CN$/i.test(voice.lang ?? ''))
  const pool = zhCNVoices.length ? zhCNVoices : zhVoices

  for (const keyword of NATURAL_VOICE_PRIORITY) {
    const match = pool.find(voice =>
      voice.name.toLowerCase().includes(keyword.toLowerCase()),
    )
    if (match) return match
  }

  return pool.find(voice => /natural|online/i.test(voice.name))
    ?? pool.find(voice => /female|女/i.test(voice.name))
    ?? pool[0]
}

/**
 * 等浏览器把语音列表加载出来。
 *
 * 有些浏览器第一次 getVoices() 返回空数组，之后才触发 voiceschanged；
 * 这里监听事件，并加超时兜底。监听注册后会再查一次，避免刚好错过的空档。
 */
function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis
  const immediate = readVoices()
  if (immediate.length) return Promise.resolve(immediate)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    function cleanup() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (typeof synth.removeEventListener === 'function') {
        synth.removeEventListener('voiceschanged', onChanged)
      }
      else if (synth.onvoiceschanged === onChanged) {
        synth.onvoiceschanged = null
      }
    }

    function finish() {
      if (settled) return
      settled = true
      cleanup()
      resolve(readVoices())
    }

    function onChanged() {
      finish()
    }

    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', onChanged)
    }
    else {
      synth.onvoiceschanged = onChanged
    }

    timer = setTimeout(finish, VOICE_WAIT_MS)

    // 注册监听后再查一次：可能刚好在 getVoices() 和 addEventListener 之间加载完
    if (readVoices().length) finish()
  })
}

export function useTTS() {
  /** 是否正在念；只用于界面上的小状态，不参与业务判断 */
  const speaking = ref(false)
  /** 当前这条，用来忽略被 cancel 掉的旧回调和还没开始就过期的等待 */
  let current: SpeechSynthesisUtterance | null = null

  /** 立刻停止当前朗读；页面卸载/关摄像头时调用，避免声音跟着走 */
  function stop() {
    if (!canSpeak) {
      speaking.value = false
      return
    }

    current = null
    window.speechSynthesis.cancel()
    speaking.value = false
  }

  /**
   * 念一段中文。
   *
   * @returns 是否成功把任务交给浏览器（不代表已经念完）
   */
  function speak(text: string, options: SpeakOptions = {}) {
    const content = text.trim()
    if (!content || !canSpeak) return false

    const synth = window.speechSynthesis
    // 上一句没念完才取消：反馈语音要跟当前动作走，不排队。
    // 没有正在念的时候不要无脑 cancel —— Chrome 会因此吞掉紧接着的 speak()。
    const hadActive = Boolean(current) || synth.speaking || synth.pending
    let cancelAt = 0
    if (hadActive) {
      try {
        synth.cancel()
        cancelAt = Date.now()
      }
      catch {
        // 个别浏览器 cancel 会抛错，不影响后面 speak
      }
    }

    let utterance: SpeechSynthesisUtterance
    try {
      utterance = new SpeechSynthesisUtterance(content)
    }
    catch (err) {
      console.warn('[tts] 创建语音失败：', err)
      return false
    }

    utterance.lang = options.lang ?? 'zh-CN'
    utterance.rate = clamp(options.rate ?? 0.95, 0.5, 2)
    utterance.pitch = clamp(options.pitch ?? 1.05, 0, 2)
    utterance.volume = clamp(options.volume ?? 1, 0, 1)

    current = utterance
    utterance.onstart = () => {
      if (current === utterance) speaking.value = true
    }
    utterance.onend = () => {
      // 已经被新一句替换/主动 stop 的旧回调不要改状态
      if (current !== utterance) return
      current = null
      speaking.value = false
    }
    utterance.onerror = (event) => {
      if (current === utterance) {
        current = null
        speaking.value = false
      }
      // canceled / interrupted 是我们自己 cancel 造成的，不算错误
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        console.warn('[tts] 朗读失败：', event.error)
      }
    }

    /** 音色列表就绪后真正开始念；等待期间被新一句/stop 顶掉就放弃 */
    const startWith = (voices: SpeechSynthesisVoice[]) => {
      if (current !== utterance) return

      const voice = pickBestVoice(voices)
      if (voice) {
        try {
          utterance.voice = voice
        }
        catch {
          // 少数浏览器的 voice 对象跨实例会赋值失败，退回默认音也能念
        }
        if (LOG_TTS) console.info('[tts] 使用音色：', voice.name)
      }
      else if (LOG_TTS) {
        console.info('[tts] 没有可用的中文音色，使用浏览器默认音')
      }

      const launch = () => {
        if (current !== utterance) return

        // Chrome 有时会停在 paused 状态，resume 一下比直接 speak 稳
        try {
          synth.resume()
        }
        catch {
          // 不支持 resume 的浏览器忽略即可
        }

        try {
          synth.speak(utterance)
        }
        catch (err) {
          if (current === utterance) current = null
          speaking.value = false
          console.warn('[tts] 启动语音合成失败：', err)
        }
      }

      // cancel() 和 speak() 之间留一点间隔；等音色已经等了一会儿的，就不用再等
      const settle = cancelAt ? Math.max(0, CANCEL_SETTLE_MS - (Date.now() - cancelAt)) : 0
      if (settle > 0) setTimeout(launch, settle)
      else launch()
    }

    // 列表已经就绪就直接选；否则等 voiceschanged，最多等 1 秒
    const voices = readVoices()
    if (voices.length) {
      startWith(voices)
    }
    else {
      void waitForVoices()
        .then(startWith)
        .catch((err) => {
          if (current === utterance) current = null
          speaking.value = false
          console.warn('[tts] 等待音色列表失败：', err)
        })
    }

    return true
  }

  // 组件销毁时停掉，避免离开页面后还在说话
  onScopeDispose(stop)

  return { supported: canSpeak, speaking, speak, stop }
}
