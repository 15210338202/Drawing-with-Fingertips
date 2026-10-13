<template>
  <div class="border rounded p-4 bg-white flex gap-2">
    <button
      class="px-3 py-1 bg-blue-500 text-white rounded"
      @click="emit('clear')"
    >
      清空
    </button>

    <!-- 撤销：占位按钮，等后续实现历史记录栈 -->
    <button
      class="px-3 py-1 bg-blue-500 text-white rounded opacity-50 cursor-not-allowed"
      disabled
      title="撤销功能后续实现"
    >
      撤销
    </button>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{ clear: [] }>()
</script>
