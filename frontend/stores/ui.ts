import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局浮层状态：设置抽屉和作品结果 Sheet。
 * 只放“打开/关闭”和共享的结果图，不放业务函数。
 */
export type GestureNoticeTone = 'info' | 'success' | 'warn' | 'error'

export const useUIStore = defineStore('ui', () => {
  const isSettingsOpen = ref(false)
  const isResultOpen = ref(false)
  const resultImage = ref('')
  const resultError = ref('')
  const resultSaving = ref(false)
  const toastMessage = ref('')
  const archiveFlash = ref(false)
  const gestureNotice = ref('')
  const gestureNoticeTone = ref<GestureNoticeTone>('info')

  let resultClearTimer: ReturnType<typeof setTimeout> | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let archiveFlashTimer: ReturnType<typeof setTimeout> | null = null
  let gestureNoticeTimer: ReturnType<typeof setTimeout> | null = null

  function clearResultTimer() {
    if (resultClearTimer) {
      clearTimeout(resultClearTimer)
      resultClearTimer = null
    }
  }

  /** 轻提示：已存入档案、保存失败等；自动消失，不抢操作 */
  function showToast(message: string, duration = 2600) {
    if (toastTimer) clearTimeout(toastTimer)
    toastMessage.value = message
    toastTimer = setTimeout(() => {
      toastMessage.value = ''
      toastTimer = null
    }, duration)
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    toastMessage.value = ''
  }

  /** 让顶栏「档案」入口闪一下，告诉用户东西存哪了 */
  function flashArchive(duration = 1400) {
    if (archiveFlashTimer) clearTimeout(archiveFlashTimer)
    archiveFlash.value = true
    archiveFlashTimer = setTimeout(() => {
      archiveFlash.value = false
      archiveFlashTimer = null
    }, duration)
  }

  /**
   * 手势/生成反馈统一放到页面顶部中央，避免贴在摄像头预览里被裁掉。
   * duration=0 表示保持到下一次提示（生成中这类状态用）。
   */
  function showGestureNotice(
    message: string,
    tone: GestureNoticeTone = 'info',
    duration = 4500,
  ) {
    if (gestureNoticeTimer) clearTimeout(gestureNoticeTimer)
    gestureNoticeTimer = null

    gestureNotice.value = message.length > 220 ? `${message.slice(0, 220)}…` : message
    gestureNoticeTone.value = tone

    if (duration > 0) {
      gestureNoticeTimer = setTimeout(() => {
        gestureNotice.value = ''
        gestureNoticeTimer = null
      }, duration)
    }
  }

  function hideGestureNotice() {
    if (gestureNoticeTimer) {
      clearTimeout(gestureNoticeTimer)
      gestureNoticeTimer = null
    }
    gestureNotice.value = ''
  }

  function openSettings() {
    isResultOpen.value = false
    clearResultTimer()
    isSettingsOpen.value = true
  }

  function closeSettings() {
    isSettingsOpen.value = false
  }

  function openResult(imageBase64: string) {
    if (!imageBase64) return

    isSettingsOpen.value = false
    clearResultTimer()
    resultImage.value = imageBase64
    resultError.value = ''
    resultSaving.value = false
    isResultOpen.value = true
  }

  function setResultSaving(value: boolean) {
    resultSaving.value = value
  }

  function setResultError(message: string) {
    resultError.value = message
  }

  function closeResult() {
    isResultOpen.value = false
    resultError.value = ''
    resultSaving.value = false
    clearResultTimer()

    // 等收起动画结束后再清图，避免 Sheet 下落时图片先消失。
    resultClearTimer = setTimeout(() => {
      resultImage.value = ''
      resultClearTimer = null
    }, 350)
  }

  return {
    isSettingsOpen,
    isResultOpen,
    resultImage,
    resultError,
    resultSaving,
    toastMessage,
    archiveFlash,
    gestureNotice,
    gestureNoticeTone,
    openSettings,
    closeSettings,
    openResult,
    setResultError,
    setResultSaving,
    closeResult,
    showToast,
    hideToast,
    flashArchive,
    showGestureNotice,
    hideGestureNotice,
  }
})
