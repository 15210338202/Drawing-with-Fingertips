<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.isResultOpen"
        class="fixed inset-0 z-[70] bg-ink/30 backdrop-blur-sm"
        @click="ui.closeResult()"
      />
    </Transition>

    <Transition name="slide-up">
      <div
        v-if="ui.isResultOpen"
        class="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6"
        @click.self="ui.closeResult()"
      >
        <section
          class="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-line bg-surface shadow-2xl sm:max-h-[86vh] sm:rounded-[32px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="result-title"
          @click.stop
        >
          <div class="flex justify-center pt-3">
            <div class="h-1.5 w-12 rounded-full bg-line" />
          </div>

          <header class="flex shrink-0 items-start justify-between gap-4 px-6 pb-3 pt-4 sm:px-8">
            <div>
              <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Your artwork</p>
              <h2 id="result-title" class="mt-1 text-xl font-bold text-ink sm:text-2xl">作品完成了</h2>
              <p class="mt-1 text-sm text-muted">可以贴回画布继续画，也可以留一张故事卡。</p>
            </div>
            <button
              ref="closeButton"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="关闭作品预览"
              @click="ui.closeResult()"
            >
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-4 sm:px-8">
            <div class="overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-sm">
              <img
                v-if="ui.resultImage"
                :src="ui.resultImage"
                alt="AI 生成的作品"
                class="mx-auto max-h-[42vh] w-auto max-w-full object-contain sm:max-h-[48vh]"
              >
            </div>
            <p v-if="ui.resultError" class="mt-2 text-sm leading-6 text-danger" role="alert">
              {{ ui.resultError }}
            </p>
          </div>

          <footer class="shrink-0 border-t border-line px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-8">
            <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                class="min-h-11 rounded-xl border border-line bg-surface-2 px-5 text-sm font-medium text-ink transition-colors hover:bg-line/50"
                @click="ui.closeResult()"
              >
                关闭
              </button>
              <button
                class="min-h-11 rounded-xl border border-sage/20 bg-sage-soft px-5 text-sm font-medium text-sage-strong transition-colors hover:bg-sage-soft/80"
                @click="emit('attach')"
              >
                贴回画布
              </button>
              <button
                class="min-h-11 rounded-xl bg-sage px-5 text-sm font-medium text-white shadow-md transition-colors hover:bg-sage-strong disabled:opacity-50"
                :disabled="ui.resultSaving"
                @click="emit('save')"
              >
                {{ ui.resultSaving ? '保存中…' : '保存故事卡' }}
              </button>
            </div>
            <p class="mt-3 text-center text-[11px] text-muted sm:text-left">
              故事卡会保存到浏览器下载目录，不会上传到云端。
            </p>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { useUIStore } from '~/stores/ui'

const emit = defineEmits<{
  attach: []
  save: []
}>()

const ui = useUIStore()
const closeButton = ref<HTMLButtonElement | null>(null)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') ui.closeResult()
}

watch(() => ui.isResultOpen, async (open) => {
  if (open) {
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    closeButton.value?.focus()
  }
  else {
    document.removeEventListener('keydown', onKeydown)
  }
})

onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active { transition: opacity 0.25s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

.slide-up-enter-active,
.slide-up-leave-active { transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1); }
.slide-up-enter-from,
.slide-up-leave-to { transform: translateY(100%); }
</style>
