# 接口契约 v0.1

> **状态（2026-10-18 按仓库代码核对）**：LLM 为 DeepSeek V4.1-Flash（`deepseek-flash`，OpenAI 兼容）；图像生成为 Cloudflare Workers AI（`@cf/black-forest-labs/flux-2-klein-4b`，图生图）。
> 本次修正了 4 处与代码不符：代码围栏转义、SSE 结束帧、手势阈值、`strength` 语义；并标注 `analyze_sketch` 尚未实现。


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
  "reply": "好的，我帮你把草图转成国风插画。",
  "actions": [
    { "tool": "search_style", "args": { "style": "guofeng" } },
    { "tool": "generate_image", "args": { "styleKey": "guofeng", "strength": 0.6 } }
  ],
  "reasoning": [
    "识别到画布上有草图，形状较简单",
    "检索到 3 条国风风格模板",
    "决定直接进入风格化，不做线条补全"
  ],
  "traceId": "a1b2c3"
}
```

### 响应（失败）
```json
{ "reply": "AI 暂时不可用，已切换本地模板。", "actions": [], "fallback": true }
```

---

## 2. 工具清单（Function Calling 的 8 个工具）

| 工具名         | 参数                          | 作用                             | 谁执行           |
| -------------- | ----------------------------- | -------------------------------- | ---------------- |
| set_color      | color: string                 | 换画笔颜色                       | 前端             |
| set_brush_size | size: number(1–50)            | 调笔触粗细                       | 前端             |
| erase          | mode: 'stroke' \| 'all'       | 橡皮擦                           | 前端             |
| clear          | —                             | 清空画布                         | 前端             |
| export         | format: 'png' \| 'jpg'        | 导出作品                         | 前端             |
| analyze_sketch | imageBase64?                  | 分析草图像什么 + 给 3 个风格建议 | ⚠️ **尚未实现**（`useAgent.ts` 当前直接跳过，返回「多模态分支还没接」） |
| search_style   | style: string, k?: number     | 检索风格提示词（RAG）。**接口 `k` 上限 5**，工具签名允许到 10，差值会被 clamp | 服务端 |
| generate_image | styleKey, strength, refImage? | 草图风格化生成                   | 服务端调图像 API |

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

### 请求
```json
{ "query": "国风 水墨", "k": 3 }
```

### 响应
```json
{
  "results": [
    { "id": "gf-01", "title": "水墨国风", "prompt": "Chinese ink painting, ...", "score": 0.87 }
  ]
}
```

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
    "reply": "好的，我帮你把草图转成国风插画。",
    "actions": [
      { "tool": "search_style", "args": { "style": "guofeng" } },
      { "tool": "generate_image", "args": { "styleKey": "guofeng", "strength": 0.6 } }
    ],
    "reasoning": ["识别到画布上有草图", "检索到 3 条模板", "进入风格化"],
    "traceId": "mock-001"
  }
}
```



## 8. 手势状态约定（前端内部）

| 手势     | 触发条件                                                     | 动作           |
| -------- | ------------------------------------------------------------ | -------------- |
| idle     | 默认状态                                                     | 抬笔，不画线   |
| drawing  | 拇指尖(4)与食指尖(8)距离 / 手掌尺寸 < 进入阈值，连续 3 帧确认 | 落笔，开始画线 |
| 握拳清空 | 5 指指尖到手腕距离均 < 阈值，持续 1 秒 + 二次确认            | 清空画布       |

调试参数（可调）：
- 捏合进入阈值：默认 0.25（`pinchEnter`）
- 捏合退出阈值：默认 0.35（`pinchExit`）
- 连续确认帧数：默认 3（`confirmFrames`，**只作用于落笔**；松开立即生效）
- 握拳清空持续时长：默认 1000ms（`fistHoldMs`）
- 握拳判定阈值：四指指尖到手腕距离 / 掌高 < 0.85（**不含拇指**，用 `[8,12,16,20]`）