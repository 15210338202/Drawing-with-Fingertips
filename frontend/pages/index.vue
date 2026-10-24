<template>
  <div class="min-h-screen overflow-hidden bg-paper">
    <AppHeader />

    <main class="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-[1200px] items-center px-4 py-10 sm:px-6 lg:py-16">
      <div class="welcome-glow" aria-hidden="true" />

      <div class="relative grid w-full items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
        <section>
          <p class="text-xs font-semibold tracking-[0.22em] text-sage">一个安静的手势画室</p>

          <h1 class="mt-4 text-[2.5rem] font-semibold leading-[1.15] tracking-wide text-ink sm:text-5xl lg:text-[3.4rem]">
            用手，把心里的
            <span class="block text-sage">画面画出来。</span>
          </h1>

          <p class="mt-6 max-w-xl text-base leading-8 text-muted sm:text-lg">
            捏合落笔，握拳清空，比个 👍 让小绘帮你把涂鸦变成作品。
            不需要画笔，也不需要赶时间。
          </p>

          <div class="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              class="group inline-flex min-h-12 items-center gap-2 rounded-full bg-sage px-6 text-base font-semibold text-white shadow-soft transition-colors hover:bg-sage-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-wait disabled:opacity-70"
              :disabled="entering"
              @click="enterStudio"
            >
              {{ entering ? '正在进入…' : '进入画室' }}
              <svg
                v-if="!entering"
                class="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14" />
                <path d="m13 6 6 6-6 6" />
              </svg>
            </button>

            <a
              href="#how"
              class="inline-flex min-h-12 items-center rounded-full px-3 text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
            >
              先看看怎么用
            </a>
          </div>

          <p class="mt-6 flex max-w-md items-start gap-2 text-xs leading-5 text-muted">
            <svg
              class="mt-0.5 h-3.5 w-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6L12 3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span>
              摄像头画面只在本机识别，不会上传。
              <template v-if="app.autoStartCamera">
                已开启“自动开启摄像头”：浏览器已授权时会直接进入画室；随时可在设置里关闭。
              </template>
              <template v-else>
                进入画室后，由你决定是否开启摄像头。
              </template>
            </span>
          </p>
        </section>

        <section class="relative mx-auto w-full max-w-[460px]" aria-label="画室预览">
          <div class="paper-stage">
            <div class="flex items-center justify-between border-b border-line/80 pb-3">
              <div class="flex items-center gap-2">
                <span class="h-2 w-2 rounded-full bg-sage" aria-hidden="true" />
                <span class="text-xs font-medium tracking-wide text-muted">正在创作</span>
              </div>
              <span class="rounded-full bg-sage-soft px-2 py-1 text-[10px] font-medium text-sage">小绘陪着你</span>
            </div>

            <div class="relative mt-4 aspect-[4/3] overflow-hidden rounded-2xl border border-line/80 bg-[#fffdf8]">
              <svg
                class="absolute inset-0 h-full w-full"
                viewBox="0 0 420 315"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M58 232c34-47 63-50 88-18 26 33 53 21 74-22 18-37 44-48 65-29 22 19 40 7 63-26"
                  stroke="#4f735f"
                  stroke-width="5"
                  stroke-linecap="round"
                />
                <circle cx="305" cy="112" r="46" fill="#e5efe7" />
                <circle cx="126" cy="94" r="22" fill="#f1ddd1" />
                <path d="M72 272h120" stroke="#e2d8c7" stroke-width="3" stroke-linecap="round" />
                <path d="M72 284h76" stroke="#e2d8c7" stroke-width="3" stroke-linecap="round" />
              </svg>

              <span class="absolute left-5 top-5 inline-flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-medium text-sage shadow-sm backdrop-blur">
                <span class="h-1.5 w-1.5 rounded-full bg-sage" aria-hidden="true" />
                捏合 · 落笔
              </span>

              <span class="absolute bottom-4 right-4 inline-flex items-center gap-1.5 rounded-full bg-ink/80 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm backdrop-blur">
                👍 · 生成
              </span>
            </div>

            <div class="mt-4 flex items-center gap-3 rounded-2xl border border-line/80 bg-surface px-3 py-2.5">
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peach/15 text-sm">✦</span>
              <p class="text-xs leading-5 text-muted">
                画完停一会儿，小绘会轻轻问你：<br>
                “需要我帮你把这幅画变成艺术品吗？”
              </p>
            </div>
          </div>

          <div class="absolute -bottom-4 -left-4 hidden rounded-2xl border border-line bg-surface px-3 py-2 text-[11px] text-muted shadow-soft sm:block">
            手势优先 · 也可以鼠标
          </div>
        </section>
      </div>
    </main>

    <section id="how" class="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6">
      <div class="grid gap-3 sm:grid-cols-3">
        <article
          v-for="step in steps"
          :key="step.number"
          class="rounded-card border border-line bg-surface p-4 shadow-soft"
        >
          <p class="text-xs font-semibold tracking-[0.18em] text-sage">{{ step.number }}</p>
          <h2 class="mt-2 text-base font-semibold text-ink">{{ step.title }}</h2>
          <p class="mt-1.5 text-sm leading-6 text-muted">{{ step.body }}</p>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import AppHeader from '~/components/AppHeader.vue'
