/**
 * R6：手部几何合理性检查（主线程侧的第二道过滤）。
 *
 * MediaPipe 在背景里有肉色物体、后脑勺、被子褶皱时，偶尔会硬凑出一只“手”。
 * Worker 只保证关键点数量够 21 个，管不了这些点的几何关系；所以在把结果交给
 * 手势状态机之前，再用 2D 坐标做一次很便宜的“安检”。
 *
 * 只做形状检查，不判断左右手、不依赖 worldLandmarks：
 * - 侧手、俯仰时 2D 比例会变，但阈值给得宽，正常手不会误杀；
 * - 假手通常掌长/掌宽比例离谱，或者四根手指的骨长关系不像人手。
 *
 * 为什么不能只看“中指 9→12 够不够长”：
 * 脑袋/被子被误检时，模型会把五官边缘拉成很长的“手指”，单看某一段反而更长。
 * 所以这里改看四根手指的**骨段总长**（MCP→PIP→DIP→TIP 三段相加）：
 * 蜷指时骨段长度不变，仍然能通过；而五官拼出来的假手指，四根的长度关系通常很乱。
 */

type Point2D = { x: number, y: number }

/**
 * 判断一组 21 点关键点是否像一只真实的手。
 *
 * @param landmarks MediaPipe 的 2D 归一化关键点
 * @returns true 表示几何关系合理，可以进入主手选择/手势状态机
 */
export function isGeometricallyValid(
  landmarks: readonly Point2D[] | null | undefined,
): boolean {
  if (!landmarks || landmarks.length < 21) return false

  const wrist = landmarks[0]
  const indexMcp = landmarks[5]
  const middleMcp = landmarks[9]
  const middlePip = landmarks[10]
  const middleTip = landmarks[12]
  if (!wrist || !indexMcp || !middleMcp || !middlePip || !middleTip) return false

  const dist = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y)

  // 1. 手掌比例：手腕→食指根 当“宽”，手腕→中指根 当“长”
  const palmWidth = dist(wrist, indexMcp)
  const palmLength = dist(wrist, middleMcp)
  if (!(palmWidth > 1e-5) || !(palmLength > 1e-5)) return false

  const ratio = palmLength / palmWidth
  if (!Number.isFinite(ratio) || ratio < 0.8 || ratio > 2.2) return false

  // 2. 中指骨性长度：这里不能只看 9→12（指尖）。
  // 握拳、👍 时中指是蜷起来的，指尖会贴回掌心，9→12 会短到看起来像“假手”；
  // 9→10 是中指第一节，蜷指时长度基本不变，所以取两者最大值当兜底。
  // 阈值放到掌长的 30%：正常手轻松通过，缩成一团的假手仍然会被拦下。
  const middleFingerLength = Math.max(dist(middleMcp, middlePip), dist(middleMcp, middleTip))
  if (!Number.isFinite(middleFingerLength)) return false
  if (middleFingerLength < palmLength * 0.3) return false

  // 3. 四指骨段总长：MCP→PIP→DIP→TIP，蜷指时长度不缩，比单看指尖稳。
  //    正常人：中指最长、小指最短，四根比值大约 0.8–1.15；
  //    脑袋误检：五官边缘拼出的“手指”经常出现小指比中指长、或某根短得离谱。
  const chain = (indices: number[]) => {
    let total = 0
    for (let i = 1; i < indices.length; i++) {
      total += dist(landmarks[indices[i - 1]], landmarks[indices[i]])
    }
    return total
  }

  const fingerChains = [
    chain([5, 6, 7, 8]),
    chain([9, 10, 11, 12]),
    chain([13, 14, 15, 16]),
    chain([17, 18, 19, 20]),
  ]
  if (fingerChains.some(length => !Number.isFinite(length))) return false

  // 正常手指骨段总长约为掌长的 0.6–1.2；下限放低，避免握拳/遮挡时误杀
  if (fingerChains.some(length => length < palmLength * 0.22)) return false
  if (fingerChains.some(length => length > palmLength * 1.8)) return false

  const [indexChain, middleChain, ringChain, pinkyChain] = fingerChains
  // 中指应该最长；允许食指/无名指略长，但不允许明显反过来
  if (middleChain < Math.max(indexChain, ringChain) * 0.9) return false
  // 食指和无名指长度通常很接近；脑袋误检时经常一根特别长、一根特别短
  if (Math.max(indexChain, ringChain) > Math.min(indexChain, ringChain) * 1.8) return false
  // 小指应该最短；既不能比中指长，也不能比食指/无名指中较短的那根长太多。
  // 原阈值 1.25 太紧：真实 OK/捏合手型里，食指弯曲后 2D 骨段被压缩，
  // 实测小指/较短指 = 1.32，正常手会被误杀。放宽到 1.5，仍能挡住“小指比中指长”的假手。
  if (pinkyChain > middleChain * 1.1) return false
  if (pinkyChain > Math.min(indexChain, ringChain) * 1.5) return false
  // 四根手指长度不能差得太夸张
  if (Math.max(...fingerChains) > Math.min(...fingerChains) * 2.2) return false

  // 4. 拇指骨段总长：1→2→3→4。假手经常把拇指压成一两个点
  const thumbChain = chain([1, 2, 3, 4])
  if (!Number.isFinite(thumbChain)) return false
  if (thumbChain < palmLength * 0.24) return false
  if (thumbChain > palmLength * 1.6) return false

  return true
}
