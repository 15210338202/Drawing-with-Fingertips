<template>
  <div class="min-h-screen bg-paper">
    <AppHeader>
      <template #actions>
        <SensoryToggle />
        <NuxtLink
          to="/studio"
          class="flex min-h-11 items-center rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        >
          回画室
        </NuxtLink>
      </template>
    </AppHeader>

    <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-sage-strong">
            Your archive
          </p>
          <h1 class="mt-2 text-3xl font-semibold tracking-wide text-ink">成长档案</h1>
          <p class="mt-2 max-w-xl text-sm leading-6 text-muted">
            每张故事卡都存在这台设备上，不会上传。想拿原图时，点一下「下载」。
          </p>
        </div>
        <span class="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
          {{ cards.length }} 张作品
        </span>
      </div>

      <div v-if="loading" class="mt-10 rounded-card border border-line bg-surface p-10 text-center text-sm text-muted shadow-soft">
        正在打开档案…
      </div>

      <div v-else-if="error" class="mt-10 rounded-card border border-line bg-surface p-10 text-center shadow-soft">
        <p class="text-sm text-danger">{{ error }}</p>
        <button
          class="mt-4 min-h-11 rounded-full border border-line bg-surface-2 px-5 text-sm font-medium text-ink transition-colors hover:bg-line/50"
          @click="load"
        >
          再试一次
        </button>
      </div>

      <div v-else-if="!cards.length" class="mt-10 rounded-card border border-dashed border-line bg-surface/60 p-12 text-center">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sage-soft text-sage-strong">
          <svg viewBox="0 0 24 24" class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 9h18" />
            <path d="M8 13h8" />
          </svg>
        </div>
        <h2 class="mt-4 font-semibold text-ink">档案还是空的</h2>
        <p class="mt-2 text-sm text-muted">在画室生成一幅作品，再把故事卡存进来。</p>
        <NuxtLink
          to="/studio"
          class="mt-5 inline-flex min-h-11 items-center rounded-full bg-sage px-5 text-sm font-medium text-white transition-colors hover:bg-sage-strong"
        >
          去画室
        </NuxtLink>
      </div>

      <div v-else class="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <article
          v-for="card in cards"
          :key="card.id"
          class="overflow-hidden rounded-card border border-line bg-surface shadow-soft"
        >
          <button
            type="button"
            class="block w-full bg-surface-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/40"
            :aria-label="`查看故事卡，${formatDate(card.createdAt)}`"
            @click="preview = card"
          >
            <img
              :src="card.dataUrl"
              :alt="`${card.styleTitle} 风格的故事卡`"
              class="aspect-[10/7] w-full object-cover"
              loading="lazy"
            >
          </button>

          <div class="space-y-3 p-4">
            <div class="flex items-baseline justify-between gap-2">
              <h2 class="font-semibold text-ink">{{ card.styleTitle }}</h2>
              <time class="shrink-0 text-xs text-muted" :datetime="new Date(card.createdAt).toISOString()">
                {{ formatDate(card.createdAt) }}
              </time>
            </div>
            <p v-if="card.caption" class="line-clamp-3 text-sm leading-6 text-muted">
              {{ card.caption }}
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-10 flex-1 rounded-full bg-sage px-4 text-sm font-medium text-white transition-colors hover:bg-sage-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
                @click="download(card)"
              >
                下载
              </button>
              <button
                type="button"
                class="min-h-10 rounded-full border border-line px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
                @click="remove(card)"
              >
                删除
              </button>
            </div>
          </div>
        </article>
      </div>
    </main>

    <!-- 预览浮层：点图片放大，显式下载仍由卡片按钮完成 -->
    <Teleport to="body">
      <div
        v-if="preview"
        class="fixed inset-0 z-[90] flex items-center justify-center bg-ink/60 p-3 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="故事卡预览"
        @click.self="preview = null"
      >
        <div class="max-h-[92dvh] w-full max-w-4xl overflow-auto rounded-[28px] border border-line bg-surface p-3 shadow-2xl">
          <img :src="preview.dataUrl" :alt="`${preview.styleTitle} 风格的故事卡`" class="w-full rounded-[20px]">
          <div class="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
            <p class="text-sm text-muted">
              {{ formatDateTime(preview.createdAt) }} · {{ preview.styleTitle }}
            </p>
            <div class="flex gap-2">
              <button
                class="min-h-10 rounded-full border border-line bg-surface-2 px-4 text-sm text-ink"
                @click="preview = null"
              >
                关闭
              </button>
              <button
                class="min-h-10 rounded-full bg-sage px-4 text-sm font-medium text-white transition-colors hover:bg-sage-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
                @click="download(preview)"
              >
                保存到本地
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import AppHeader from '~/components/AppHeader.vue'
import SensoryToggle from '~/components/SensoryToggle.vue'
import {
  deleteStoryCard,
  downloadStoryCard,
  listStoryCards,
  type ArchivedStoryCard,
} from '~/utils/archive'

const cards = ref<ArchivedStoryCard[]>([])
const loading = ref(true)
const error = ref('')
const preview = ref<ArchivedStoryCard | null>(null)

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    cards.value = await listStoryCards()
  }
  catch (err) {
    console.error('[archive] 读取失败：', err)
    error.value = (err as Error)?.message || '档案没有打开，请再试一次。'
  }
  finally {
    loading.value = false
  }
}

function download(card: ArchivedStoryCard) {
  // 显式点击：保留用户手势，浏览器不会拦截这次下载。
  downloadStoryCard(card)
}

async function remove(card: ArchivedStoryCard) {
  if (!window.confirm('从本机档案里删除这张故事卡？')) return

  try {
    await deleteStoryCard(card.id)
    cards.value = cards.value.filter(item => item.id !== card.id)
    if (preview.value?.id === card.id) preview.value = null
  }
  catch (err) {
    console.error('[archive] 删除失败：', err)
    error.value = '删除没有成功，请再试一次。'
  }
}

onMounted(load)
</script>
