/**
 * 4 点透视校正（单应矩阵 / Homography）。
 *
 * 为什么需要它：手在画面前后左右移动时，透视会让「物理上的直线」在画面里变成斜线，
 * 边缘还会被拉长。用 4 个已知点求一个 3×3 单应矩阵，就能把画面里的四边形
 * 拉回成正矩形，边缘的漂移和歪斜一起解决。
 *
 * 这里不引第三方数学库：只要解一个 8 元一次方程组，高斯消元二十行就够，
 * 比装一个 general-matrix 之类的依赖划算得多。
 */

export interface Point {
  x: number
  y: number
}

/** 3×3 矩阵，按 [行][列] 存放，最后一行固定为 [h6, h7, 1] */
export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
]

/** 单位矩阵：没标定时用它，等价于「不校正」 */
export const IDENTITY: Matrix3x3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/**
 * 求把 src 四点映射到 dst 四点的单应矩阵。
 * 四个点必须按同一顺序给出（左上 → 右上 → 右下 → 左下），否则结果会自交/翻转。
 *
 * @returns 3×3 矩阵；四点退化（重合、共线、无法求解）时返回 null
 */
export function computeHomography(src: Point[], dst: Point[]): Matrix3x3 | null {
  if (src.length < 4 || dst.length < 4) return null

  // 每对点贡献两个方程，8 个未知量（h8 归一化为 1）
  const A: number[][] = []
  const B: number[] = []

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]

    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    B.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    B.push(v)
  }

  const h = gaussianElimination(A, B)
  if (!h) return null

  const H: Matrix3x3 = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ]

  // 解出来的数必须是有限值，否则后端一路 NaN
  return H.flat().every(Number.isFinite) ? H : null
}

/**
 * 高斯消元（带部分主元选择）。
 * 原地改写 A/B 的副本，避免调用方的数组被污染。
 *
 * @returns 解向量；主元接近 0（方程退化）时返回 null
 */
function gaussianElimination(matrixA: number[][], vectorB: number[]): number[] | null {
  const n = vectorB.length
  const A = matrixA.map(row => [...row])
  const B = [...vectorB]

  for (let i = 0; i < n; i++) {
    // 部分主元：选当前列绝对值最大的行交换上来，减少除法的数值误差
    let pivotRow = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[pivotRow][i])) pivotRow = k
    }

    if (Math.abs(A[pivotRow][i]) < 1e-12) return null

    if (pivotRow !== i) {
      const tmpRow = A[i]
      A[i] = A[pivotRow]
      A[pivotRow] = tmpRow

      const tmpVal = B[i]
      B[i] = B[pivotRow]
      B[pivotRow] = tmpVal
    }

    // 归一化主元行
    const pivot = A[i][i]
    for (let j = i; j < n; j++) A[i][j] /= pivot
    B[i] /= pivot

    // 消去其他行在当前列上的分量
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      const factor = A[k][i]
      if (factor === 0) continue
      for (let j = i; j < n; j++) A[k][j] -= factor * A[i][j]
      B[k] -= factor * B[i]
    }
  }

  return B
}

/**
 * 对一个点施加单应变换。
 * 齐次坐标下 (x, y, 1) 乘以矩阵后要除以 w 才是欧氏坐标。
 */
export function applyHomography(point: Point, matrix: Matrix3x3): Point {
  const w = matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2]

  // w 接近 0 表示这个点被映射到了无穷远，矩阵已失效；原样返回，交给上层判定
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return { x: point.x, y: point.y }

  return {
    x: (matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2]) / w,
    y: (matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2]) / w,
  }
}

/** 四边形的有向面积（鞋带公式）；符号说明点的绕向 */
export function signedArea(points: Point[]) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** 判断四边形是不是凸的（不自交）：相邻叉积同号 */
export function isConvex(points: Point[]) {
  if (points.length < 4) return false

  let sign = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const c = points[(i + 2) % points.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)

    if (Math.abs(cross) < 1e-9) continue // 共线，忽略
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }

  return sign !== 0
}

export interface ValidationResult {
  ok: boolean
  /** 不通过时给用户看的说明 */
  reason?: string
}

/**
 * 标定结果的合理性检查。
 *
 * 注意：四点确定一个单应矩阵，所以「反投影误差恒为 0」——拿重投影误差当校验是没有意义的，
 * 必须查几何本身的合理性：四边形是否凸、面积够不够、映射后会不会翻转或飞出画面。
 *
 * @param matrix 待校验的矩阵
 * @param src 用户标定采集到的 4 个摄像头坐标（顺序同上）
 * @param dst 期望映射到的 4 个点（画布四角）
 */
export function validateHomography(
  matrix: Matrix3x3,
  src: Point[],
  dst: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
): ValidationResult {
  if (src.length < 4) return { ok: false, reason: '标定点不足 4 个' }

  // 1. 点必须落在画面里
  for (const p of src) {
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      return { ok: false, reason: '标定点超出画面范围' }
    }
  }

  // 2. 四边形不能被捏成一条线或一个点
  if (Math.abs(signedArea(src)) < 0.02) {
    return { ok: false, reason: '四个标定点太近或共线，请重新标定' }
  }

  // 3. 不能自交（用户可能顺序点错）
  if (!isConvex(src)) {
    return { ok: false, reason: '四个点连起来自交了，请按左上→右上→右下→左下的顺序标定' }
  }

  // 4. 变换后不能翻转（镜像），否则手一动光标就往反方向跑
  const det = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]
  if (det <= 0) return { ok: false, reason: '矩阵发生了翻转/退化，请重新标定' }

  // 5. 四个角必须落在目标位置附近（数值检查，兼查错位）
  for (let i = 0; i < 4; i++) {
    const mapped = applyHomography(src[i], matrix)
    const err = Math.hypot(mapped.x - dst[i].x, mapped.y - dst[i].y)
    if (err > 0.02) return { ok: false, reason: '矩阵求解结果不稳定，请重新标定' }
  }

  // 6. 内部点不能被映射到画面外（透视拉太狠的典型症状）
  const probes: Point[] = [
    { x: 0.5, y: 0.5 },
    ...src.map((p, i) => ({ x: (p.x + src[(i + 1) % 4].x) / 2, y: (p.y + src[(i + 1) % 4].y) / 2 })),
  ]
  for (const probe of probes) {
    const mapped = applyHomography(probe, matrix)
    if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)
      || mapped.x < -0.5 || mapped.x > 1.5 || mapped.y < -0.5 || mapped.y > 1.5) {
      return { ok: false, reason: '透视参数过于极端，画面会被拉变形，请重新标定' }
    }
  }

  // 7. 中心点应落在画面中心附近：标定梯形正常时偏差很小，偏太多说明有点采错了
  const center = applyHomography({ x: 0.5, y: 0.5 }, matrix)
  if (Math.abs(center.x - 0.5) > 0.3 || Math.abs(center.y - 0.5) > 0.3) {
    return { ok: false, reason: '标定点偏差过大，请把手指对准红点后重试' }
  }

  return { ok: true }
}

/** 结构校验：从 localStorage 读回来的东西不可信，先过一遍形状 */
export function isMatrix3x3(value: unknown): value is Matrix3x3 {
  return Array.isArray(value)
    && value.length === 3
    && value.every(row => Array.isArray(row) && row.length === 3 && row.every(v => typeof v === 'number' && Number.isFinite(v)))
}
