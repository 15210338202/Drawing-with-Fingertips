import stylesData from '../data/styles.json'

/**
 * Cloudflare Workers AI 图像生成。
 *
 * 默认模型 `@cf/black-forest-labs/flux-2-klein-4b`：免费额度内可用的图生图模型
 * （5.37 neurons/输入 tile + 26.05 neurons/输出 tile ≈ 每天 300 张左右，免费计划 10000 neurons/天）。
 * 换模型不用改代码，设环境变量 CLOUDFLARE_IMAGE_MODEL 即可。
 *
 * 踩过的坑，都写在这里免得下次再试：
 * 1. 这个模型只吃 multipart/form-data，JSON 会被 5006「Bad input: required properties are 'multipart'」拒掉。
 * 2. 图片字段名必须是 `input_image_0`（可到 input_image_3）。传 `image` 不会报错，但会被静默忽略 ——
 *    之前用 `image` 测出来的 200 全是假的，等于没传图。
 * 3. 返回是 JSON：{"result":{"image":"<base64 JPEG>"}}，不是二进制流。要自己拼 Data URL。
 * 4. `@cf/black-forest-labs/flux-1-schnell` 和 `@cf/bytedance/stable-diffusion-xl-lightning` 只支持文生图：
 *    前者对多余字段直接 5006 报错，后者报 3030「input tensor `image` is not present」。
 *    所以它们走 TEXT_ONLY_MODELS 分支，只发 prompt。
 * 5. `@cf/runwayml/...` 那批旧模型在本账号下已无权限（5018）。
 */
const DEFAULT_MODEL = '@cf/black-forest-labs/flux-2-klein-4b'

/** 只支持文生图、且对多余字段敏感的模型：只发 prompt，草图不参与生成 */
const TEXT_ONLY_MODELS = new Set([
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/lykon/dreamshaper-8-lcm',
])

/** 服务端等上游的上限。前端 $fetch 给的是 45s（见 composables/useAgent.ts），要留出余量先返回兜底图 */
const UPSTREAM_TIMEOUT = 40000

/** 扩散步数。klein 是蒸馏模型，4 步就够；调大质量略好但更慢 */
const STEPS = 4

/** 提示词引导强度。klein 沿用了 FLUX.2 的 guidance 语义，5 比默认更「听话」于文字描述 */
const GUIDANCE = 5

/** 没传 promptOverride、styleKey 又认不出来时的默认画风（只描述画风，不提具体物体） */
const DEFAULT_STYLE = 'soft artistic illustration, expressive brushwork, balanced composition, high quality'

/**
 * 图生图的提示词。
 *
 * 措辞是实验调出来的，三段各有作用：
 * 1. 第一句把「画什么」交给草图（主体、姿态、布局），模型只负责「怎么画」；
 * 2. 第二句要求自然渲染 —— 早期写「Preserve the linework layout」会让模型把粗线条照描，
 *    生成图里留着生硬的草稿描边；
 * 3. 第三句堵住「模型自己加东西」：旧知识库的 prompt 里带着 "misty mountains" 这类内容词，
 *    实测会让模型在猫背后画出一片山。
 */
const SKETCH_PROMPT = (styleModifiers: string) =>
  `Recreate the subject, pose and layout of the reference sketch as ${styleModifiers}. `
  + 'Keep the same proportions and object placement as the drawing, render them naturally, '
  + 'do not leave visible pencil or sketch lines, and do not add any object that is not in the drawing.'

/** 文生图模型（拿不到草图）时，用内容兜底 + 画风拼一个普通提示词 */
const TEXT_PROMPT = (styleModifiers: string, contentHints: string) =>
  contentHints ? `${contentHints}, ${styleModifiers}` : styleModifiers

/** 兜底图里的提示文案截断长度，避免把上游一长串错误原样糊到页面上 */
const REASON_MAX_LENGTH = 200

