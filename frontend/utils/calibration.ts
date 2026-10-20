/**
 * 标定流程的纯逻辑：4 个靶点 + 悬停停留判定。
 *
 * 抽成纯函数是为了能脱离浏览器测：停留计时、进入/离开半径、采样平均、顺序推进
 * 这些地方最容易出现「手指一抖就重置」或「跳过某一点」的 bug，靠肉眼看代码发现不了。
 */
import type { Point } from './homography'

/** 四个靶点：留出 20% 边距，避开摄像头边缘（那里的关键点最不稳） */
export const CALIBRATION_TARGETS: Point[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
]

/** 停留在靶点上的时长（毫秒） */
export const DWELL_MS = 500

/** 判定「停在靶点上」的半径（归一化） */
export const DWELL_RADIUS = 0.07

/** 停留期间最多留多少帧用于平均，防止内存一直涨 */
const MAX_SAMPLES = 60

export interface DwellState {
  /** 当前正在等第几个点 */
  index: number
  /** 开始停留的时刻；null 表示还没进入靶点 */
  since: number | null
  /** 停留期间采集到的样本，最后取平均作为标定点 */
  samples: Point[]
  /** 已经采到的点，按顺序 */
  captured: Point[]
}

export interface DwellOptions {
  targets?: Point[]
  dwellMs?: number
  radius?: number
  /** 画面宽高比：靶点半径在横竖方向的手感要一致，和 R2 的距离换算同一个道理 */
  aspect?: number
}

export interface DwellStep {
  state: DwellState
  /** 当前是否正停在靶点上（用于 UI 高亮） */
  active: boolean
  /** 这一帧刚刚采到一个点 */
  capturedNow: boolean
  /** 四个点都采完了 */
  done: boolean
}

export function createDwellState(): DwellState {
  return { index: 0, since: null, samples: [], captured: [] }
}

/** 两点距离，x 按宽高比换算到等比空间 */
function distance(a: Point, b: Point, aspect: number) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y)
}

/**
 * 推进一帧。
 *
 * @param state 上一帧的状态
 * @param point 食指尖的归一化坐标（未校正的原始值）；手丢了传 null
 * @param now performance.now()
 */
export function stepDwell(state: DwellState, point: Point | null, now: number, options: DwellOptions = {}): DwellStep {
  const targets = options.targets ?? CALIBRATION_TARGETS
  const dwellMs = options.dwellMs ?? DWELL_MS
  const radius = options.radius ?? DWELL_RADIUS
  const aspect = options.aspect && Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 4 / 3

  // 已经采满：保持终态，不再推进
  if (state.index >= targets.length) {
    return { state, active: false, capturedNow: false, done: true }
  }

  // 手丢了：计时和样本都清掉，但已采到的点保留
  if (!point) {
    return { state: { ...state, since: null, samples: [] }, active: false, capturedNow: false, done: false }
  }

  const target = targets[state.index]

  if (distance(point, target, aspect) > radius) {
    // 离开靶点：重新计时（这是「一抖就重置」的正解，抖动本身靠半径容忍）
    return { state: { ...state, since: null, samples: [] }, active: false, capturedNow: false, done: false }
  }

  const since = state.since ?? now
  const samples = [...state.samples, point].slice(-MAX_SAMPLES)

  if (now - since < dwellMs) {
    return { state: { ...state, since, samples }, active: true, capturedNow: false, done: false }
  }

  // 停留够久：用样本平均作为标定点，比取最后一帧稳得多
  const capturedPoint = average(samples)
  const captured = [...state.captured, capturedPoint]
  const nextIndex = state.index + 1

  return {
    state: { index: nextIndex, since: null, samples: [], captured },
    active: false,
    capturedNow: true,
    done: nextIndex >= targets.length,
  }
}

/** 停留进度 0–1，供 UI 画进度条（不依赖 CSS 动画时用） */
export function dwellProgress(state: DwellState, now: number, dwellMs: number = DWELL_MS) {
  if (state.since === null) return 0
  return Math.min(1, Math.max(0, (now - state.since) / dwellMs))
}

function average(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 }
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}
