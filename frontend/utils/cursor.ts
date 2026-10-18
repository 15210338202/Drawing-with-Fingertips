/**
 * 悬停准星用的小工具。
 *
 * 单独放 utils 里是为了能脱离 Vue/DOM 直接测：坐标映射和插值是最容易写错的地方
 * （归一化坐标 → 百分比、镜像方向、越界夹取），而它们又没法靠肉眼看代码保证。
 */

/** 归一化坐标夹到 0–1；非数字（NaN/Infinity）当 0，避免 style 里出现 "NaN%" */
export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 线性插值（视觉平滑）。
 * factor 越接近 1 越跟手、但越抖；越小越平滑、但越拖。
 * 0.35 在 60FPS 下：3 帧到目标距离的 72%，6 帧到 92%，肉眼看就是「跟手但不抖」。
 */
export function lerp(current: number, target: number, factor: number) {
  return current + (target - current) * factor
}

/**
 * 0–1 归一化坐标 → CSS 百分比字符串。
 * 用百分比而不是像素：画布是等比缩放到容器宽度的，百分比天然跟得上缩放，
 * 不需要量容器尺寸，也就不需要监听 resize。
 */
export function toPercent(value: number) {
  return `${(clamp01(value) * 100).toFixed(3)}%`
}