/** 最终失败的兜底图：内联 SVG，不依赖任何静态文件（public 里并没有 placeholder.png） */
const PLACEHOLDER_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">'
  + '<rect width="800" height="600" fill="#f3f4f6"/>'
  + '<text x="400" y="288" font-family="sans-serif" font-size="28" fill="#9ca3af" text-anchor="middle">图像生成服务暂时不可用</text>'
  + '<text x="400" y="330" font-family="sans-serif" font-size="18" fill="#c0c4cc" text-anchor="middle">已使用本地占位图，画布功能不受影响</text>'
  + '</svg>',
)}`

interface StyleEntry {
  id: string
  title: string
  tags: string[]
  /** 纯画风/材质描述，不含具体物体 */
  styleModifiers: string
  /** 内容兜底，只有文生图模型用得到 */
  contentHints: string
  negative: string
  source: string
  styleKey: string
}

const STYLES = stylesData as StyleEntry[]

/** 响应契约，前端 `useAgent.ts` 的 GenerateResponse 与此保持一致 */
interface GenerateResponse {
  imageUrl: string
  costMs: number
  provider: 'cloudflare'
  fallback?: boolean
  reason?: string
}

export default defineEventHandler(async (event): Promise<GenerateResponse> => {
  const startedAt = Date.now()

  const body = await readBody<{
    imageBase64?: unknown
    styleKey?: unknown
    strength?: unknown
    promptOverride?: unknown
  }>(event)

  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : ''
  const styleKey = typeof body?.styleKey === 'string' ? body.styleKey.trim() : ''
  const promptOverride = typeof body?.promptOverride === 'string' ? body.promptOverride.trim() : ''
  // strength 前端照旧会传，但这几款 Cloudflare 模型都没有「重绘强度」参数，
  // 这里只做入参兼容，不参与请求（klein 是靠提示词里「照着草图重画」来控制的）。
  void body?.strength

  // 草图必须是 data URL。透明背景的坑在前端 exportSketch() 里已经用白底合成了，这里只挡明显不对的输入。
  if (!imageBase64.startsWith('data:image')) {
    throw createError({ statusCode: 400, statusMessage: 'imageBase64 必须是 data:image 开头的 data URL' })
  }

  // 取出逗号后面的纯 Base64：data:image/png;base64,iVBORw0KG...
  const commaAt = imageBase64.indexOf(',')
  const pureBase64 = commaAt >= 0 ? imageBase64.slice(commaAt + 1).replace(/\s+/g, '') : ''

  if (!pureBase64) {
    throw createError({ statusCode: 400, statusMessage: 'imageBase64 里没有找到 Base64 数据' })
  }

  const style = resolveStyle(styleKey)
  // 画风来源优先级：promptOverride（LLM/前端显式指定）→ 知识库的 styleModifiers → 默认画风。
  // 注意这里只取「画风」：画什么是草图决定的，内容兜底只在文生图分支用。
  const styleModifiers = promptOverride || style?.styleModifiers || DEFAULT_STYLE

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !apiToken) {
    console.warn('[generate] 缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN，直接返回占位图')
    return fail(startedAt, '服务端没有配置 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN')
  }

  const bytes = Buffer.from(pureBase64, 'base64')

  if (bytes.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'imageBase64 解码后是空数据' })
  }

  const model = process.env.CLOUDFLARE_IMAGE_MODEL?.trim() || DEFAULT_MODEL
  const textOnly = TEXT_ONLY_MODELS.has(model)
  // 图生图：构图/形状/主体全交给草图，prompt 只描述画风；
  // 文生图：没有草图可依，才把 contentHints 拼进去，否则画面会空
  const prompt = textOnly
    ? TEXT_PROMPT(styleModifiers, style?.contentHints ?? '')
    : SKETCH_PROMPT(styleModifiers)

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`
  const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}`, Accept: 'image/*' }
  let requestBody: FormData | Record<string, unknown>

  if (textOnly) {
    // flux-1-schnell 之类：JSON + prompt，多余字段会被 5006 拒掉，只发它认识的
    headers['Content-Type'] = 'application/json'
    requestBody = { prompt, steps: STEPS }
  }
  else {
    /*
     * 图生图模型要 multipart：Content-Type 必须交给 fetch 自己带 boundary，
     * 手动设置会把 boundary 写死导致上游解析失败。
     * 图片字段是 input_image_0（不是 image），大小不限死 512 —— 1024×768 的草图实测也能过。
     */
    const form = new FormData()
    form.append('prompt', prompt)
    form.append('steps', String(STEPS))
    form.append('guidance', String(GUIDANCE))
    form.append('input_image_0', new Blob([bytes], { type: sniffDataUrlMime(imageBase64) }), 'sketch.png')
    requestBody = form
  }

  try {
    // 上游两种返回都可能：图生图是 JSON+base64，部分文生图模型是二进制流，统一按 arrayBuffer 收
    const result = await $fetch<ArrayBuffer>(endpoint, {
      method: 'POST',
      headers,
      body: requestBody,
      responseType: 'arrayBuffer',
      timeout: UPSTREAM_TIMEOUT,
    })

    return {
      imageUrl: toDataUrl(new Uint8Array(result)),
      costMs: Date.now() - startedAt,
      provider: 'cloudflare',
    }
  }
  catch (err) {
    // 失败、超时、401/403/429 都走这里：返回占位图，保证前端画布不崩
    const reason = describeError(err)
    console.error('[generate] Cloudflare 图像生成失败：', reason)

    return fail(startedAt, reason)
  }
})

/**
 * 把上游返回值转成前端能直接喂给 <img :src> 的 Data URL。
 *
 * 两种形态都处理：
 * - JSON：{"result":{"image":"<base64>"}}（flux-2-klein 等）
 * - 二进制：PNG/JPEG 字节流（早期模型）
 * 用首字节区分，因为 arrayBuffer 模式下拿不到 Content-Type。
 */
function toDataUrl(bytes: Uint8Array) {
  if (bytes.length === 0) throw new Error('上游返回了空响应')

  if (bytes[0] === 0x7B /* { */) {
    const payload = parseJson(new TextDecoder().decode(bytes)) as
      | { result?: { image?: string }, errors?: { message?: string }[], image?: string }
      | undefined

    // 有 result.image 就是成功；否则是错误体
    const b64 = payload?.result?.image ?? payload?.image
    if (b64) {
      const imageBytes = Buffer.from(stripDataUrl(b64), 'base64')
      if (imageBytes.length === 0) throw new Error('上游返回的 base64 图片为空')
      return `data:${sniffMime(imageBytes)};base64,${imageBytes.toString('base64')}`
    }

    throw new Error(payload?.errors?.[0]?.message ?? '上游返回了 JSON 但没有图片数据')
  }

  return `data:${sniffMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 有些模型的 base64 自带 data: 前缀，统一剥掉 */
function stripDataUrl(value: string) {
  const commaAt = value.indexOf(',')
  return value.startsWith('data:') && commaAt >= 0 ? value.slice(commaAt + 1) : value
}

/** 从入参 data URL 的头部取 mime，取不到就按 png */
function sniffDataUrlMime(dataUrl: string) {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1] ?? 'image/png'
}

