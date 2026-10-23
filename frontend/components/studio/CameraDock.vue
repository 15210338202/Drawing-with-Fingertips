<template>
  <section class="camera-dock rounded-card border border-line bg-surface p-3 shadow-soft">
    <div class="flex items-start justify-between gap-2 px-1">
      <div>
        <h2 class="text-sm font-semibold text-ink">手部摄像头</h2>
        <p class="mt-0.5 text-[11px] text-muted">画面只在本机识别</p>
      </div>
      <button
        type="button"
        class="min-h-9 rounded-full border border-line px-2.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        :aria-expanded="open"
        @click="open = !open"
      >
        {{ open ? '收起' : '展开' }}
      </button>
    </div>

    <div v-show="open" class="mt-2 overflow-hidden rounded-xl">
      <CameraPreview />
    </div>
  </section>
</template>

<script setup lang="ts">
import CameraPreview from '~/components/CameraPreview.vue'

const open = ref(true)
</script>

<style scoped>
/* 让完整的 CameraPreview 在窄侧栏里收成一张干净的预览卡，不改它的识别逻辑 */
.camera-dock :deep(.camera-preview) {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.camera-dock :deep(.camera-preview > h2) {
  display: none;
}
</style>
