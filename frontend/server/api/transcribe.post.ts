/**
 * Cloudflare Workers AI Whisper 兜底。
 *
 * 位置：/api/transcribe
 * 免费额度：41.14 neurons/分钟 → 每天 10000 neurons 约合 240 分钟音频。
 *
 * 实测（2026-10-20）：
 * - multipart 的 `audio` 字段和 JSON 的 `audio` 字节数组都被接受，返回 { result: { text } }
 * - 1 秒音频约 3–4.8s（含网络），比 Web Speech 慢，所以只做兜底
 */
const MODEL = '@cf/openai/whisper'

/** 上游最多等 60 秒：长一点的句子 + 排队也要留余量 */
const UPSTREAM_TIMEOUT = 60000

/** 客户端传来的 base64 上限（约 8MB，对应 16kHz 单声道 WAV 约 4 分钟） */
const MAX_BASE64_LENGTH = 11_000_000

/** 失败原因截断长度 */
const REASON_MAX_LENGTH = 200

interface TranscribeResponse {
  text: string
  costMs: number
  provider: 'cloudflare-whisper'
}

export default defineEventHandler(async (event): Promise<TranscribeResponse> => {
  const startedAt = Date.now()

  const body = await readBody<{ audioBase64?: unknown }>(event)
  const raw = typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : ''

  if (!raw) {
    throw createError({ statusCode: 400, statusMessage: 'audioBase64 不能为空' })
  }

  // 允许带 data:audio/wav;base64, 前缀，统一剥掉
  const commaAt = raw.indexOf(',')
  const pureBase64 = raw.startsWith('data:') && commaAt >= 0
    ? raw.slice(commaAt + 1).replace(/\s+/g, '')
    : raw.replace(/\s+/g, '')

  if (pureBase64.length > MAX_BASE64_LENGTH) {
    throw createError({ statusCode: 413, statusMessage: '录音太长，请控制在 4 分钟以内' })
  }

  const bytes = Buffer.from(pureBase64, 'base64')
  if (bytes.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'audioBase64 解码后是空数据' })
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !apiToken) {
    throw createError({
      statusCode: 500,
      statusMessage: '服务端没有配置 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN',
    })
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`

  try {
    // multipart 比 JSON 字节数组省一大圈体积（JSON 会把每个字节写成十进制数字）
    const form = new FormData()
    form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav')

    const result = await $fetch<{ result?: { text?: string }, errors?: { message?: string }[] }>(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
      timeout: UPSTREAM_TIMEOUT,
    })

    const text = (result?.result?.text ?? '').trim()

    if (!text) {
      // Whisper 对静音/噪声会返回空串，这是「没听清」而不是「服务坏了」
      throw createError({ statusCode: 422, statusMessage: '没有识别出内容，请靠近麦克风再说一次' })
    }

    return {
      text,
      costMs: Date.now() - startedAt,
      provider: 'cloudflare-whisper',
    }
  }
  catch (err) {
    // 422 是我们自己抛的「没听清」，原样透传
    const status = (err as { statusCode?: number })?.statusCode
    if (status === 422) throw err

    const reason = describeError(err)
    console.error('[transcribe] Whisper 调用失败：', reason)

    // 解码失败是「音频坏了/格式不对」，属于可重试的输入问题，不该报成上游 502
    if (/decode audio|valid audio format|unsupported|corrupt/i.test(reason)) {
      throw createError({ statusCode: 422, statusMessage: '音频格式无法识别，请重新录一次' })
    }

    throw createError({ statusCode: 502, statusMessage: `语音识别失败：${truncate(reason, REASON_MAX_LENGTH)}` })
  }
})

/**
 * 把上游/网络的异常压成一句人话。
 * 和 /api/generate 一样：ofetch 的 FetchError 里错误体可能在 .data（这里是对象或字符串）。
 */
function describeError(err: unknown) {
  const error = err as { name?: string, message?: string, data?: unknown }

  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message ?? '')) {
    return `上游超时（${UPSTREAM_TIMEOUT / 1000} 秒）`
  }

  const data = error?.data as { errors?: { message?: string }[], message?: string } | string | undefined

  if (typeof data === 'string') return truncate(data, REASON_MAX_LENGTH)
  if (data?.errors?.[0]?.message) return data.errors[0].message
  if (data?.message) return data.message

  return error?.message || '调用 Cloudflare Whisper 失败'
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
