/**
 * 音频转码：任意采样率的多声道 PCM → 16kHz 单声道 16bit WAV。
 *
 * 为什么要转：浏览器 MediaRecorder 默认产出 webm/opus，而 Whisper 端的解码能力不该赌
 * （实测 WAV 一定收，webm 没条件验证）。统一转成「16kHz 单声道 WAV」有两个好处：
 * 1. 格式确定能解，不依赖浏览器的容器；
 * 2. 16kHz 正好是语音识别的标准输入，体积也只有 48kHz 的三分之一。
 */

/** Whisper 期望的采样率 */
export const TARGET_SAMPLE_RATE = 16000

/** WAV 头固定 44 字节 */
const WAV_HEADER_BYTES = 44

/**
 * 多声道 → 单声道（按声道求平均），再线性插值重采样到 16kHz。
 *
 * 线性插值对语音足够了：真正的高质量重采样需要低通滤波，成本高，而识别模型对这点
 * 混叠不敏感。输入长度变化时用比例映射，避免重采样后时长漂移。
 */
export function downmixAndResample(channels: Float32Array[], sampleRate: number): Float32Array {
  const frames = channels[0]?.length ?? 0
  if (!frames) return new Float32Array(0)

  // 1. 多声道相加求平均
  const mono = new Float32Array(frames)
  for (const channel of channels) {
    const count = Math.min(frames, channel.length)
    for (let i = 0; i < count; i++) mono[i] += channel[i] / channels.length
  }

  // 2. 采样率已经是 16k 就不用重采样
  if (Math.abs(sampleRate - TARGET_SAMPLE_RATE) < 1) return mono

  const ratio = sampleRate / TARGET_SAMPLE_RATE
  const outLength = Math.max(1, Math.floor(frames / ratio))
  const out = new Float32Array(outLength)

  for (let i = 0; i < outLength; i++) {
    const src = i * ratio
    const left = Math.floor(src)
    const right = Math.min(frames - 1, left + 1)
    const frac = src - left

    out[i] = mono[left] * (1 - frac) + mono[right] * frac
  }

  return out
}

/**
 * 把 PCM 编码成 16bit 单声道 WAV。
 *
 * @param channels 各声道样本（Float32，范围 -1～1）
 * @param sampleRate 原始采样率
 */
export function encodeWav16k(channels: Float32Array[], sampleRate: number): Uint8Array {
  const pcm = downmixAndResample(channels, sampleRate)
  const bytesPerSample = 2

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.length * bytesPerSample)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  // ===== RIFF 头 =====
  writeAscii(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)   // 除 'RIFF' + 长度 之外的字节数
  writeAscii(8, 'WAVE')

  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)                     // fmt 块长度
  view.setUint16(20, 1, true)                      // 1 = PCM
  view.setUint16(22, 1, true)                      // 单声道
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true) // 每秒字节数
  view.setUint16(32, bytesPerSample, true)         // 块对齐
  view.setUint16(34, 16, true)                     // 位深

  writeAscii(36, 'data')
  view.setUint32(40, pcm.length * bytesPerSample, true)

  // ===== 采样数据：Float32 → Int16，并钳位防削顶溢出 =====
  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, Math.round(clamped * 32767), true)
    offset += bytesPerSample
  }

  return new Uint8Array(buffer)
}

/**
 * Uint8Array → base64。
 * 分块拼接：一次性 String.fromCharCode(...bytes) 在几十万字节时会爆栈。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }

  return btoa(binary)
}
