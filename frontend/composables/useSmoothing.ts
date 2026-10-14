/** 滑动平均窗口长度：5 帧，640×480 下大约 0.15 秒，延迟感还能接受 */
const DEFAULT_WINDOW_SIZE = 5

/**
 * 关键点滑动平均。
 * 手抖主要来自 MediaPipe 逐帧的检测噪声，取最近几帧的平均值就能压掉大部分抖动。
 */
export function useSmoothing(windowSize: number = DEFAULT_WINDOW_SIZE) {
  // x 和 y 必须各自一个缓冲区：共用一个的话两个轴的坐标会被混在一起算平均
  const bufferX: number[] = []
  const bufferY: number[] = []

  /** 推入新值并返回当前窗口的平均值 */
  function push(buffer: number[], value: number) {
    buffer.push(value)

    // 超出窗口就把最老的挤出去，保证缓冲区定长
    if (buffer.length > windowSize) buffer.shift()

    return buffer.reduce((sum, item) => sum + item, 0) / buffer.length
  }

  /** x 轴平滑 */
  function smoothX(value: number) {
    return push(bufferX, value)
  }

  /** y 轴平滑 */
  function smoothY(value: number) {
    return push(bufferY, value)
  }

  /**
   * 清空缓冲区。
   * 抬笔（手离开画面）时必须调：不清的话下一笔的前几帧会把上一笔末尾的点也算进平均，
   * 起点就会“粘”在上一笔结尾。
   */
  function reset() {
    bufferX.length = 0
    bufferY.length = 0
  }

  return { smoothX, smoothY, reset }
}
