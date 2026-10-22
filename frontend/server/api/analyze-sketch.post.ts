import {
  buildInsightPrompt, extractJson, FALLBACK_INSIGHT,
  normalizeInsight, normalizeTone,
} from '~/utils/insight'
import type { Insight } from '~/utils/insight'
import { extractVisualKeywords } from '../utils/vision'

/**
 * P2-10 多模态共情式解读。
 *
 * 「看」和「说」分离：
 * 1. llava 只看图吐英文关键词（它中文差、爱说废话，不适合直接面向用户）；
 * 2. DeepSeek 只负责把关键词讲成温柔的中文（它看不见图，所以不能让它编画面细节）。
 *
 * 实测（2026-10-20）：llava 用 REST + JSON 字节数组可调，约 17s；DeepSeek 3～8s。
 * 两级都有兜底，任何一级挂掉都给用户一句能看的话，绝不 500。
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
/** 和 chat.post.ts 保持同一个模型 id */
const DEEPSEEK_MODEL = 'deepseek-flash'

/** 只要一段短 JSON，30 秒足够 */
const DEEPSEEK_TIMEOUT = 30000

/** 客户端传来的 base64 上限 */
const MAX_BASE64_LENGTH = 8_000_000

interface AnalyzePayload extends Insight {
  /** 喂给 DeepSeek 的视觉关键词（调试用） */
  keywords: string
  /** 降级情况：none=全链路正常 */
  degrade: 'none' | 'llava' | 'deepseek' | 'both'
  /** 降级原因（给控制台和 UI 提示） */
  reason?: string
  costMs: number
}

export default defineEventHandler(async (event): Promise<{ success: true, data: AnalyzePayload }> => {
  const startedAt = Date.now()

  const body = await readBody<{ imageBase64?: unknown, tone?: unknown }>(event)

  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : ''
  const tone = normalizeTone(body?.tone)

  if (!imageBase64.startsWith('data:image')) {
    throw createError({ statusCode: 400, statusMessage: 'imageBase64 必须是 data:image 开头的 data URL' })
  }

  const commaAt = imageBase64.indexOf(',')
  const pureBase64 = commaAt >= 0 ? imageBase64.slice(commaAt + 1).replace(/\s+/g, '') : ''

  if (!pureBase64) throw createError({ statusCode: 400, statusMessage: 'imageBase64 里没有 Base64 数据' })
  if (pureBase64.length > MAX_BASE64_LENGTH) {
    throw createError({ statusCode: 413, statusMessage: '图片太大，请重新导出后再试' })
  }

  const bytes = Buffer.from(pureBase64, 'base64')
  if (bytes.length === 0) throw createError({ statusCode: 400, statusMessage: 'imageBase64 解码后是空数据' })

  // ===== 第一步：llava 看图 → 英文关键词 =====
  const vision = await extractKeywords(bytes)
  const keywords = vision.keywords

  // ===== 第二步：DeepSeek 把关键词讲成中文 =====
  const writing = await composeInsight(tone, keywords)

  // 解析失败（模型没给 JSON）时就当这一步降级，用兜底文案
  const parsed = writing.raw ? extractJson(writing.raw) : null
  const insight = parsed
    ? normalizeInsight(parsed, tone)
    : { ...FALLBACK_INSIGHT, tone }

  const degrade: AnalyzePayload['degrade']
    = vision.error && writing.error ? 'both'
      : vision.error ? 'llava'
        : writing.error || !parsed ? 'deepseek'
          : 'none'

  const reasons = [vision.error, writing.error].filter(Boolean)

  return {
    success: true,
    data: {
      ...insight,
      keywords,
      degrade,
      reason: reasons.length ? reasons.join(' / ') : undefined,
      costMs: Date.now() - startedAt,
    },
  }
})

/**
 * 调 llava 取视觉关键词。
 * 实现已抽到 server/utils/vision.ts：/api/agent 在「随便来一个」时也要用同一份逻辑，
 * 两边共用才能保证「看图」这件事的行为一致。
 */
function extractKeywords(bytes: Buffer) {
  return extractVisualKeywords(bytes)
}

/** 调 DeepSeek 生成共情文案；失败不抛，返回 error 让上层走兜底 */
async function composeInsight(tone: Parameters<typeof buildInsightPrompt>[0], keywords: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY

  if (!apiKey) {
    // 没配 key 不算「失败」，只是这一步跳过，用固定文案兜底
    return { raw: '', error: '缺少 DEEPSEEK_API_KEY（frontend/.env）' }
  }

  try {
    const res = await $fetch<{ choices?: { message?: { content?: string } }[] }>(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'system', content: buildInsightPrompt(tone, keywords) }],
        // 强制 JSON，少一层解析容错
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 500,
      },
      timeout: DEEPSEEK_TIMEOUT,
    })

    const content = res?.choices?.[0]?.message?.content ?? ''
    if (!content) return { raw: '', error: 'DeepSeek 返回了空内容' }

    return { raw: content }
  }
  catch (err) {
    const reason = describeUpstreamError(err, 'DeepSeek')
    console.error('[analyze-sketch] DeepSeek 失败：', reason)
    return { raw: '', error: reason }
  }
}

/** 把上游/网络异常压成一句人话（和 /api/generate、/api/transcribe 同一套做法） */
function describeUpstreamError(err: unknown, who: string) {
  const error = err as { name?: string, message?: string, data?: unknown }

  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message ?? '')) {
    return `${who} 超时`
  }

  const data = error?.data as { errors?: { message?: string }[], message?: string } | string | undefined

  if (typeof data === 'string') return data.slice(0, 200)
  if (data?.errors?.[0]?.message) return data.errors[0].message
  if (data?.message) return data.message

  return error?.message || `${who} 调用失败`
}
