<template>
  <Teleport to="body">
    <Transition name="gesture-notice">
      <div
        v-if="ui.gestureNotice"
        class="pointer-events-none fixed inset-x-0 top-20 z-[60] flex justify-center px-4 sm:top-24"
      >
        <div
          class="flex max-w-[min(92vw,680px)] items-start gap-3 rounded-2xl border px-5 py-3.5 shadow-[0_12px_40px_rgb(47_43_37_/_0.22)] backdrop-blur-sm"
          :class="meta.class"
          role="status"
          :aria-live="ui.gestureNoticeTone === 'error' ? 'assertive' : 'polite'"
        >
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs font-bold leading-none"
            aria-hidden="true"
          >
            {{ meta.icon }}
          </span>
          <p class="text-base font-medium leading-6 tracking-wide sm:text-lg sm:leading-7">
            {{ ui.gestureNotice }}
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useUIStore } from '~/stores/ui'

const ui = useUIStore()

const meta = computed(() => ({
  info: {
    icon: '·',
    class: 'border-white/10 bg-ink/95 text-white',
  },
  success: {
    icon: '✓',
    class: 'border-white/15 bg-sage text-white',
  },
  warn: {
    icon: '!',
    class: 'border-[#f2c48b]/40 bg-[#a9681f] text-white',
  },
  error: {
    icon: '!',
    class: 'border-white/15 bg-danger text-white',
  },
}[ui.gestureNoticeTone]))
</script>

<style scoped>
.gesture-notice-enter-active,
.gesture-notice-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.gesture-notice-enter-from,
.gesture-notice-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
