<template>
  <button
    type="button"
    class="flex min-h-11 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
    :class="appStore.isSensoryFriendly
      ? 'border-sage/40 bg-sage-soft text-sage'
      : 'border-line bg-surface text-muted hover:border-sage/30 hover:text-ink'"
    :aria-pressed="appStore.isSensoryFriendly"
    title="开启或关闭感官友好模式"
    @click="appStore.toggleSensoryMode()"
  >
    <svg
      class="h-4 w-4 shrink-0"
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
    <span>感官友好</span>
    <span
      v-if="appStore.isSensoryFriendly"
      class="rounded-full bg-white/60 px-1.5 py-0.5 text-[11px] text-sage"
    >
      已开启
    </span>
  </button>
</template>

<script setup lang="ts">
import { useAppStore } from '~/stores/app'

const appStore = useAppStore()
</script>
