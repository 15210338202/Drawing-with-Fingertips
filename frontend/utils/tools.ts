import { z } from 'zod'

/**
 * 给模型用的工具表。
 * `signature` 必须和 docs/api.md 第 2 节的表格一致 —— 它是唯一给 LLM 看的参数说明，
 * 改契约时 doc、signature、parameters 三处一起改。
 *
 * P2-11 之后 **没有 search_style** 了：风格清单直接写进 system prompt，
 * 由模型在下 generate_image 时直接选 id（清单只有二十来条，比任何检索都准）。
 * /api/search-style 路由保留，只服务「手动浏览画廊」这个场景。
 */
export const TOOL_NAMES = [
  'set_color',
  'set_brush_size',
  'erase',
  'clear',
  'undo',
  'export',
  'analyze_sketch',
  'generate_image',
] as const

export type AgentToolName = (typeof TOOL_NAMES)[number]

interface AgentToolMeta {
  /** 给模型看的函数签名，字段名必须和 parameters 里的完全一致 */
  signature: string
  /** 什么时候该用这个工具 */
  description: string
  /** 参数校验用（明天真正执行动作时拿它校验 args） */
  parameters: z.ZodType
}

/** Record<AgentToolName, …> 保证工具表一个都不能少 */
export const AGENT_TOOLS: Record<AgentToolName, AgentToolMeta> = {
  set_color: {
    signature: 'set_color(color: string)',
    description: '换画笔颜色，color 用十六进制，例如 #E03131。用户说“用红色画”“换个颜色”时用。',
    parameters: z.object({
      color: z.string().describe('十六进制颜色，例如 #E03131'),
    }),
  },
  set_brush_size: {
    signature: 'set_brush_size(size: number 1–50)',
    description: '调笔触粗细。用户说“粗一点”“细一点”时用。',
    parameters: z.object({
      size: z.number().min(1).max(50).describe('1–50，数字越大越粗'),
    }),
  },
  erase: {
    signature: "erase(mode: 'stroke' | 'all')",
    description: '橡皮擦。擦掉某一笔用 stroke，擦掉全部笔迹用 all。要清空整块画布请用 clear。',
    parameters: z.object({
      mode: z.enum(['stroke', 'all']).describe('stroke=擦一笔，all=擦掉所有笔迹'),
    }),
  },
  clear: {
    signature: 'clear()',
    description: '清空画布。用户说“重来”“清空”“都删掉”时用。',
    parameters: z.object({}),
  },
  undo: {
    signature: 'undo()',
    description: '撤销上一步绘画。用户说“撤销”“退回去”“刚才那笔删掉”时用。不能重做。',
    parameters: z.object({}),
  },
  export: {
    signature: "export(format: 'png' | 'jpg')",
    description: '把作品导出成图片文件。',
    parameters: z.object({
      format: z.enum(['png', 'jpg']).describe('png 保真，jpg 体积小'),
    }),
  },
  analyze_sketch: {
    signature: 'analyze_sketch(imageBase64?: string)',
    description: '看当前草图，分析它像什么并给 3 个风格建议。用户问“我画的像什么”时用。',
    parameters: z.object({
      imageBase64: z.string().optional().describe('不传就用画布当前内容'),
    }),
  },
  generate_image: {
    signature: 'generate_image(styleKey: string, strength: number 0–1, refImage?: string)',
    description: '把草图风格化生成图片。styleKey 必须从 system prompt 里给的画风清单中选一个 id，不要编造。',
    parameters: z.object({
      styleKey: z.string().describe('画风 id（形如 gf-01），必须来自清单'),
      strength: z.number().min(0).max(1).describe('风格化强度 0–1，越大越不像原图'),
      refImage: z.string().optional().describe('参考图 base64，不传就用当前画布'),
    }),
  },
}

/** 拼成 system prompt 里的工具清单，模型靠这段决定调哪个工具 */
export const AGENT_TOOLS_PROMPT = TOOL_NAMES
  .map((name) => {
    const tool = AGENT_TOOLS[name]
    return `- ${tool.signature} — ${tool.description}`
  })
  .join('\n')
