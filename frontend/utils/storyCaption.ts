/**
 * 故事卡底部的“作品解读”文案。
 *
 * 目标不是识别“这是房子/这是手”，而是从画面里能稳定拿到的视觉特征
 * （留白、颜色冷暖、线条密度）和所选风格，拼出一句贴合但不武断的话。
 * 这样任何题材都能用，不会因为画的是猫、房子还是一团线就失效。
 *
 * 真正有语义的解读仍然优先用 /api/analyze-sketch 的结果；
 * 这里只负责“没有 AI 解读时，也不要每次都写同一句”。
 */

import type { Insight } from '~/utils/insight'

type Tone = 'ink' | 'soft' | 'paint' | 'future' | 'pixel' | 'collage' | 'dream' | 'minimal' | 'folk' | 'warm'
type Density = 'sparse' | 'medium' | 'rich' | 'full'
type ColorMood = 'mono' | 'warm' | 'cool' | 'vivid' | 'quiet'

interface VisualStats {
  density: Density
  color: ColorMood
}

const DEFAULT_CAPTION = '这幅画里，藏着你此刻的小小心情。'

const STYLE_TONE_RULES: Array<[RegExp, Tone]> = [
  [/像素|复古|pixel|8-?bit|16-?bit/i, 'pixel'],
  [/拼贴|剪纸|波普|立体|collage|pop/i, 'collage'],
  [/梦幻|梦核|星空|dream/i, 'dream'],
  [/极简|线稿|minimal|line art/i, 'minimal'],
  [/水墨|国风|工笔|青绿|山水|书法|ink|sumi/i, 'ink'],
  [/日系|动画|绘本|治愈|水彩|清新|温柔|儿童|蜡笔|anime|illustration/i, 'soft'],
  [/油画|印象|厚涂|古典|点彩|抽象|流体|oil|impression/i, 'paint'],
  [/赛博|未来|科幻|霓虹|机械|cyber|future|neon/i, 'future'],
  [/脸谱|年画|民俗|烟火|folk|opera/i, 'folk'],
]


const OPENINGS: Record<Tone, string[]> = {
  ink: [
    '落笔很轻，像怕惊动纸上的风。',
    '墨色没有急着说话，先留了一点白。',
    '这一笔不急，慢慢走到了该停的地方。',
    '画面里有一种安静的力量。',
  ],
  soft: [
    '线条软软的，像刚睡醒的云。',
    '看着看着，心里也跟着软了下来。',
    '线条有自己的节奏，慢慢铺开。',
    '像把一个小小的午后，折进了画里。',
  ],
  paint: [
    '颜色在纸上碰了碰，慢慢晕开。',
    '这一笔很亮，像光刚好落在窗边。',
    '画面带着一点手作的温度。',
    '颜色没有排好队，却意外地好看。',
  ],
  future: [
    '线条带着一点速度，像刚从未来折返。',
    '颜色在暗处发着光，却不刺眼。',
    '画面像一扇刚打开的门。',
    '这里的时间，好像走得比别处快一点。',
  ],
  pixel: [
    '像从旧游戏里截下的一帧。',
    '颜色被压成小小的方块，反而有了秩序。',
    '画面带着一点旧屏幕的温度。',
  ],
  collage: [
    '纸片没有排好队，反而有了自己的节奏。',
    '剪过的边缘，让画面多了一点手作的声音。',
    '颜色块面挨在一起，像在说悄悄话。',
  ],
  dream: [
    '像从一个还没醒的梦里，轻轻借来一点光。',
    '画面有点失焦，却刚好让人想走进去。',
    '颜色在边缘化开，像梦到一半的地方。',
  ],
  minimal: [
    '线条很少，每一笔都很确定。',
    '画面没有多余的话，反而更安静。',
    '一笔停下来，空白就开始说话。',
  ],
  folk: [
    '颜色有戏，像台上有锣鼓刚刚敲过。',
    '脸谱和色块都带着一点舞台的光。',
    '画面热热闹闹，却不吵。',
  ],
  warm: [
    '画里有一种不慌不忙的温柔。',
    '线条走到这里，刚好停在一个舒服的地方。',
    '看着这幅画，像听见一句轻轻的呼吸。',
    '画面不大，却装下了一个小世界。',
  ],
}

/**
 * 每种风格专属的视觉落点。
 *
 * 它不替代留白/颜色统计，而是把“风格”放在句子最靠前的位置：
 * 先让人听见这个风格该有的语气，再用画面统计补细节。
 */
