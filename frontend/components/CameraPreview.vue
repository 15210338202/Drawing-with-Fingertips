<template>
  <div class="border rounded p-4 bg-white">
    <h2 class="font-semibold">摄像头预览区</h2>

    <!-- 预览区域：固定 4:3，摄像头未开启时显示占位/错误文字 -->
    <div class="relative mt-2 w-[640px] max-w-full aspect-[4/3] bg-gray-200 flex items-center justify-center overflow-hidden rounded">
      <video
        ref="videoEl"
        width="640"
        height="480"
        autoplay
        playsinline
        muted
        class="w-full h-full object-contain bg-black"
      />

      <p
        v-if="errorMessage"
        class="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-red-600 bg-gray-200"
      >
        {{ errorMessage }}
      </p>
    </div>

    <div class="mt-2 flex gap-2">
      <button
        v-if="!isActive"
        class="px-3 py-1 bg-blue-500 text-white rounded disabled:opacity-50"
        :disabled="isStarting"
        @click="startCamera"
      >
        {{ isStarting ? '开启中…' : '开启摄像头' }}
      </button>
      <button
        v-else
        class="px-3 py-1 bg-red-500 text-white rounded"
        @click="stopCamera"
      >
        关闭摄像头
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** <video> 元素，MediaStream 挂到它的 srcObject 上 */
const videoEl = ref<HTMLVideoElement | null>(null)
/** 当前正在使用的媒体流，关闭时要逐条 stop 掉轨道 */
const stream = ref<MediaStream | null>(null)
const isActive = ref(false)
const isStarting = ref(false)
const errorMessage = ref('')

/** 打开摄像头：640×480 前置，不采集音频（分辨率不要调高，否则后续 MediaPipe 推理会慢） */
async function startCamera() {
  if (isStarting.value || isActive.value) return

  errorMessage.value = ''
  isStarting.value = true

  // file:// 或非安全上下文下 navigator.mediaDevices 直接不存在
  if (!navigator.mediaDevices?.getUserMedia) {
    errorMessage.value = '当前环境不支持摄像头采集，请用 http://localhost 或 https:// 打开页面'
    isStarting.value = false
    return
  }

  try {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    })

    stream.value = mediaStream

    if (videoEl.value) {
      videoEl.value.srcObject = mediaStream
      // 自动播放策略或权限边界可能让 play() 失败，这里不阻断：autoplay 属性会兜底
      await videoEl.value.play().catch(() => {})
    }

    isActive.value = true
  } catch (err) {
    releaseStream()
    errorMessage.value = describeCameraError(err)
  } finally {
    isStarting.value = false
  }
}

/** 关闭摄像头：释放设备，并清掉上一次的错误提示 */
function stopCamera() {
  releaseStream()
  errorMessage.value = ''
}

/**
 * 只释放设备资源，不碰错误提示。
 * 开启失败时必须走这里，否则刚写好的错误文字会被立刻清掉。
 * 它不接受任何参数，所以模板里能直接写 @click="stopCamera"，
 * 不会像带可选参数的函数那样和 PointerEvent 撞类型（TS2345）。
 */
function releaseStream() {
  stream.value?.getTracks().forEach(track => track.stop())
  stream.value = null

  if (videoEl.value) {
    videoEl.value.srcObject = null
  }

  isActive.value = false
}

/** 把 getUserMedia 的异常翻译成用户能看懂的中文提示 */
function describeCameraError(err: unknown): string {
  const name = (err as DOMException | undefined)?.name

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝，请在浏览器地址栏允许本页面使用摄像头后重试'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到可用的摄像头设备'
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他程序占用，无法读取'
    case 'OverconstrainedError':
      return '摄像头不支持 640×480 分辨率'
    case 'SecurityError':
      return '当前页面不是安全上下文，摄像头被浏览器禁用'
    default:
      return `摄像头开启失败：${(err as Error | undefined)?.message ?? String(err)}`
  }
}

// 切页面/组件卸载时一定要关流，否则摄像头指示灯会一直亮着
onBeforeUnmount(() => {
  stopCamera()
})

// 暴露给父组件（第 4 天接 MediaPipe 时可以直接拿 videoEl）
defineExpose({ videoEl, stream, isActive, startCamera, stopCamera })
</script>
