<template>
  <div class="border rounded p-4 bg-white space-y-3">
    <div class="flex gap-2">
      <button
        class="rounded-lg bg-sage px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sage-strong"
        @click="emit('clear')"
      >
        清空
      </button>

      <!-- 撤销：占位按钮，等后续实现历史记录栈 -->
      <button
        class="cursor-not-allowed rounded-lg bg-sage/50 px-3 py-1.5 text-sm font-medium text-white"
        disabled
        title="撤销功能后续实现"
      >
        撤销
      </button>
    </div>

    <!-- 【调试面板】捏�?握拳判定的参数，现场对着手边调边看；调好后把默认值写�?stores/gesture.ts -->
    <div class="space-y-2 border-t pt-3">
      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>捏合进入阈值（2D�?/span>
          <span class="font-mono">{{ store.pinchEnter.toFixed(2) }}</span>
        </span>
        <input
          type="range"
          min="0.05"
          max="3"
          step="0.01"
          class="w-full"
          :value="store.pinchEnter"
          @input="store.setPinchEnter(toNumber($event))"
        />
      </label>

      <label class="block text-xs text-gray-600">
        <span class="flex justify-between">
          <span>捏合退出阈值（2D�?/span>
          <span class="font-mono">{{ store.pinchExit.toFixed(2) }}</span>
        </span>
        <input
          type="range"
          min="0.05"
          max="3"
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
          <span>握拳阈值（四指�?/span>
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

    <!-- 实时读数：调参的唯一依据 —�?先看实际算出来多少，再决定滑杆往哪边�?-->
    <div class="border-t pt-2 font-mono text-[11px] leading-5 text-gray-500">
      <div>
        捏合
        <span :class="store.debugPinchRatio < store.pinchEnter ? 'text-sage' : 'text-gray-800'">
          {{ store.debugPinchRatio.toFixed(3) }}
        </span>
        <span class="text-gray-400">
          [2D]
          （进�?{{ store.pinchEnter.toFixed(2) }} / 退�?{{ store.pinchExit.toFixed(2) }}�?
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>指尖 {{ formatDistance(store.debugPinchTip) }}</span>
        <span>/ 等效掌尺 {{ formatDistance(store.debugPinchPalm) }}</span>
        <span class="text-gray-400">· world {{ store.debugPinchWorldCount }}</span>
        <button
          class="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] hover:bg-gray-50"
          @click="store.capturePinchEnter?.()"
        >
          捏合时记进入
        </button>
        <button
          class="rounded border border-gray-300 px-1.5 py-0.5 text-[10px] hover:bg-gray-50"
          @click="store.capturePinchExit?.()"
        >
          张开时记退�?
        </button>
      </div>

      <div>
        握拳 四指
        <span :class="store.debugFingerRatio < store.fistThreshold ? 'text-sage' : 'text-gray-800'">
          {{ store.debugFingerRatio.toFixed(3) }}
        </span>
        拇指 {{ store.debugThumbRatio.toFixed(3) }}
        <span class="text-gray-400">（阈�?{{ store.fistThreshold.toFixed(2) }}�?/span>
      </div>

      <div>
        清空已触�?
        <span :class="store.clearRequested > 0 ? 'text-sage' : 'text-gray-800'">{{ store.clearRequested }}</span>
        �?
        <span class="text-gray-400">（握拳不动说明手势没判定成功，动了但画布没清才是画布的问题）</span>
      </div>

      <div class="text-gray-400">
        读数 = 2D 指尖向量按掌�?掌宽两个方向归一化；先捏合记进入，再张开记退出�?
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const store = useGestureStore()

const emit = defineEmits<{ clear: [] }>()

/**
 * input[type=range] �?value 永远是字符串�?
 * 直接塞进 store 会让后面所有比较都变成字符串参与运算，必须转数字�?
 */
function toNumber(event: Event) {
  return Number((event.target as HTMLInputElement).value)
}

/** 2D 距离是归一化值，直接显示三位小数 */
function formatDistance(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '�?
  return value.toFixed(3)
}
</script>