/** 按文件头判断图片类型，避免把 JPEG 硬标成 PNG（上游 Content-Type 并不总是准） */
function sniffMime(bytes: Uint8Array) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg'
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return 'image/png'
}

/** 统一失败返回：占位图 + fallback 标记 + 原因，costMs 从进入 handler 开始算 */
function fail(startedAt: number, reason: string): GenerateResponse {
  return {
    imageUrl: PLACEHOLDER_IMAGE,
    costMs: Date.now() - startedAt,
    provider: 'cloudflare',
    fallback: true,
    reason: truncate(reason, REASON_MAX_LENGTH),
  }
}

/**
 * 把各种异常压成一句人话。
 * ofetch 的 FetchError 里，上游的 JSON 错误体可能在 .data（这里是 ArrayBuffer），
 * 也可能已经被解析成对象，两种都得捞一遍。
 */
function describeError(err: unknown) {
  const error = err as { name?: string; message?: string; data?: unknown; cause?: unknown }

  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message ?? '')) {
    return `上游请求超时（${UPSTREAM_TIMEOUT / 1000} 秒）`
  }

  // undici 的连接超时不会体现在 FetchError.message 里，只会藏在 cause；
  // 不单独识别的话，前端只能看到一串 "[POST] https://..."，误以为是业务错误。
  const cause = error?.cause as { code?: string, name?: string, message?: string } | undefined
  if (
    cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
    || cause?.name === 'ConnectTimeoutError'
    || /connect timeout/i.test(cause?.message ?? '')
  ) {
    return '连接 Cloudflare 超时（服务器网络暂时无法访问 api.cloudflare.com）'
  }
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') {
    return '无法解析 api.cloudflare.com（检查服务器 DNS / 网络）'
  }

  const fromData = extractMessage(error?.data)
  if (fromData) return fromData

  const fromCause = extractMessage((error?.cause as { data?: unknown } | undefined)?.data)
  if (fromCause) return fromCause

  // ofetch 的 message 形如 `[POST] "https://api.cloudflare.com/...": <no response>`；
  // 这串东西对用户没有意义，换成能行动的提示，完整错误仍然由上面的 console.error 记录。
  if (error?.message?.startsWith('[POST]')) {
    return '无法连接 Cloudflare 图像服务（检查服务器网络或代理后重试）'
  }

  return error?.message || '调用 Cloudflare Workers AI 失败'
}