const STYLE_DESCRIPTORS: Record<Tone, string[]> = {
  ink: [
    '宣纸上的墨色有浓有淡，',
    '笔锋走过的地方，还留着一点呼吸，',
  ],
  soft: [
    '线条像被奶油和阳光轻轻包住，',
    '颜色软软地挨在一起，',
  ],
  paint: [
    '颜料堆出一点厚度，',
    '笔触没有急着抹平，',
  ],
  future: [
    '光从暗处慢慢透出来，',
    '颜色带着一点金属的凉意，',
  ],
  pixel: [
    '色块边缘利落，像一格一格拼起来的，',
    '颜色被收进有限的几档里，',
  ],
  collage: [
    '纸片边缘留着剪过的痕迹，',
    '不同的材质碰在一起，',
  ],
  dream: [
    '光晕软软地散开，',
    '边界不太清楚，像隔着一层雾，',
  ],
  minimal: [
    '没有多余的装饰，',
    '每一根线都落在该在的位置，',
  ],
  folk: [
    '颜色浓淡分明，像一笔一笔画上去的，',
    '色块有板有眼，带着一点舞台的腔调，',
  ],
  warm: [
    '纸面上的颜色不争不抢，',
    '线条和色块慢慢靠在一起，',
  ],
}

const STYLE_DESCRIPTOR_OVERRIDES: Array<[RegExp, string[]]> = [
  [/青绿|山水/, ['青绿在山脊上慢慢铺开，']],
  [/水彩|治愈/, ['水色在纸边慢慢化开，']],
  [/绘本|蜡笔/, ['蜡笔的颗粒留在纸面上，']],
  [/儿童|涂鸦/, ['线条歪歪扭扭，却很有自己的主意，']],
  [/古典|肖像/, ['暗部的光一点点浮出来，']],
  [/星空|梦幻/, ['星屑一样的光点散在边上，']],
  [/赛博|霓虹/, ['霓虹把边缘照得有点发亮，']],
  [/年画|剪纸|波普/, ['剪刀和色块都留下了手作的边，']],
  [/像素/, ['像素块边缘像旧屏幕的扫描线，']],
]

function pickStyleDescriptor(styleTitle: string, tone: Tone, random: () => number): string {
  for (const [pattern, descriptors] of STYLE_DESCRIPTOR_OVERRIDES) {
    if (pattern.test(styleTitle)) return pick(descriptors, random)
  }
  return pick(STYLE_DESCRIPTORS[tone], random)
}

const DENSITY_PHRASES: Record<Density, string[]> = {
  sparse: [
    '留白很多，',
    '线条不多，',
    '画面空得很舒服，',
    '大片的空白没有被填满，',
  ],
  medium: [
    '线条疏疏密密，',
    '画面不空也不挤，',
    '几笔之间留着呼吸，',
    '该有的地方有，该空的地方也空着，',
  ],
  rich: [
    '线条一层一层地长出来，',
    '画面慢慢被填满，',
    '越看越有细节，',
    '每一笔都在往画面里走，',
  ],
  full: [
    '每一处都很热闹，',
    '线条和色块挤在一起，',
    '画面被填得满满的，',
    '几乎没有留白，',
  ],
}

const COLOR_PHRASES: Record<ColorMood, string[]> = {
  mono: [
    '颜色很安静。',
    '几乎只有线条在说话。',
    '颜色被收了起来，只剩形状。',
  ],
  warm: [
    '颜色暖暖的。',
    '颜色像被夕阳照过。',
    '暖色慢慢铺开。',
  ],
  cool: [
    '颜色凉凉的。',
    '颜色像下过雨的空气。',
    '冷色安安静静地待着。',
  ],
  vivid: [
    '颜色亮亮的。',
    '颜色很活泼，像在纸上跳。',
    '颜色一点都不客气。',
  ],
  quiet: [
    '颜色淡淡的。',
    '颜色像被水洗过。',
    '颜色不争不抢。',
  ],
}

