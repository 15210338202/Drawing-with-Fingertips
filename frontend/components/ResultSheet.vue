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
            <div class="relative overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-sm">
              <img
                v-if="ui.resultImage"
                :src="ui.resultImage"
                alt="AI 生成的作品"
                class="mx-auto max-h-[42vh] w-auto max-w-full object-contain sm:max-h-[38vh]"
              >
              <div
                v-if="isRegenerating"
                class="absolute inset-0 grid place-items-center bg-surface/70 backdrop-blur-sm"
                aria-live="polite"
              >
                <span class="animate-pulse text-sm font-semibold text-sage-strong">重新生成中…</span>
              </div>
            </div>

            <p v-if="ui.resultError" class="mt-2 text-sm leading-6 text-danger" role="alert">
              {{ ui.resultError }}
            </p>

            <div
              v-if="currentSuggestion"
              class="mt-3 rounded-xl border border-sage/15 bg-sage-soft px-3 py-2.5 text-sm leading-6 text-ink"
            >
              <span class="font-semibold text-sage-strong">AI 认为：</span>
              {{ currentSuggestion.reason }}
            </div>

            <div v-if="suggestions.length" class="mt-4">
              <p class="text-xs font-medium tracking-wide text-muted">换一种风格试试？</p>
              <div class="mt-2 flex gap-2 overflow-x-auto pb-1">
                <button
                  v-for="suggestion in suggestions"
                  :key="suggestion.styleKey"
                  class="flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm transition-colors disabled:opacity-50"
                  :class="agent.lastGeneratedStyleId === suggestion.styleKey
                    ? 'border-sage bg-sage text-white'
                    : 'border-line bg-surface text-ink hover:bg-surface-2'"
                  :disabled="isRegenerating || agent.isGenerating"
                  :title="suggestion.reason"
                  @click="regenerate(suggestion.styleKey)"
                >
                  <span>{{ styleTitle(suggestion.styleKey) }}</span>
                  <span
                    class="text-[11px]"
                    :class="agent.lastGeneratedStyleId === suggestion.styleKey ? 'text-white/70' : 'text-muted'"
                  >
                    {{ Math.round(suggestion.score * 100) }}%
                  </span>
                </button>
              </div>
            </div>
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
                class="min-h-11 rounded-xl border border-sage/20 bg-sage-soft px-5 text-sm font-medium text-sage-strong transition-colors hover:bg-sage-soft/80 disabled:opacity-50"
                :disabled="isRegenerating"
                @click="emit('attach')"
              >
                贴回画布
              </button>
              <button
                class="min-h-11 rounded-xl bg-sage px-5 text-sm font-medium text-white shadow-md transition-colors hover:bg-sage-strong disabled:opacity-50"
                :disabled="isRegenerating || ui.resultSaving"
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
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useAgentStore } from '~/stores/agent'
import { useAgent } from '~/composables/useAgent'
import { useUIStore } from '~/stores/ui'

const emit = defineEmits<{
  attach: []
  save: []
}>()

const ui = useUIStore()
const agent = useAgentStore()
const { runAction } = useAgent()
const closeButton = ref<HTMLButtonElement | null>(null)
const isRegenerating = ref(false)

const suggestions = computed(() => agent.currentSuggestions)

/** 当前图对应的那条推荐；没有推荐（比如从风格库直接生成）时不显示理由 */
const currentSuggestion = computed(() => {
  return suggestions.value.find(item => item.styleKey === agent.lastGeneratedStyleId)
    ?? suggestions.value.find(item => item.styleKey === agent.lastStyleKey)
    ?? null
})

function styleTitle(styleKey: string): string {
  return agent.styleResults.find(item => item.id === styleKey)?.title ?? styleKey
}

/**
 * 换推荐风格重绘。
 * 必须复用生成当前作品的那张草图：用户可能已经贴回/继续画，现场重新导出会变成另一幅画。
 */
async function regenerate(styleKey: string) {
  if (isRegenerating.value || agent.isGenerating) return

  const sketch = agent.lastSketchBase64
  if (!sketch) {
    ui.setResultError('找不到这张作品的草图，请重新生成一次。')
    return
  }

  isRegenerating.value = true
  ui.setResultError('')

  try {
    const message = await runAction({
      tool: 'generate_image',
      args: {
        styleKey,
        sketchBase64: sketch,
        strength: 0.6,
      },
    })

    if (!message.startsWith('生成完成')) ui.setResultError(message)
  }
  catch (err) {
    console.error('[result] 换风格失败：', err)
    ui.setResultError('换风格失败，请再试一次。')
  }
  finally {
    isRegenerating.value = false
  }
}

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
