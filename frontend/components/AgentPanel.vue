<template>
  <div class="border rounded p-4 bg-white flex w-[360px] flex-col gap-2">
    <h2 class="font-semibold">AI 助手</h2>

    <!-- 消息列表：固定高度 + 可滚动，新内容进来自动滚到底 -->
    <div ref="listEl" class="h-48 space-y-2 overflow-y-auto text-sm">
      <p v-if="!store.messages.length" class="text-gray-400">
        说点什么，比如「这个草图适合什么风格」
      </p>

      <div
        v-for="(message, index) in store.messages"
        :key="index"
        :class="message.role === 'user' ? 'text-right' : 'text-left'"
      >
        <span
          class="inline-block max-w-[85%] whitespace-pre-wrap rounded px-2 py-1 text-left"
          :class="message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-800'"
        >{{ message.content }}</span>
        <!-- 流式回答刚开始、还没吐出字时给个光标，让用户知道在生成 -->
        <span
          v-if="store.streaming && index === store.messages.length - 1 && !message.content"
          class="ml-1 animate-pulse text-gray-400"
        >▍</span>
      </div>
    </div>

    <!-- 思考可视化：/api/agent 返回的判断依据，可滚动 -->
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

    <input
      v-model="input"
      :disabled="store.loading"
      class="w-full rounded border px-2 py-1 disabled:bg-gray-100"
      placeholder="说点什么，比如「把它变成国风」"
      @keyup.enter="submitSend"
    />

    <div class="flex gap-2">
      <!-- 主入口：走 /api/agent，解析意图并串行执行动作（改颜色 / 检索风格 / 生成图片） -->
      <button
        class="rounded bg-green-500 px-3 py-1 text-white disabled:opacity-50"
        :disabled="busy || !input.trim()"
        title="解析意图并执行动作：改颜色、检索风格、生成图片"
        @click="submitSend"
      >
        {{ store.executing ? '执行中...' : store.loading ? '解析中...' : '发送' }}
      </button>

      <!-- 次入口：走 /api/chat，只聊天，不执行任何动作 -->
      <button
        class="rounded border border-gray-300 px-3 py-1 text-gray-700 disabled:opacity-50"
        :disabled="busy || !input.trim()"
        title="只聊天，边生成边显示，不会改动画布"
        @click="submitStream"
      >
        {{ store.streaming ? '生成中...' : '流式对话' }}
      </button>

      <!-- 只有正在流式接收时才出现 -->
      <button
        v-if="store.streaming"
        class="rounded bg-red-500 px-3 py-1 text-white"
        @click="stop"
      >
        停止
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const store = useAgentStore()
const { send, chatStream, stop } = useAgent()

const input = ref('')
/** 消息列表容器，用来控制自动滚动 */
const listEl = ref<HTMLDivElement | null>(null)

/** 三种状态都不能并发提交：等模型 / 收流 / 执行动作 */
const busy = computed(() => store.loading || store.streaming || store.executing)

/**
 * 主入口：走 send（/api/agent）。
 * 它会一次性拿到 reply + actions，然后串行执行动作 ——
 * 改颜色、检索风格、生成图片都在这条路上，点「发送」和回车都走这里。
 */
async function submitSend() {
  const text = input.value.trim()
  if (!text || busy.value) return

  // 先清空输入框：等 await 回来再清，用户会以为没发出去、又点一次
  input.value = ''
  await send(text)
}

/** 次入口：走 chatStream（/api/chat），只聊天、不执行动作 */
async function submitStream() {
  const text = input.value.trim()
  if (!text || busy.value) return

  input.value = ''
  await chatStream(text)
}

// 消息一多、或者流式内容变长，就滚到底部
watch(
  () => store.messages,
  () => {
    nextTick(() => {
      const el = listEl.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
  { deep: true },
)
</script>
