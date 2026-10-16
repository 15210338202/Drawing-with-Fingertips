<template>
  <div class="border rounded p-4 bg-white flex w-[360px] flex-col gap-2">
    <h2 class="font-semibold">AI 助手</h2>

    <!-- 消息列表：固定高度 + 可滚动，不撑破布局 -->
    <div class="h-48 space-y-2 overflow-y-auto text-sm">
      <p v-if="!store.messages.length" class="text-gray-400">
        说点什么，比如「把它变成国风」「线条粗一点」
      </p>

      <div
        v-for="(message, index) in store.messages"
        :key="index"
        :class="message.role === 'user' ? 'text-right' : 'text-left'"
      >
        <span
          class="inline-block max-w-[85%] whitespace-pre-wrap rounded px-2 py-1 text-left"
          :class="message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-800'"
        >
          {{ message.content }}
        </span>
      </div>
    </div>

    <!-- 思考可视化：AI 的判断依据，可滚动 -->
    <div
      v-if="store.reasoning.length"
      class="max-h-24 overflow-y-auto rounded bg-amber-50 p-2 text-xs text-amber-800"
    >
      <p class="font-semibold">AI 的判断依据</p>
      <ul class="list-disc pl-4">
        <li v-for="(item, index) in store.reasoning" :key="index">{{ item }}</li>
      </ul>
    </div>

    <p v-if="store.fallback" class="text-xs text-amber-600">
      上游不可用，这条是本地模板回复。
    </p>

    <div class="flex gap-2">
      <input
        v-model="input"
        :disabled="store.loading"
        class="min-w-0 flex-1 rounded border px-2 py-1 disabled:bg-gray-100"
        placeholder="说点什么..."
        @keyup.enter="submit"
      />
      <button
        class="rounded bg-green-500 px-3 py-1 text-white disabled:opacity-50"
        :disabled="store.loading || !input.trim()"
        @click="submit"
      >
        {{ store.loading ? '思考中...' : '发送' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const store = useAgentStore()
const { send } = useAgent()

const input = ref('')

async function submit() {
  const text = input.value.trim()
  // loading 时直接返回，避免重复提交
  if (!text || store.loading) return

  // 先清空输入框：等 await 回来再清会让用户以为没发出去、又点一次
  input.value = ''
  await send(text)
}
</script>
