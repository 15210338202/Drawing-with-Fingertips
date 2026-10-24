<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="ui.isSettingsOpen"
        class="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-sm"
        @click="ui.closeSettings()"
      />
    </Transition>

    <Transition name="slide-right">
      <aside
        v-if="ui.isSettingsOpen"
        class="fixed right-0 top-0 z-[80] flex h-full w-[380px] max-w-[calc(100vw-1rem)] flex-col rounded-l-[28px] border-l border-line bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header class="flex items-center justify-between border-b border-line px-6 py-5">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Preferences</p>
            <h2 id="settings-title" class="mt-1 text-xl font-bold text-ink">设置</h2>
          </div>
          <button
            ref="closeButton"
            class="grid h-10 w-10 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="关闭设置"
            @click="ui.closeSettings()"
          >
            <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div class="flex-1 space-y-8 overflow-y-auto overscroll-contain px-6 py-6">
          <section class="space-y-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">无障碍</h3>
            <button
              class="flex w-full items-center justify-between gap-4 rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-left transition-colors hover:bg-surface-2"
              role="switch"
              :aria-checked="app.isSensoryFriendly"
              @click="toggleSensory"
            >
              <span>
                <span class="block text-sm font-medium text-ink">感官友好模式</span>
                <span class="mt-0.5 block text-xs leading-5 text-muted">减少动画、降低色彩刺激，声音也会放慢。</span>
              </span>
              <span
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                :class="app.isSensoryFriendly ? 'bg-sage' : 'bg-line'"
              >
                <span
                  class="absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all"
                  :class="app.isSensoryFriendly ? 'left-6' : 'left-1'"
                />
              </span>
            </button>
          </section>

          <section class="space-y-5">
            <div>
              <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">手势标定</h3>
              <p class="mt-1 text-xs leading-5 text-muted">调完立即生效，不需要保存。数值会随当前手型实时变化。</p>
            </div>

            <label class="block space-y-2">
              <span class="flex items-center justify-between text-sm">
                <span class="text-ink">捏合进入阈值</span>
                <span class="font-mono text-xs text-sage">{{ gesture.pinchEnter.toFixed(2) }}</span>
              </span>
              <input
                type="range" min="0.05" max="3" step="0.01"
                class="w-full accent-sage"
                :value="gesture.pinchEnter"
                @input="gesture.setPinchEnter(numberFrom($event))"
              >
            </label>

            <label class="block space-y-2">
              <span class="flex items-center justify-between text-sm">
                <span class="text-ink">捏合退出阈值</span>
                <span class="font-mono text-xs text-sage">{{ gesture.pinchExit.toFixed(2) }}</span>
              </span>
              <input
                type="range" min="0.05" max="3" step="0.01"
                class="w-full accent-sage"
                :value="gesture.pinchExit"
                @input="gesture.setPinchExit(numberFrom($event))"
              >
            </label>

            <label class="block space-y-2">
              <span class="flex items-center justify-between text-sm">
                <span class="text-ink">连续确认帧数</span>
                <span class="font-mono text-xs text-sage">{{ gesture.confirmFrames }}</span>
              </span>
              <input
                type="range" min="1" max="8" step="1"
                class="w-full accent-sage"
                :value="gesture.confirmFrames"
                @input="gesture.setConfirmFrames(numberFrom($event))"
              >
            </label>

            <label class="block space-y-2">
              <span class="flex items-center justify-between text-sm">
                <span class="text-ink">握拳阈值（四指）</span>
                <span class="font-mono text-xs text-sage">{{ gesture.fistThreshold.toFixed(2) }}</span>
              </span>
              <input
                type="range" min="0.4" max="1.2" step="0.05"
                class="w-full accent-sage"
                :value="gesture.fistThreshold"
                @input="gesture.setFistThreshold(numberFrom($event))"
              >
            </label>

            <label class="block space-y-2">
              <span class="flex items-center justify-between text-sm">
                <span class="text-ink">握拳保持</span>
                <span class="font-mono text-xs text-sage">{{ gesture.fistHoldMs }} ms</span>
              </span>
              <input
                type="range" min="400" max="2000" step="50"
                class="w-full accent-sage"
                :value="gesture.fistHoldMs"
                @input="gesture.setFistHoldMs(numberFrom($event))"
              >
            </label>

            <div class="flex flex-wrap gap-2">
              <button class="settings-chip" @click="gesture.capturePinchEnter()">捏合时记进入</button>
              <button class="settings-chip" @click="gesture.capturePinchExit()">张开时记退出</button>
            </div>
          </section>

          <section class="space-y-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">实时读数</h3>
            <div class="rounded-2xl border border-line bg-surface-2/70 p-4 font-mono text-[11px] leading-6 text-muted">
              <div class="flex justify-between">
                <span>捏合比例</span>
                <span class="text-ink">{{ gesture.debugPinchRatio.toFixed(3) }} <span class="text-muted">/ 2D</span></span>
              </div>
              <div class="flex justify-between">
                <span>四指最大值</span>
                <span class="text-ink">{{ gesture.debugFingerRatio.toFixed(3) }}</span>
              </div>
              <div class="flex justify-between">
                <span>清空触发</span>
                <span class="text-ink">{{ gesture.clearRequested }} 次</span>
              </div>
            </div>
            <p class="text-[11px] leading-5 text-muted">
              捏合读数明显高于进入阈值时，先在这里点“捏合时记进入”做一次现场标定。
            </p>
          </section>

          <section class="border-t border-line pt-5">
            <button class="settings-chip settings-chip-danger" @click="resetGesture">
              恢复手势默认值
            </button>
          </section>

          <section class="space-y-3 border-t border-line pt-5">
            <div>
              <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">本机数据</h3>
              <p class="mt-1 text-xs leading-5 text-muted">
                成长档案只保存在这台设备。公共设备换人使用前，可以清空档案，换一本新画册。
              </p>
            </div>
            <button
              class="settings-chip settings-chip-danger w-full"
              :disabled="clearingData"
              @click="resetLocalData"
            >
              {{ clearingData ? '正在清空…' : '清空本机档案，换一本画册' }}
            </button>
            <p v-if="dataError" class="text-xs leading-5 text-danger" role="alert">
              {{ dataError }}
            </p>
            <p class="text-[11px] leading-5 text-muted">
              只会清空故事卡；感官友好设置和手势标定会保留。
            </p>
          </section>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { useUIStore } from '~/stores/ui'
