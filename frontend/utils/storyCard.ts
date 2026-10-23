/**
 * 「作品故事卡」：把草图、AI 生成图和共情解读排成一张 1000×700 的 PNG。
 *
 * 为什么用原生 Canvas：
 * 1. 不引入 html2canvas 之类的依赖，避免 DOM 截图在跨域图片、字体、transform 上的坑；
 * 2. 卡片是固定版式，直接画比“截一个会随窗口变化的 DOM”稳定；
 * 3. 导出前统一把远程图 fetch 成 dataURL，避免 canvas 被跨域图片污染后 toBlob/click 失败。
 */

const CARD_WIDTH = 1000
const CARD_HEIGHT = 700
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'

/** 画一个圆角矩形路径（不负责 fill/stroke，调用方自己决定） */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/**
 * 按字符换行，最多画 maxLines 行；超出时最后一行补省略号。
 * 中文没有空格，逐字测量比按空格切更可靠；英文单词会被拆开，但卡片正文主要是中文。
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = Number.POSITIVE_INFINITY,
) {
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n')
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    let line = ''
    for (const char of paragraph) {
      const testLine = line + char
      if (line && ctx.measureText(testLine).width > maxWidth) {
        lines.push(line)
        line = char
      }
      else {
        line = testLine
      }
    }
    lines.push(line)
  }

  const visible = lines.slice(0, maxLines)
  if (lines.length > maxLines && visible.length) {
    let last = visible[visible.length - 1]
    while (last && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1)
    }
    visible[visible.length - 1] = `${last}…`
  }

  visible.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight)
  })
}

/** 把远程图先转成 dataURL，避免跨域污染画布；data:/blob: 直接加载 */
async function loadImage(src: string): Promise<HTMLImageElement> {
  let source = src

  if (!src.startsWith('data:') && !src.startsWith('blob:')) {
    const response = await fetch(src)
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
    const blob = await response.blob()
    source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('图片转 dataURL 失败'))
      reader.readAsDataURL(blob)
    })
  }

  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = source
  })
}

/** 等比缩放后完整放进框内（草图用，不能裁掉孩子画的东西） */
function drawImageContain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  padding: number,
) {
  const innerWidth = Math.max(1, width - padding * 2)
  const innerHeight = Math.max(1, height - padding * 2)
  const scale = Math.min(innerWidth / image.width, innerHeight / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale

  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
}

/** 等比缩放后铺满框（生成图用，作为视觉主体） */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.width, height / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale

  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
}

