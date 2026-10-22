# 接口契约 v0.1

> **状态（2026-10-21 按仓库代码核对）**：LLM 为 DeepSeek V4.1-Flash（`deepseek-flash`，OpenAI 兼容）；图像生成为 Cloudflare Workers AI（`@cf/black-forest-labs/flux-2-klein-4b`，图生图）。
> 本版同步了 P2-10 / P2-11：
> 1. `analyze_sketch` 已实现（llava 看图 → DeepSeek 组织语言，见第 9 节）；
> 2. **`search_style` 已从 Agent 工具表移除**：画风清单直接写进 system prompt，由模型在 `generate_image` 里直选 id；`/api/search-style` 只保留给画廊浏览；
> 3. 服务端会对 `generate_image.styleKey` 做幻觉纠偏（详见 2.1）。


> 每周一更新。前端按此写 Mock，不必等后端实现。
> 负责人：华雪峰

---

## 1. POST /api/agent — 意图解析 + 工具调用

### 请求
```json
{
  "text": "把它变成国风",
  "context": {
    "hasSketch": true,
    "canvasSize": { "w": 1200, "h": 800 },
    "brushColor": "#1F4E79",
    "recentActions": ["stroke", "stroke", "clear"]
  }
}
```

### 响应（成功）
```json
{
  "reply": "好的，我帮你把草图转成水墨国风。",
  "actions": [
    { "tool": "generate_image", "args": { "styleKey": "gf-01", "strength": 0.6 } }
  ],
  "reasoning": [
    "识别到画布上有草图，形状较简单",
    "用户说了国风，直接选清单里的 gf-01（水墨国风）",
    "决定直接进入风格化，不做线条补全"
  ],
  "traceId": "a1b2c3"
}
```

> `styleKey` 一定是真实存在的 id：模型选了不存在的值，服务端会纠偏（见 2.1）。

### 响应（失败）
```json
{ "reply": "AI 暂时不可用，已切换本地模板。", "actions": [], "fallback": true }
```

---

## 2. 工具清单（Function Calling 的 7 个工具）

| 工具名         | 参数                          | 作用                             | 谁执行           |
| -------------- | ----------------------------- | -------------------------------- | ---------------- |
| set_color      | color: string                 | 换画笔颜色                       | 前端             |
| set_brush_size | size: number(1–50)            | 调笔触粗细                       | 前端             |
| erase          | mode: 'stroke' \| 'all'       | 橡皮擦                           | 前端             |
| clear          | —                             | 清空画布                         | 前端             |
| export         | format: 'png' \| 'jpg'        | 导出作品                         | 前端             |
| analyze_sketch | imageBase64?                  | 看图并给一段共情式解读 + 3 个建议 | 服务端（`/api/analyze-sketch`） |
| generate_image | styleKey, strength, refImage? | 草图风格化生成。**styleKey 必须来自系统提示里的画风清单** | 服务端调图像 API |

> `search_style` 已于 P2-11 移除：清单只有二十来条，直接塞进 prompt 让模型选，比关键词/向量检索都准
> （典型问题：用户说"毛茸茸的感觉"，词表匹配不到"治愈绘本"，LLM 能）。接口本身仍保留，见第 4 节。

### 2.1 画风直选与幻觉纠偏

`/api/agent` 的 system prompt 里会注入完整清单（每行 `- id：标题（标签…）`），并附三条选型规则：

1. 用户明确说了画风 → 选最匹配的 id；
2. 没直说但语境能推断（"毛茸茸软软" → 治愈绘本）→ 直接替他选，并写进 `reasoning`；
3. 完全没线索 → 用清单第一条作为默认。

返回前服务端会逐一纠偏 `generate_image` 的 `styleKey`：

| 模型给出的值 | 处理 |
| --- | --- |
| `gf-01` | 原样通过 |
| `GF-01` | 统一成小写 id |
| `水墨国风`（标题） | 换成对应 id |
| `gf-01（水墨）`（夹带说明） | 从文本里捞 id |
| `gf-99`（不存在） | 回退默认画风，并在 `reasoning` 里写一条纠偏说明 |

其它工具的参数不受影响；`actions` 超过 3 个会被 schema 拒绝并降级为本地模板。

---

## 3. POST /api/chat — 流式对话（SSE）

### 请求
```json
{ "messages": [{ "role": "user", "content": "这个草图适合什么风格？" }] }
```

### 响应：text/event-stream，逐块返回
```
data: {"delta":"这"}
data: {"delta":"幅"}
data: {"delta":"草图"}
...
data: {"done":true}
```

前端注意：用 AbortController 中断上一次请求，避免两段回答混在一起。

---

## 4. POST /api/search-style

> P2-11 之后这个接口**只服务"手动浏览画廊"**：Agent 聊天不再调它。
> 画廊在挂载时用空 query 拉一次全量清单。

### 请求
```json
{ "query": "国风 水墨", "k": 3 }
```

### 响应
```json
{
  "results": [
    { "id": "gf-01", "title": "水墨国风", "styleModifiers": "Chinese ink wash painting, ...", "score": 0.87 }
  ]
}
```

### 浏览模式：query 为空
```json
{ "query": "" }
```
返回**全部**风格，`score` 统一为 `0`（表示"不是检索结果，只是清单"）。