import { useAppStore } from '~/stores/app'
import { useGestureStore } from '~/stores/gesture'
import { clearStoryCards } from '~/utils/archive'

const ui = useUIStore()
const app = useAppStore()
const gesture = useGestureStore()

const closeButton = ref<HTMLButtonElement | null>(null)
const clearingData = ref(false)
const dataError = ref('')

function toggleSensory() {
  app.setSensoryMode(!app.isSensoryFriendly)
}

function numberFrom(event: Event) {
  return Number((event.target as HTMLInputElement).value)
}

function resetGesture() {
  gesture.setPinchEnter(0.25)
  gesture.setPinchExit(0.35)
  gesture.setConfirmFrames(3)
  gesture.setFistHoldMs(1000)
  gesture.setFistThreshold(0.85)
}

async function resetLocalData() {
  if (clearingData.value) return

  const confirmed = window.confirm(
    '确定要清空这台设备上的全部画作档案吗？\n\n'
    + '清空后无法恢复。感官友好设置和手势标定会保留。',
  )
  if (!confirmed) return

  clearingData.value = true
  dataError.value = ''
  try {
    await clearStoryCards()
    ui.showToast('本机档案已清空，可以开始新的一本画册了')
    ui.closeSettings()
    // 重新加载，顺手清掉当前画布/对话/结果等内存状态；
    // localStorage 里的无障碍偏好和标定故意保留。
    window.setTimeout(() => window.location.reload(), 500)
  }
  catch (err) {
    console.error('[settings] 清空本机档案失败：', err)
    dataError.value = `清空没有成功：${(err as Error)?.message ?? '请再试一次'}`
    clearingData.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') ui.closeSettings()
}

watch(() => ui.isSettingsOpen, async (open) => {
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

.slide-right-enter-active,
.slide-right-leave-active { transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1); }
.slide-right-enter-from,
.slide-right-leave-to { transform: translateX(100%); }

.settings-chip {
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  padding: 0.45rem 0.8rem;
  font-size: 0.75rem;
  line-height: 1.2;
  color: var(--color-ink);
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
.settings-chip:hover {
  border-color: var(--color-sage);
  background: var(--color-sage-soft);
}
.settings-chip:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.settings-chip-danger {
  color: var(--color-danger);
}
.settings-chip-danger:hover {
  border-color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 7%, var(--color-surface));
}
</style>
