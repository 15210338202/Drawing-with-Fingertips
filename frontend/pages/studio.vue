<template>
  <div class="min-h-screen bg-paper">
    <AppHeader>
      <template #actions>
        <NuxtLink
          to="/"
          class="flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-2/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        >
          首页
        </NuxtLink>
        <ArchiveLink />
        <button
          class="flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
          aria-label="打开设置"
          @click="ui.openSettings()"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4 text-muted" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.36.35.7.6 1 .3.3.7.45 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z" />
          </svg>
          <span class="hidden sm:inline">设置</span>
        </button>
      </template>
    </AppHeader>

    <main class="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 xl:grid-cols-[280px_minmax(0,1fr)_340px] xl:items-start">
      <!-- 小屏时画布优先，摄像头/工具在下方；宽屏时回到左栏 -->
      <div class="order-2 flex flex-col gap-3 xl:order-1 xl:sticky xl:top-20">
        <ToolRail
          :has-artwork="Boolean(agent.generatedImage)"
          :can-undo="canUndo"
          :can-redo="canRedo"
          @clear="canvasRef?.clear()"
          @view="viewResult"
          @undo="canvasRef?.undo()"
          @redo="canvasRef?.redo()"
        />
        <CameraDock />
      </div>

      <section class="order-1 min-w-0 xl:order-2">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            <h1 class="text-2xl font-semibold tracking-wide text-ink">画室</h1>
            <p class="mt-1 text-sm text-muted">捏合落笔，握拳清空，比个 👍 交给小绘。</p>
          </div>
          <span class="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
            <span class="h-1.5 w-1.5 rounded-full bg-sage" aria-hidden="true" />
            画面只在本机识别
          </span>
        </div>

        <DrawingCanvas ref="canvasRef" @history="onHistory" />

        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
          <span>捏合 · 落笔</span>
          <span>握拳 · 清空</span>
          <span>👍 · 生成</span>
          <span class="ml-auto hidden sm:inline">需要帮助时，打开右侧「小绘」</span>
        </div>
      </section>

      <AssistantDock class="order-3" />
    </main>

    <SettingsDrawer />
    <ResultSheet
      @save="saveResult"
      @attach="attachResult"
    />
  </div>
</template>

<script setup lang="ts">
import AppHeader from '~/components/AppHeader.vue'
import ArchiveLink from '~/components/ArchiveLink.vue'
import ToolRail from '~/components/studio/ToolRail.vue'
import CameraDock from '~/components/studio/CameraDock.vue'
import AssistantDock from '~/components/studio/AssistantDock.vue'
import DrawingCanvas from '~/components/DrawingCanvas.vue'
import SettingsDrawer from '~/components/SettingsDrawer.vue'
import ResultSheet from '~/components/ResultSheet.vue'
import { useUIStore } from '~/stores/ui'

interface CanvasHandle {
  clear: () => void
  undo: () => boolean
  redo: () => boolean
  archiveStoryCard: () => Promise<boolean>
  pasteGenerated: () => Promise<boolean>
}

const ui = useUIStore()
const agent = useAgentStore()
const canvasRef = ref<CanvasHandle | null>(null)
const canUndo = ref(false)
const canRedo = ref(false)

function onHistory(state: { canUndo: boolean; canRedo: boolean }) {
  canUndo.value = state.canUndo
  canRedo.value = state.canRedo
}

// 任何生成入口（👍、风格卡、空闲建议）最终都会写 generatedImage；
// 统一在这里打开结果 Sheet，避免每个入口各写一遍。
watch(() => agent.generatedImage, (image) => {
  if (image) ui.openResult(image)
})

async function saveResult() {
  if (ui.resultSaving) return
  ui.setResultSaving(true)
  try {
    const saved = await canvasRef.value?.archiveStoryCard()
    if (saved === false) ui.setResultError('故事卡存入档案失败，请再试一次。')
  }
  finally {
    ui.setResultSaving(false)
  }
}

function viewResult() {
  if (agent.generatedImage) ui.openResult(agent.generatedImage)
}

async function attachResult() {
  const attached = await canvasRef.value?.pasteGenerated()
  if (attached) ui.closeResult()
  else ui.setResultError('贴回画布失败，请再试一次。')
}
</script>
