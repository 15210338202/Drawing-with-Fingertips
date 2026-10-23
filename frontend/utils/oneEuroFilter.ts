/**
 * R5：One Euro Filter。
 *
 * 相比固定窗口的滑动平均，它根据“当前速度”自适应调整截止频率：
 * - 手慢/静止 → 截止频率低，强力压掉 MediaPipe 的逐帧抖动；
 * - 手快速挥笔 → 截止频率抬高，减少滞后，不会把笔迹拖成一条软线。
 *
 * 参考：Casiez, Roussel, Vogel. "1€ Filter: A Simple Speed-based Low-pass
 * Filter for Noisy Input in Interactive Systems" (CHI 2012)。
 */
export class OneEuroFilter {
  private minCutoff: number
  private beta: number
  private dCutoff: number

  /** 上一帧滤波后的值 */
  private xPrev: number | null = null
  /** 上一帧的原始值；求导必须用原始值，用滤波值会把速度算小、反应变慢 */
  private rawPrev: number | null = null
  /** 上一帧滤波后的导数（速度） */
  private dxPrev = 0
  /** 上一帧的时间戳（毫秒） */
  private tPrev: number | null = null

  constructor(minCutoff = 0.5, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  /** 低通系数：dt 秒内走过时间常数 tau 的比例 */
  private alpha(cutoff: number, dt: number) {
    if (!(cutoff > 0) || !(dt > 0)) return 1
    const tau = 1.0 / (2 * Math.PI * cutoff)
    return 1.0 / (1.0 + tau / dt)
  }

  /**
   * 输入一个采样点，返回滤波后的值。
   * @param x 原始值
   * @param t 时间戳，单位毫秒（performance.now() 即可）
   */
  filter(x: number, t: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(t)) {
      return this.xPrev ?? x
    }

    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t
      this.xPrev = x
      this.rawPrev = x
      this.dxPrev = 0
      return x
    }

    const dt = (t - this.tPrev) / 1000.0
    // 同一时间戳或时间倒流：不更新状态，沿用上一次结果
    if (dt <= 0) return this.xPrev

    // 隔了太久（切后台、手丢了很久）不拿旧状态硬接，直接以当前点重新起步
    if (dt > 0.25) {
      this.tPrev = t
      this.xPrev = x
      this.rawPrev = x
      this.dxPrev = 0
      return x
    }

    // 1. 过滤导数（速度）
    const dx = (x - (this.rawPrev ?? x)) / dt
    const alphaD = this.alpha(this.dCutoff, dt)
    const edx = alphaD * dx + (1 - alphaD) * this.dxPrev

    // 2. 速度越大，截止频率越高（越跟手）
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)

    // 3. 过滤信号
    const alphaX = this.alpha(cutoff, dt)
    const filteredX = alphaX * x + (1 - alphaX) * this.xPrev

    this.xPrev = filteredX
    this.rawPrev = x
    this.dxPrev = edx
    this.tPrev = t

    return filteredX
  }

  /**
   * 清空历史。抬笔、丢手、换主手、关摄像头时必须调：
   * 否则下一笔的起点会被上一笔末尾的速度状态“粘”住。
   */
  reset() {
    this.xPrev = null
    this.rawPrev = null
    this.dxPrev = 0
    this.tPrev = null
  }
}
