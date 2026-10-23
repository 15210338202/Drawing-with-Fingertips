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
        <SensoryToggle />
      </template>
    </AppHeader>

    <main class="mx-auto grid max-w-[1500px] gap-4 px-4 py-4 xl:grid-cols-[280px_minmax(0,1fr)_340px] xl:items-start">
      <!-- 小屏时画布优先，摄像头/工具在下方；宽屏时回到左栏 -->
      <div class="order-2 flex flex-col gap-3 xl:order-1 xl:sticky xl:top-20">
        <ToolRail @clear="canvasRef?.clear()" />
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

        <DrawingCanvas ref="canvasRef" />

        <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
          <span>捏合 · 落笔</span>
          <span>握拳 · 清空</span>
          <span>👍 · 生成</span>
          <span class="ml-auto hidden sm:inline">需要帮助时，打开右侧「小绘」</span>
        </div>
      </section>

      <AssistantDock class="order-3" />
    </main>
  </div>
</template>

<script setup lang="ts">
import AppHeader from '~/components/AppHeader.vue'
import SensoryToggle from '~/components/SensoryToggle.vue'
import ToolRail from '~/components/studio/ToolRail.vue'
import CameraDock from '~/components/studio/CameraDock.vue'
import AssistantDock from '~/components/studio/AssistantDock.vue'
import DrawingCanvas from '~/components/DrawingCanvas.vue'

const canvasRef = ref<{ clear: () => void } | null>(null)
</script>
