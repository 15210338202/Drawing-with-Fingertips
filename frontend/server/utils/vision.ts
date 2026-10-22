import { cleanKeywords } from '../../utils/insight'

/**
 * llava 看图取英文关键词。
 *
 * 抽成 server/utils 是因为两个路由都要用：
 * - /api/analyze-sketch：给共情解读提供视觉线索；
 * - /api/agent：用户说「随便来一个」时，先猜画面内容再挑画风。
 *
 * 失败不抛异常，返回 error 让调用方决定怎么降级（这两个功能都不该因为看图失败而整体挂掉）。
 */

const LLAVA_MODEL = '@cf/llava-hf/llava-1.5-7b-hf'

/** llava 很慢（实测 9–20 秒），给足时间 */
const LLAVA_TIMEOUT = 45000

export interface VisionResult {
  /** 清洗后的英文关键词，例：cat, triangle, oval, eyes */
  keywords: string
  /** 失败原因；成功时为 undefined */
  error?: string
}

export async function extractVisualKeywords(bytes: Buffer): Promise<VisionResult> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !apiToken) {
    return { keywords: 'abstract lines, shapes', error: '缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN' }
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${LLAVA_MODEL}`

  try {
    // 实测：llava 只接受 JSON 里的字节数组，multipart 会报「图片无法解码」
    const result = await $fetch<{
      result?: { description?: string, response?: string }
      errors?: { message?: string }[]
    }>(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        prompt: 'List 5-10 English keywords describing the main objects, shapes and colors of this hand-drawn sketch. '
          + 'Output keywords separated by commas, nouns and colors only, no sentences.',
        image: Array.from(bytes),
        max_tokens: 60,
      },
      timeout: LLAVA_TIMEOUT,
    })

    // 不同版本可能叫 description / response，两个都取
    const raw = result?.result?.description ?? result?.result?.response ?? ''
    return { keywords: cleanKeywords(raw) }
  }
  catch (err) {
    const reason = describeError(err)
    console.error('[vision] llava 失败：', reason)
    return { keywords: 'abstract lines, shapes', error: reason }
  }
}

function describeError(err: unknown) {
  const error = err as { name?: string, message?: string, data?: unknown }

  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message ?? '')) {
    return 'llava 超时'
  }

  const data = error?.data as { errors?: { message?: string }[], message?: string } | string | undefined

  if (typeof data === 'string') return data.slice(0, 200)
  if (data?.errors?.[0]?.message) return data.errors[0].message
  if (data?.message) return data.message

  return error?.message || 'llava 调用失败'
}
