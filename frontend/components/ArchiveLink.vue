<template>
  <NuxtLink
    to="/archive"
    class="relative flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
    :class="ui.archiveFlash
      ? 'border-sage bg-sage-soft text-sage-strong'
      : 'border-line bg-surface text-ink hover:bg-surface-2'"
    aria-label="打开成长档案"
  >
    <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h8" />
    </svg>
    <span class="hidden sm:inline">档案</span>
    <span
      v-if="ui.archiveFlash"
      class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-sage ring-2 ring-surface"
      aria-hidden="true"
    />
  </NuxtLink>
</template>

<script setup lang="ts">
import { useUIStore } from '~/stores/ui'

const ui = useUIStore()
</script>