/** 从 string / ArrayBuffer / 对象里捞出 Cloudflare 的 errors[0].message */
function extractMessage(data: unknown): string | undefined {
  if (!data) return undefined

  if (data instanceof ArrayBuffer) return parseCloudflareMessage(new TextDecoder().decode(data))
  if (ArrayBuffer.isView(data)) {
    return parseCloudflareMessage(new TextDecoder().decode(data as Uint8Array))
  }
  if (typeof data === 'string') return parseCloudflareMessage(data)
  if (typeof data === 'object') return parseCloudflareMessage(JSON.stringify(data))

  return undefined
}

/** Cloudflare 的错误体形如 {"errors":[{"message":"...","code":5018}],"success":false} */
function parseCloudflareMessage(raw: string): string | undefined {
  const text = raw.trim()
  if (!text) return undefined

  const parsed = parseJson(text) as { errors?: { message?: string }[], message?: string } | undefined
  const first = parsed?.errors?.[0]?.message
  if (first) return first
  if (parsed?.message) return parsed.message

  // 不是 JSON：可能是 HTML 错误页，截一段出来也能给个大致方向
  return truncate(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), REASON_MAX_LENGTH)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/**
 * 用 styleKey 找风格。LLM 给的 styleKey 经常是它自己编的（比如 "guofeng"），
 * 所以这里做多级兜底：styleKey → id → 标题 → 标签 → 模糊包含，都能接受。
 */
function resolveStyle(key: string) {
  if (!key) return undefined

  const target = key.trim().toLowerCase()

  return STYLES.find(s => s.styleKey.toLowerCase() === target)
    ?? STYLES.find(s => s.id.toLowerCase() === target)
    ?? STYLES.find(s => s.title.toLowerCase() === target)
    ?? STYLES.find(s => s.tags.some(tag => tag.toLowerCase() === target))
    ?? STYLES.find(s => s.styleKey.toLowerCase().includes(target) || target.includes(s.styleKey.toLowerCase()))
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
