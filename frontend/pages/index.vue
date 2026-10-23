<template>
  <div class="min-h-screen bg-gray-100 p-4">
    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">指尖绘迹</h1>
        <p v-if="appStore.isSensoryFriendly" class="mt-0.5 text-xs text-green-700">
          感官友好模式已开启 · 动画更轻、声音更慢
        </p>
      </div>

      <button
        type="button"
        class="flex items-center gap-2 rounded-full border px-3 py-1.5 transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-300 focus-visible:ring-offset-1"
        :class="appStore.isSensoryFriendly
          ? 'border-green-300 bg-green-100 text-green-700'
          : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'"
        :aria-pressed="appStore.isSensoryFriendly"
        title="开启/关闭感官友好模式"
        @click="appStore.toggleSensoryMode()"
      >
        <svg
          class="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20.5 3.5C12 3.5 5.5 7 4.2 15.2c-.3 1.9 1 3.8 2.9 3.8 8.3 0 12.2-7.2 13.4-15.5Z" />
          <path d="M4.5 19.5c2.8-5.2 6.6-8.3 12-10.5" />
        </svg>
        <span class="text-sm font-medium">感官友好</span>
        <span v-if="appStore.isSensoryFriendly" class="text-[11px] text-green-600">已开启</span>
      </button>
    </header>

    <!-- 上半部分：摄像头 + 画布 -->
    <div class="grid grid-cols-2 gap-4">
      <CameraPreview />
      <DrawingCanvas ref="canvasRef" />
    </div>

    <!-- 下半部分：工具栏 + Agent 面板 + 风格库 -->
    <div class="mt-4 flex gap-4">
      <Toolbar @clear="canvasRef?.clear()" />
      <AgentPanel />
      <StyleGallery />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAppStore } from '~/stores/app'

const appStore = useAppStore()

/** DrawingCanvas 通过 defineExpose 暴露了 clear()，这里用模板 ref 接住它 */
const canvasRef = ref<{ clear: () => void } | null>(null)

onMounted(() => {
  // app.vue 已在挂载后初始化；这里兜底 HMR/多入口的极端情况。
  appStore.initSensoryMode()
})
</script>
