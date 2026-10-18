<template>
  <div class="border rounded p-4 bg-white w-[360px]">
    <h2 class="font-semibold">风格库</h2>

    <p v-if="!store.styleResults.length" class="mt-2 text-sm text-gray-400">
      暂无检索结果 —— 跟 AI 说一句「把它变成国风」试试
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
