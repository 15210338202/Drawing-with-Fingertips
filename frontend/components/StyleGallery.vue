<template>
  <div class="border rounded p-4 bg-white w-[360px]">
    <h2 class="font-semibold">风格库</h2>

    <p v-if="!store.styleResults.length" class="mt-2 text-sm text-gray-400">
      风格清单加载中…也可以直接跟 AI 说「把它变成国风」
    </p>

    <div v-else class="mt-2 max-h-56 space-y-2 overflow-y-auto">
      <button
        v-for="item in store.styleResults"
        :key="item.id"
        class="w-full rounded border p-2 text-left text-xs transition hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
        :disabled="busy"
        @click="pick(item)"
      >
        <div class="flex justify-between gap-2">
          <span class="font-semibold text-gray-800">{{ item.title }}</span>
          <span class="font-mono text-gray-400">{{ item.score.toFixed(2) }}</span>
        </div>

        <p class="mt-1 line-clamp-2 text-gray-500">{{ item.prompt }}</p>

        <p class="mt-1 text-gray-400">来源：{{ item.source }}</p>
      </button>
    </div>

    <p v-if="store.executing" class="mt-2 text-xs text-amber-600">正在生成，稍等…</p>
  </div>
</template>

<script setup lang="ts">
const store = useAgentStore()
const { runAction } = useAgent()

const busy = computed(() => store.loading || store.streaming || store.executing)

/**
 * P2-11 之后 Agent 不再调 search_style（风格由模型直接从 prompt 里的清单选），
 * 所以画廊得自己把清单拉回来：空 query = 浏览模式，返回全部风格（score 0）。
 */
async function loadCatalog() {
  if (store.styleResults.length) return

  try {
    const res = await $fetch<{ results: StyleResult[] }>('/api/search-style', {
      method: 'POST',
      body: { query: '' },
      timeout: 10000,
    })
    store.setStyleResults(res.results ?? [])
  }
  catch (err) {
    // 加载失败不影响画画，只是画廊空着；控制台能看到原因
    console.warn('[styles] 画廊清单加载失败：', err)
  }
}

onMounted(loadCatalog)

/**
 * 点卡片 = 用这条风格的 prompt 生成。
 * 直接把 prompt 作为 promptOverride 传过去，比让模型再猜一次 styleKey 靠谱。
 */
async function pick(item: StyleResult) {
  if (busy.value) return

  await runAction({
    tool: 'generate_image',
    args: {
      styleKey: item.id,
      promptOverride: item.styleModifiers,
      strength: 0.6,
    },
  })
}
</script>
