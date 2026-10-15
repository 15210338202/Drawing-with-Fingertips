<template>
  <div class="border rounded p-4 bg-white space-y-3">
    <div class="flex gap-2">
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

    <!-- 【调试面板】捏合/握拳判定的参数，现场对着手边调边看；调好后把默认值写回 stores/gesture.ts -->
    <div class="space-y-2 border-t pt-3">
      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>捏合进入阈值</span>
          <span class="font-mono">{{ store.pinchEnter.toFixed(2) }}</span>
        </span>
        <input
          type="range"
          min="0.2"
          max="0.5"
          step="0.01"
          class="w-full"
          :value="store.pinchEnter"
          @input="store.setPinchEnter(toNumber($event))"
        />
      </label>

      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>捏合退出阈值</span>
          <span class="font-mono">{{ store.pinchExit.toFixed(2) }}</span>
        </span>
        <input
          type="range"
          min="0.3"
          max="0.6"
          step="0.01"
          class="w-full"
          :value="store.pinchExit"
          @input="store.setPinchExit(toNumber($event))"
        />
      </label>

      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>连续确认帧数</span>
          <span class="font-mono">{{ store.confirmFrames }}</span>
        </span>
        <input
          type="range"
          min="1"
          max="5"
          step="1"
          class="w-full"
          :value="store.confirmFrames"
          @input="store.setConfirmFrames(toNumber($event))"
        />
      </label>

      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>握拳阈值（四指）</span>
          <span class="font-mono">{{ store.fistThreshold.toFixed(2) }}</span>
        </span>
        <input
          type="range"
          min="0.4"
          max="1.2"
          step="0.05"
          class="w-full"
          :value="store.fistThreshold"
          @input="store.setFistThreshold(toNumber($event))"
        />
      </label>
    </div>

    <!-- 实时读数：调参的唯一依据 —— 先看实际算出来多少，再决定滑杆往哪边拉 -->
    <div class="border-t pt-2 font-mono text-[11px] leading-5 text-gray-500">
      <div>
        捏合
        <span :class="store.debugPinchRatio < store.pinchEnter ? 'text-blue-600' : 'text-gray-800'">
          {{ store.debugPinchRatio.toFixed(3) }}
        </span>
        <span class="text-gray-400">（进入 {{ store.pinchEnter.toFixed(2) }} / 退出 {{ store.pinchExit.toFixed(2) }}）</span>
      </div>

      <div>
        握拳 四指
        <span :class="store.debugFingerRatio < store.fistThreshold ? 'text-blue-600' : 'text-gray-800'">
          {{ store.debugFingerRatio.toFixed(3) }}
        </span>
        拇指 {{ store.debugThumbRatio.toFixed(3) }}
        <span class="text-gray-400">（阈值 {{ store.fistThreshold.toFixed(2) }}）</span>
      </div>

      <div>
        清空已触发
        <span :class="store.clearRequested > 0 ? 'text-blue-600' : 'text-gray-800'">{{ store.clearRequested }}</span>
        次
        <span class="text-gray-400">（握拳不动说明手势没判定成功，动了但画布没清才是画布的问题）</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const store = useGestureStore()

const emit = defineEmits<{ clear: [] }>()

/**
 * input[type=range] 的 value 永远是字符串。
 * 直接塞进 store 会让后面所有比较都变成字符串参与运算，必须转数字。
 */
function toNumber(event: Event) {
  return Number((event.target as HTMLInputElement).value)
}
</script>
