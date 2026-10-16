import stylesData from '../data/styles.json'

/** 通义万相（DashScope）异步任务接口 */
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1'
const DASHSCOPE_CREATE = `${DASHSCOPE_BASE}/services/aigc/image2image/image-synthesis`

/** 图像编辑模型；具体可用型号以阿里云控制台为准，改这里就行 */
const MODEL = 'wanx2.1-imageedit'

/** 轮询参数：总超时 30 秒，每 2 秒查一次 */
const POLL_INTERVAL = 2000
const TOTAL_TIMEOUT = 30000
/** 整体最多试 2 次（失败重试 1 次） */
const MAX_ATTEMPTS = 2

/**
 * 最终失败的兜底图：内联 SVG，不依赖任何静态文件。
 * （用 /placeholder.png 的话 public 里并没有这个文件，会直接 404 破图。）
 */
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
  prompt: string
  negative: string
  source: string
  styleKey: string
}

const STYLES = stylesData as StyleEntry[]

interface DashScopeOutput {
  task_id?: string
  task_status?: string
  message?: string
  results?: { url?: string }[]
}

interface DashScopeResponse {
  output?: DashScopeOutput
  message?: string
}

export default defineEventHandler(async (event) => {
  const startedAt = Date.now()

  const body = await readBody<{
    imageBase64?: unknown
    styleKey?: unknown
    strength?: unknown
    promptOverride?: unknown
  }>(event)

  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : ''
  const styleKey = typeof body?.styleKey === 'string' ? body.styleKey : ''
  const promptOverride = typeof body?.promptOverride === 'string' ? body.promptOverride.trim() : ''
  const strength = clamp01(Number(body?.strength) || 0.6)

  // 草图必须是 data URL。透明背景的坑在前端 exportSketch() 里已经用白底合成了，
  // 这里只做格式校验，挡住明显不对的输入。
  if (!imageBase64.startsWith('data:image')) {
    throw createError({ statusCode: 400, statusMessage: 'imageBase64 必须是 data:image 开头的 data URL' })
  }

  const style = resolveStyle(styleKey)
  const prompt = promptOverride || style?.prompt

  if (!prompt) {
    throw createError({
      statusCode: 400,
      statusMessage: `不认识的 styleKey「${styleKey}」，也没有给 promptOverride`,
    })
  }

  const apiKey = process.env.DASHSCOPE_API_KEY

  if (!apiKey) {
    console.warn('[generate] 缺少 DASHSCOPE_API_KEY，直接返回占位图')
    return {
      imageUrl: PLACEHOLDER_IMAGE,
      costMs: Date.now() - startedAt,
      provider: 'fallback',
      fallback: true,
      reason: '服务端没有配置 DASHSCOPE_API_KEY',
    }
  }

  let lastError = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const taskId = await createTask(apiKey, {
        imageBase64,
        prompt,
        negative: style?.negative,
        strength,
      })

      if (!taskId) throw new Error('上游没有返回 task_id')

      const imageUrl = await waitForTask(apiKey, taskId)

      return {
        imageUrl,
        costMs: Date.now() - startedAt,
        provider: 'tongyi',
      }
    } catch (err) {
      lastError = (err as Error)?.message ?? String(err)
      console.error(`[generate] 第 ${attempt}/${MAX_ATTEMPTS} 次失败：`, lastError)
    }
  }

  // 两次都失败：返回占位图，保证演示不崩（答辩会问"图像服务挂了怎么办"）
  return {
    imageUrl: PLACEHOLDER_IMAGE,
    costMs: Date.now() - startedAt,
    provider: 'fallback',
    fallback: true,
    reason: lastError,
  }
})

interface CreateTaskInput {
  imageBase64: string
  prompt: string
  negative?: string
  strength: number
}

/** 第一步：创建异步任务，拿到 task_id */
async function createTask(apiKey: string, input: CreateTaskInput) {
  // strength 是给二创强度用的：图像编辑模型没有直接的 strength 参数，
  // 而是用 function 区分「整体重绘」和「局部重绘」，这里按强度二选一
  const fn = input.strength >= 0.5 ? 'stylization_all' : 'stylization_local'

  const res = await $fetch<DashScopeResponse>(DASHSCOPE_CREATE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // 图像生成是异步的：先拿 task_id，再轮询结果
      'X-DashScope-Async': 'enable',
    },
    body: {
      model: MODEL,
      input: {
        function: fn,
        prompt: input.prompt,
        negative_prompt: input.negative,
        base_image_url: input.imageBase64,
      },
      parameters: { n: 1 },
    },
    timeout: 15000,
  })

  return res?.output?.task_id
}

/** 第二步：轮询任务，直到 SUCCEEDED / FAILED / 超时 */
async function waitForTask(apiKey: string, taskId: string) {
  const deadline = Date.now() + TOTAL_TIMEOUT

  while (Date.now() < deadline) {
    const output = await queryTask(apiKey, taskId)
    const status = output?.task_status

    if (status === 'SUCCEEDED') {
      const url = output?.results?.[0]?.url
      if (!url) throw new Error('任务成功但没有返回图片地址')
      return url
    }

    // 任务态：PENDING → RUNNING → SUCCEEDED / FAILED
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(output?.message || `任务状态 ${status}`)
    }

    await sleep(POLL_INTERVAL)
  }

  throw new Error(`等待生成超时（${TOTAL_TIMEOUT / 1000} 秒）`)
}

async function queryTask(apiKey: string, taskId: string) {
  const res = await $fetch<DashScopeResponse>(`${DASHSCOPE_BASE}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
  })

  return res?.output
}

/**
 * 用 styleKey 找风格。LLM 给的 styleKey 经常是它自己编的（比如 "guofeng"），
 * 所以这里做三级兜底：styleKey → id → 标题或标签能对上，都能接受。
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

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0.6
  return Math.min(1, Math.max(0, value))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
