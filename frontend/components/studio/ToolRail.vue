<template>
  <aside class="rounded-card border border-line bg-surface p-3 shadow-soft">
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xs font-semibold tracking-[0.18em] text-muted">工具</h2>
      <span class="text-[11px] text-muted/80">手势优先</span>
    </div>

    <div class="mt-3 space-y-2">
      <div
        class="flex min-h-11 items-center gap-2.5 rounded-xl bg-sage-soft px-3 text-sm font-medium text-sage"
        aria-current="true"
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
          <path d="m4 20 4.5-1.2L20 7.3a2.1 2.1 0 0 0-3-3L5.5 15.8 4 20Z" />
          <path d="m14.5 5.5 3 3" />
        </svg>
        画笔
      </div>

      <button
        v-if="hasArtwork"
        type="button"
        class="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-sage/20 bg-sage-soft px-3 text-left text-sm font-medium text-sage-strong transition-colors hover:bg-sage-soft/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/30"
        @click="emit('view')"
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
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m21 15-5-5L5 20" />
        </svg>
        查看作品
      </button>

      <button
        type="button"
        class="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-left text-sm font-medium text-ink transition-colors hover:border-danger/30 hover:bg-danger/5 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
        @click="emit('clear')"
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
          <path d="M4 7h16" />
          <path d="M9 7V5h6v2" />
          <path d="m6 7 1 13h10l1-13" />
          <path d="M10 11v5M14 11v5" />
        </svg>
        清空画布
      </button>

      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/30 disabled:cursor-not-allowed disabled:border-line/70 disabled:bg-surface-2/50 disabled:text-muted/50"
          :disabled="!canUndo"
          title="撤销上一步（Ctrl+Z）"
          @click="emit('undo')"
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
            <path d="m9 7-4 4 4 4" />
            <path d="M5 11h8a6 6 0 0 1 0 12" />
          </svg>
          撤销
        </button>

        <button
          type="button"
          class="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/30 disabled:cursor-not-allowed disabled:border-line/70 disabled:bg-surface-2/50 disabled:text-muted/50"
          :disabled="!canRedo"
          title="重做（Ctrl+Shift+Z）"
          @click="emit('redo')"
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
            <path d="m15 7 4 4-4 4" />
            <path d="M19 11h-8a6 6 0 0 0 0 12" />
          </svg>
          重做
        </button>
      </div>
    </div>

    <div class="mt-4 border-t border-line/70 pt-3">
      <p class="px-1 text-[11px] leading-5 text-muted">
        捏合落笔<br>
        握拳清空<br>
        👍 交给小绘
      </p>
    </div>
  </aside>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  hasArtwork?: boolean
  canUndo?: boolean
  canRedo?: boolean
}>(), {
  hasArtwork: false,
  canUndo: false,
  canRedo: false,
})
const emit = defineEmits<{ clear: []; view: []; undo: []; redo: [] }>()
</script>
