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

本项目依赖以下大文件，未纳入 Git 仓库，请手动放置：

1. **MediaPipe WASM 运行时**
   从 `node_modules/@mediapipe/tasks-vision/wasm/` 复制整个 `wasm` 文件夹到 `frontend/public/wasm/`

2. **手部关键点模型**
   下载 `hand_landmarker.task`（约 7–8 MB）：
   https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
   放到 `frontend/public/models/hand_landmarker.task`