const CLOSINGS: Record<Tone, string[]> = {
  ink: [
    '剩下的故事，就交给看画的人慢慢想。',
    '余下的意思，留给看画的人慢慢体会。',
    '像一封没写完的信，停在最有余味的地方。',
  ],
  soft: [
    '好像有一个温柔的小世界，正在里面发生。',
    '看着看着，心里也跟着亮了一点。',
    '像把一段轻轻的心情，留在了纸上。',
  ],
  paint: [
    '颜色停在这里，光却好像还在走。',
    '像某一刻的风景，被轻轻按住了。',
    '再多看一会儿，还能看见新的颜色。',
  ],
  future: [
    '像某个还没发生的明天，先漏进来一点光。',
    '故事也许才刚开始。',
    '画面之外，还有更大的世界。',
  ],
  pixel: [
    '像素的边缘，替画面留住了时间。',
    '像一条还没通关的路，停在最想继续的地方。',
  ],
  collage: [
    '拼贴的缝隙里，也藏着一点小心思。',
    '像把几段不同的心情，贴成了同一个下午。',
  ],
  dream: [
    '梦没有说完，画面先替它留住了颜色。',
    '再往里走一点，也许还能遇见别的什么。',
  ],
  minimal: [
    '画面把该说的，都留在了空白里。',
    '简单不是少，是刚刚好。',
  ],
  folk: [
    '像一场还没谢幕的戏，余音还在。',
    '热闹过后，颜色还留在台中央。',
  ],
  warm: [
    '它不需要解释，已经很像你了。',
    '愿看画的人，也能接住这一点温柔。',
    '这份心情，已经留在纸上了。',
  ],
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 小型确定性随机数；同一次保存用同一个种子，避免一句话里前后风格打架 */
function createRandom(seed: number) {
  let state = seed >>> 0

  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!
}

function resolveTone(styleTitle: string): Tone {
  for (const [pattern, tone] of STYLE_TONE_RULES) {
    if (pattern.test(styleTitle)) return tone
  }
  return 'warm'
}

/**
 * 从画布里取低分辨率统计。
 *
 * 只看“画面有多满、颜色偏冷还是偏暖、颜色鲜不鲜”这种粗特征：
 * 它们不依赖具体物体，所以对房子、动物、抽象线团都同样成立。
 */
function readVisualStats(canvas: HTMLCanvasElement): VisualStats {
  const fallback: VisualStats = { density: 'medium', color: 'quiet' }

  try {
    const maxSide = 160
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height))
    const width = Math.max(1, Math.round(canvas.width * scale))
    const height = Math.max(1, Math.round(canvas.height * scale))

    const sample = document.createElement('canvas')
    sample.width = width
    sample.height = height
    const ctx = sample.getContext('2d', { willReadFrequently: true })
    if (!ctx) return fallback

    ctx.drawImage(canvas, 0, 0, width, height)
    const pixels = ctx.getImageData(0, 0, width, height).data

    let ink = 0
    let weightedWarmth = 0
    let saturation = 0

    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] ?? 0
      if (alpha < 24) continue

      const r = pixels[i] ?? 0
      const g = pixels[i + 1] ?? 0
      const b = pixels[i + 2] ?? 0
      // 画布本身是透明的；如果以后有人铺了白底，白色也应该算“留白”而不是“画满”。
      if (r > 244 && g > 244 && b > 244) continue

      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)

      ink++
      weightedWarmth += (r - b) / 255
      saturation += max === min ? 0 : (max - min) / max
    }

    if (ink === 0) return { density: 'sparse', color: 'mono' }

    const coverage = ink / (width * height)
    const averageWarmth = weightedWarmth / ink
    const averageSaturation = saturation / ink

    const density: Density
      = coverage < 0.04 ? 'sparse'
        : coverage < 0.14 ? 'medium'
          : coverage < 0.34 ? 'rich'
            : 'full'

    const color: ColorMood
      = averageSaturation < 0.09 ? 'mono'
        : averageWarmth > 0.04 ? 'warm'
          : averageWarmth < -0.04 ? 'cool'
            : averageSaturation > 0.32 ? 'vivid'
              : 'quiet'

    return { density, color }
  }
  catch {
    // 画布被跨域图污染时 getImageData 会抛 SecurityError，退回中性描述。
    return fallback
  }
}

export interface StoryCaptionOptions {
  /** 固定种子时方便测试；不传则每次保存都换一种说法 */
  seed?: number
}

let captionSequence = 0

const MAX_AI_CAPTION_CHARS = 80

function cleanCaptionPart(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
}

function splitSentences(text: string): string[] {
  return text.match(/[^。！？!?]+[。！？!?]?/g)?.map(part => part.trim()).filter(Boolean) ?? []
}

/** 在逗号/分号处收口，尽量不把半句话硬切给用户 */
function shortenCaption(text: string, max: number): string {
  if (text.length <= max) return text

  const head = text.slice(0, max)
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('、'))
  if (cut >= Math.floor(max * 0.55)) return head.slice(0, cut)

  return head.replace(/[，,；;、\s]+$/g, '').trim()
}

