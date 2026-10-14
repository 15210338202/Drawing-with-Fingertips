# Drawing with Fingertips (指尖绘迹)

**AI Native 隔空多模态创作 Agent**  —— 用指尖在空中画，用嘴和 AI 一起把草图变成作品

## 团队：指尖视界
- 华雪峰 (研究生，算法/全栈)
- 段博桐 (大二，产品/PPT/视频)
- 邝思绮 (大一，前端/UI)

## 目录结构
- `frontend/` - Vue3 + Nuxt3 前端
- `backend/` - 后端/ API 接入层
- `hardware/` - 树莓派、STM32、红外/偏振硬件控制
- `ai-models/` - 手部识别模型与蒸馏实验
- `experiments/` - 实验数据与对比
- `docs/` - 项目文档与PPT
- `research/` - 竞品调研与产品文档
- `.dsh-scratch/` - **临时目录**：AI 执行任务时产生的日志/脚本/中间产物，已加入 `.gitignore`，不提交、可随时整个删除



## 本地运行前准备

手部识别需要三样东西（共 6 个文件），**都没有纳入 Git 仓库**（见 `frontend/.gitignore` 里的 `public/models/*.task` 和 `public/wasm/*`）。
新克隆仓库后必须手动放一次，否则 MediaPipe 会退回去连 jsdelivr CDN —— 内网、校园网或断网环境下会直接失败。

在仓库根目录执行（PowerShell，假设 `frontend` 里已经 `pnpm install` 过）：

```powershell
cd frontend
New-Item -ItemType Directory -Force public\wasm, public\vendor | Out-Null

# 1) WASM 运行时：SIMD 版 + 老浏览器兜底的 nosimd 版
Copy-Item node_modules\@mediapipe\tasks-vision\wasm\vision_wasm_internal.* public\wasm\
Copy-Item node_modules\@mediapipe\tasks-vision\wasm\vision_wasm_nosimd_internal.* public\wasm\

# 2) 视觉库脚本：Worker 里用 importScripts 加载，执行后挂出全局 Vision
Copy-Item node_modules\@mediapipe\tasks-vision\vision_bundle.js public\vendor\

# 3) 手部关键点模型（npm 包里没有，要单独下载，约 7–8 MB）
New-Item -ItemType Directory -Force public\models | Out-Null
Invoke-WebRequest `
  -Uri 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' `
  -OutFile public\models\hand_landmarker.task
```

放好之后 `frontend/public/` 里应该多出这些文件（合计约 32 MB）：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `models/hand_landmarker.task` | 7.5 MB | 手部关键点模型，npm 包里没有，必须单独下载 |
| `vendor/vision_bundle.js` | 156 KB | MediaPipe 视觉库，Worker 里用 `importScripts` 加载 |
| `wasm/vision_wasm_internal.js` | 0.3 MB | 现代浏览器（支持 WASM SIMD）走这一对 |
| `wasm/vision_wasm_internal.wasm` | 13 MB | 同上 |
| `wasm/vision_wasm_nosimd_internal.js` | 0.3 MB | 不支持 WASM SIMD 的老浏览器兜底，走这一对 |
| `wasm/vision_wasm_nosimd_internal.wasm` | 12 MB | 同上 |

**几点说明**

- 图省事也可以直接把整个 `node_modules/@mediapipe/tasks-vision/wasm/` 文件夹拷过去，一样能用，只是会多带 13 MB 永远用不到的 `vision_wasm_module_internal.*`（只有 `forVisionTasks(path, true)` 那个双参数调用才会用到它）。
- 演示机器确定是较新的 Chrome / Edge（≥ 91）或 Safari ≥ 16.4 的话，`nosimd` 那两个文件可以删掉，再省 12.5 MB。
- **这三个文件齐了以后，整个识别流程完全不联网**：模型、WASM、视觉库全部从 `public/` 取，摄像头画面本来就来自本地设备。代码里保留的 jsdelivr 地址只是这几个文件缺失时的兜底。
- 验证：`cd frontend && pnpm dev`，打开页面点「开启摄像头」，按钮旁边显示 **「已识别到手」** 就说明整条链路通了。如果显示黄色的「手部模型加载失败：…」，基本都是上面某个文件没放对位置。