/** 图片相框：白底、圆角、阴影、细边 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  image: HTMLImageElement,
  mode: 'contain' | 'cover',
) {
  // 阴影只跟着白色底走，不跟着裁剪区走，否则图片上会多一层灰。
  ctx.save()
  ctx.shadowColor = 'rgba(90, 70, 50, 0.16)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 10
  roundRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = '#fffdf9'
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundRect(ctx, x, y, width, height, radius)
  ctx.clip()
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, width, height)

  if (mode === 'contain') drawImageContain(ctx, image, x, y, width, height, 14)
  else drawImageCover(ctx, image, x, y, width, height)
  ctx.restore()

  ctx.save()
  roundRect(ctx, x, y, width, height, radius)
  ctx.strokeStyle = 'rgba(120, 100, 80, 0.18)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
}

function drawPaperTexture(ctx: CanvasRenderingContext2D) {
  // 不用随机数：同样的画每次导出纹理一致，也避免大量 fill 拖慢导出。
  ctx.save()
  ctx.globalAlpha = 0.028
  ctx.strokeStyle = '#8d765c'
  ctx.lineWidth = 1

  for (let i = 0; i < 22; i++) {
    const y = 18 + i * 31
    ctx.beginPath()
    ctx.moveTo(30, y)
    ctx.bezierCurveTo(280, y - 4, 620, y + 5, 970, y - 1)
    ctx.stroke()
  }

  for (let i = 0; i < 16; i++) {
    const x = 40 + i * 58
    ctx.beginPath()
    ctx.moveTo(x, 16)
    ctx.lineTo(x + 2, 684)
    ctx.stroke()
  }

  ctx.restore()
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  const gradient = ctx.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT)
  gradient.addColorStop(0, '#FBF8F2')
  gradient.addColorStop(0.52, '#F7F2E8')
  gradient.addColorStop(1, '#F3EDE2')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  // 右上角一层很淡的暖光，让纸面不显得死板
  const glow = ctx.createRadialGradient(840, 80, 20, 840, 80, 360)
  glow.addColorStop(0, 'rgba(255, 236, 198, 0.46)')
  glow.addColorStop(1, 'rgba(255, 236, 198, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)

  drawPaperTexture(ctx)
}

function drawHeader(ctx: CanvasRenderingContext2D, styleTitle: string, createdAt: Date) {
  ctx.fillStyle = '#3F3A34'
  ctx.font = `700 30px ${FONT_FAMILY}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('指尖绘迹 · 专属艺术档案', 50, 64)

  const date = createdAt.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const style = styleTitle.trim().slice(0, 22) || '自由创作'

  ctx.fillStyle = '#90877C'
  ctx.font = `15px ${FONT_FAMILY}`
  ctx.fillText(`创作时间：${date}    ·    风格：${style}`, 52, 94)

  ctx.strokeStyle = 'rgba(150, 132, 110, 0.26)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(50, 112)
  ctx.lineTo(950, 112)
  ctx.stroke()
}

function drawFooter(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#8C8378'
  ctx.font = `14px ${FONT_FAMILY}`
  ctx.textAlign = 'left'
  ctx.fillText('AI 艺术演绎', 420, 682)

  ctx.fillStyle = '#D96C5F'
  ctx.font = `700 23px ${FONT_FAMILY}`
  ctx.textAlign = 'right'
  ctx.fillText('✦ 指尖绘迹', 950, 684)
  ctx.textAlign = 'left'
}

/**
 * 生成并下载故事卡。
 *
 * @param sketchBase64   孩子原图（PNG dataURL；可以是透明底，画进相框时会铺白）
 * @param generatedBase64 AI 生成图（dataURL 或同源/允许 CORS 的 URL）
 * @param aiText         AI 共情解读正文
 * @param styleTitle     风格名，如“水墨国风”
 */
export async function generateStoryCard(
  sketchBase64: string,
  generatedBase64: string,
  aiText: string,
  styleTitle: string,
): Promise<void> {
  if (!sketchBase64) throw new Error('缺少草图')
  if (!generatedBase64) throw new Error('缺少生成图')

  const [sketch, generated] = await Promise.all([
    loadImage(sketchBase64),
    loadImage(generatedBase64),
  ])

  const canvas = document.createElement('canvas')
  canvas.width = CARD_WIDTH
  canvas.height = CARD_HEIGHT

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  drawBackground(ctx)
  drawHeader(ctx, styleTitle, new Date())

  // 左侧：孩子原图，完整放进相框，不裁切
  drawFrame(ctx, 50, 130, 300, 300, 16, sketch, 'contain')
  ctx.fillStyle = '#6F675D'
  ctx.font = `600 15px ${FONT_FAMILY}`
  ctx.fillText('原始涂鸦', 52, 462)

  // 右侧：AI 生成图，作为视觉主体
  drawFrame(ctx, 420, 130, 530, 530, 20, generated, 'cover')
  drawFooter(ctx)

  // 左下：AI 的共情解读；最多 6 行，超出省略，避免压到卡片底部。
  // 330px 而不是 300px：默认那句中文加上引号刚好会被挤成“正文一行 + 右引号单独一行”。
  const text = (aiText.trim() || '这幅画里，藏着你此刻的小小心情。')
    .replace(/^[“”"]+|[“”"]+$/g, '')
  ctx.fillStyle = '#4A443D'
  ctx.font = `17px ${FONT_FAMILY}`
  wrapText(ctx, `“${text}”`, 50, 504, 330, 27, 6)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value)
      else reject(new Error('故事卡编码失败'))
    }, 'image/png')
  })

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = `指尖绘迹-故事卡-${Date.now()}.png`
  link.href = url
  document.body.appendChild(link)
  link.click()
  link.remove()

  // 给浏览器留出开始下载的时间，再释放 blob URL
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}