import { useAppStore } from '~/stores/app'
import { useUIStore } from '~/stores/ui'

const app = useAppStore()
const ui = useUIStore()

const entering = ref(false)
const autoRedirecting = ref(false)

/** 同一个标签页只自动进一次；否则用户按后退会被立刻弹回画室 */
const AUTO_ENTERED_KEY = 'autoCameraEntered'

const steps = [
  {
    number: '01',
    title: '开启摄像头',
    body: '进入画室后点一下“开启摄像头”；如果设置里开了自动开启，授权后会直接打开。画面只在本机识别，不会上传。',
  },
  {
    number: '02',
    title: '捏合落笔',
    body: '食指和拇指轻轻捏住，像握笔一样移动；松开就停笔。握拳可以清空。',
  },
  {
    number: '03',
    title: '交给小绘',
    body: '比个 👍，或点“让 AI 猜猜”，小绘会帮你生成作品、讲出画里的心情。',
  },
]

type CameraPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown'

async function cameraPermissionState(): Promise<CameraPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unknown'

  try {
    const status = await navigator.permissions?.query({ name: 'camera' as PermissionName })
    if (!status) return 'prompt'
    return status.state as CameraPermissionState
  }
  catch {
    // Firefox / 部分内嵌浏览器不支持 camera 权限查询；不要自动询问
    return 'unknown'
  }
}

/** 只做权限预检，拿到流后立即释放；真正的预览由 CameraPreview 启动 */
async function warmUpCamera(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    stream.getTracks().forEach(track => track.stop())
    return true
  }
  catch {
    return false
  }
}

async function autoEnterIfAllowed() {
  app.initAutoStartCamera()
  if (!app.autoStartCamera || autoRedirecting.value || entering.value) return

  // 自动进入只做一次：从画室按后退回来时，保留欢迎页，避免“后退即弹回”的死循环。
  try {
    if (window.sessionStorage.getItem(AUTO_ENTERED_KEY) === '1') return
  }
  catch {
    // 隐私模式禁用 sessionStorage 时，退回普通点击进入
    return
  }
  const permission = await cameraPermissionState()
  if (permission !== 'granted') return

  autoRedirecting.value = true
  const ok = await warmUpCamera()
  if (ok) {
    try {
      window.sessionStorage.setItem(AUTO_ENTERED_KEY, '1')
    }
    catch {
      // 存不下也继续，最坏情况是后退时再自动进一次
    }
    app.requestAutoCamera()
    await navigateTo('/studio')
    return
  }

  // 权限显示已授权但设备/浏览器仍拒绝时，留在欢迎页，等用户点大按钮
  autoRedirecting.value = false
}

async function enterStudio() {
  if (entering.value) return
  entering.value = true

  try {
    if (app.autoStartCamera) {
      const ok = await warmUpCamera()
      if (ok) {
        app.requestAutoCamera()
      }
      else {
        // 拒绝授权不能死锁：画布本身支持鼠标/触控板
        ui.showToast('摄像头没有开启，已进入鼠标/触控板绘画模式。')
      }

      // 手动进入也算用掉了本次自动进入；按后退时应该能回到欢迎页
      try {
        window.sessionStorage.setItem(AUTO_ENTERED_KEY, '1')
      }
      catch {
        // ignore
      }
    }

    await navigateTo('/studio')
  }
  finally {
    entering.value = false
  }
}

onMounted(() => {
  void autoEnterIfAllowed()
})
</script>

<style scoped>
.welcome-glow {
  position: absolute;
  top: -120px;
  right: -100px;
  width: 460px;
  height: 460px;
  border-radius: 9999px;
  background: radial-gradient(circle, rgb(79 115 95 / 0.12), transparent 68%);
  pointer-events: none;
}

.paper-stage {
  position: relative;
  border: 1px solid #e2d8c7;
  border-radius: 28px;
  background:
    linear-gradient(145deg, rgb(255 252 245 / 0.96), rgb(246 241 231 / 0.9)),
    repeating-linear-gradient(0deg, rgb(120 100 72 / 0.035) 0 1px, transparent 1px 5px);
  padding: 18px;
  box-shadow: 0 18px 50px rgb(60 50 40 / 0.1);
}

@media (max-width: 640px) {
  .welcome-glow {
    width: 280px;
    height: 280px;
    right: -120px;
  }
}
</style>
