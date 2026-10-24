<template>
  <Teleport to="body">
    <Transition name="toast">
      <div
        v-if="ui.toastMessage"
        class="fixed bottom-6 left-1/2 z-[95] -translate-x-1/2 rounded-full border border-sage/25 bg-ink px-4 py-2.5 text-sm text-paper shadow-2xl"
        role="status"
        aria-live="polite"
      >
        {{ ui.toastMessage }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useUIStore } from '~/stores/ui'

const ui = useUIStore()
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