function ensureEnd(text: string): string {
  const trimmed = text.replace(/[，,；;、\s]+$/g, '').trim()
  if (!trimmed) return ''
  return /[。！？!?]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

/**
 * 取一个字段的第一句，再在逗号处收口。
 * observation / feeling 的第一句通常已经包含“看到了什么 + 为什么这样感觉”，
 * 只取第一小句会丢掉“带着一点兴奋”这类关键情绪，所以这里保留整句、只限长度。
 */
function pickFirstPhrase(value: string | undefined, max: number): string {
  const text = cleanCaptionPart(value)
  if (!text) return ''

  const sentence = splitSentences(text)[0]?.replace(/[。！？!?]+$/g, '').trim() ?? text
  return shortenCaption(sentence, max)
}

/**
 * 把 AI 的三段解读压成 1–2 句，专门给故事卡底部用。
 *
 * 优先“看到了什么 + 感觉到什么”：这两段最像一句完整的陪伴；
 * invitation 是一个问题，只有在前面不够两句时才补进来。
 * 所有字段都为空时返回空串，让调用方回退到 buildStoryCaption。
 */
export function condenseInsight(
  insight: Pick<Insight, 'observation' | 'feeling' | 'invitation'> | null | undefined,
  styleTitle = '',
): string {
  if (!insight) return ''

  // AI 解读负责“看到了什么”，风格词负责“用什么语气看”。
  // 把风格前缀并进第一句，而不是再加一句，避免卡片变长。
  const styleLead = styleTitle
    ? pickStyleDescriptor(styleTitle, resolveTone(styleTitle), createRandom(hashString(styleTitle)))
    : ''

  const observation = pickFirstPhrase(insight.observation, styleLead ? 30 : 40)
  const feeling = pickFirstPhrase(insight.feeling, styleLead ? 26 : 34)
  const invitation = pickFirstPhrase(insight.invitation, 30)

  const parts: string[] = []
  const firstBody = observation || feeling

  if (firstBody) {
    parts.push(styleLead ? `${styleLead}${firstBody}` : firstBody)
    if (observation && feeling) {
      const normalizedObservation = observation.replace(/[。！？!?，,；;\s]/g, '')
      const normalizedFeeling = feeling.replace(/[。！？!?，,；;\s]/g, '')
      if (normalizedFeeling !== normalizedObservation) parts.push(feeling)
    }
  }
  else if (styleLead) {
    parts.push(styleLead.replace(/[，,]\s*$/, ''))
  }

  if (parts.length < 2 && invitation) {
    const normalizedInvitation = invitation.replace(/[。！？!?，,；;\s]/g, '')
    const duplicate = parts.some(part => part.replace(/[。！？!?，,；;\s]/g, '') === normalizedInvitation)
    if (!duplicate) parts.push(invitation)
  }

  if (parts.length === 0) return ''

  const first = ensureEnd(parts[0]!)
  const room = Math.max(12, MAX_AI_CAPTION_CHARS - first.length)
  const second = parts[1] ? ensureEnd(shortenCaption(parts[1], room)) : ''
  const text = `${first}${second}`

  return text.length > MAX_AI_CAPTION_CHARS
    ? ensureEnd(shortenCaption(text, MAX_AI_CAPTION_CHARS))
    : text
}

/**
 * 根据画布视觉特征 + 风格名生成一句故事卡文案。
 * 没有 canvas 时返回固定兜底，保证导出流程不因文案失败。
 */
export function buildStoryCaption(
  canvas: HTMLCanvasElement | null | undefined,
  styleTitle: string,
  options: StoryCaptionOptions = {},
): string {
  if (!canvas) return DEFAULT_CAPTION

  const stats = readVisualStats(canvas)
  const tone = resolveTone(styleTitle)
  const seed = options.seed
    ?? ((Date.now() ^ hashString(`${styleTitle}:${stats.density}:${stats.color}`) ^ captionSequence++) >>> 0)
  const random = createRandom(seed)

  const opening = pick(OPENINGS[tone], random)
  const descriptor = pickStyleDescriptor(styleTitle, tone, random)
  const visual = `${descriptor}${pick(DENSITY_PHRASES[stats.density], random)}${pick(COLOR_PHRASES[stats.color], random)}`
  const closing = pick(CLOSINGS[tone], random)

  return `${opening}${visual}${closing}`
}