带 query 时仍走原来的词表 + 同义词匹配：`k` 默认 3、上限 5，只返回 `score > 0` 的条目。

---

## 5. POST /api/generate

### 请求
```json
{
  "imageBase64": "data:image/png;base64,...",
  "styleKey": "gf-01",
  "strength": 0.6,
  "promptOverride": null
}
```

### 响应
```json
{ "imageUrl": "data:image/jpeg;base64,...", "costMs": 8200, "provider": "cloudflare" }
```

失败时返回占位图，并把原因带上（`imageUrl` 是可显示的 SVG Data URL）：
```json
{ "imageUrl": "data:image/svg+xml;utf8,...", "costMs": 40000, "provider": "cloudflare", "fallback": true, "reason": "..." }
```

模型为 Cloudflare Workers AI 的图生图 `@cf/black-forest-labs/flux-2-klein-4b`（免费额度内可用），
> **注意**：`strength` 仅为入参兼容，**不参与请求** —— 这几款 Cloudflare 模型没有「重绘强度」参数，
> 重绘程度靠提示词里追加的「照着草图重画」控制。
换模型设 `CLOUDFLARE_IMAGE_MODEL` 环境变量即可。

---

## 6. 错误码约定

| 状态码 | 含义     | 前端处理               |
| ------ | -------- | ---------------------- |
| 400    | 参数错误 | 提示用户检查输入       |
| 401    | 未授权   | 提示登录               |
| 429    | 额度用尽 | 切本地模板             |
| 500    | 上游失败 | 切本地模板             |
| 503    | 降级中   | 显示“服务繁忙，已降级” |

---

## 7. Mock 数据（前端可直接用）

```json
// GET /api/_mock 返回一个固定对象，用于前端开发
{
  "agent": {
    "reply": "好的，我帮你把草图转成水墨国风。",
    "actions": [
      { "tool": "generate_image", "args": { "styleKey": "gf-01", "strength": 0.6 } }
    ],
    "reasoning": ["识别到画布上有草图", "用户说了国风，选 gf-01", "进入风格化"],
    "traceId": "mock-001"
  }
}
```



## 8. 手势状态约定（前端内部）

| 手势     | 触发条件                                                     | 动作           |
| -------- | ------------------------------------------------------------ | -------------- |
| idle     | 默认状态                                                     | 抬笔，不画线   |
| drawing  | 拇指尖(4)与食指尖(8)距离 / 手掌尺寸 < 进入阈值，连续 3 帧确认 | 落笔，开始画线 |
| 握拳清空 | 四指（不含拇指）指尖到手腕距离 / 掌高 < 阈值，且持续 1 秒 | 清空画布（触发一次，需松手才重新武装） |

调试参数（可调）：
- 捏合进入阈值：默认 0.25（`pinchEnter`）
- 捏合退出阈值：默认 0.35（`pinchExit`）
- 连续确认帧数：默认 3（`confirmFrames`，**只作用于落笔**；松开立即生效）
- 握拳清空持续时长：默认 1000ms（`fistHoldMs`）
- 握拳判定阈值：四指指尖到手腕距离 / 掌高 < 0.85（**不含拇指**，用 `[8,12,16,20]`）

---

## 9. POST /api/analyze-sketch — 多模态共情式解读

「看」和「说」分离：**llava 只看图**吐英文关键词，**DeepSeek 只把关键词讲成温柔的中文**。
这样两个模型的弱点都被绕过（llava 中文差、爱说废话；DeepSeek 看不见图、容易编细节）。

### 请求
```json
{ "imageBase64": "data:image/png;base64,...", "tone": "gentle" }
```

`tone` 可选四种：

| tone | 语气 | 差别 |
| --- | --- | --- |
| `gentle`（默认） | 温柔陪伴 | 观察具体而克制，情绪猜测只给一个 |
| `curious` | 好奇提问 | 少解读多提问，问得具体到某根线 |
| `poetic` | 诗意想象 | 允许一个比喻复述画面，不堆形容词 |
| `encourage` | 鼓励成长 | 肯定尝试与坚持，不谈像不像 |

### 响应
```json
{
  "success": true,
  "data": {
    "observation": "我看到很多弯曲的线，左下角挤得比较密。",
    "feeling": "我好像感觉到你在犹豫，有几笔反复改过。",
    "invitation": "这条从中间伸出去的线，是想画什么呀？",
    "suggestions": ["水墨风", "治愈绘本", "星空梦境"],
    "tone": "gentle",
    "keywords": "cat, triangle, oval, eyes",
    "degrade": "none",
    "costMs": 8964
  }
}
```

保证：
- `suggestions` **永远 3 个、每个 ≤6 字**：模型给不满就从建议池补齐，重复的会被去掉；
- `degrade` 标明降级情况：`none` / `llava`（看图失败，用通用关键词）/ `deepseek`（缺 key 或生成失败，用本地兜底文案）/ `both`；
- 任何一级失败都返回 `success: true` 的可显示内容，**不会 500**；
- 耗时：llava 约 9–20 秒 + DeepSeek 约 3–8 秒，客户端 timeout 建议 ≥ 90 秒。

> 当前 `frontend/.env` 若没有 `DEEPSEEK_API_KEY`，`degrade` 会是 `deepseek`，文案走兜底——功能可用但不个性化。