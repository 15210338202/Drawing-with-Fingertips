import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局浮层状态：设置抽屉和作品结果 Sheet。
 * 只放“打开/关闭”和共享的结果图，不放业务函数。
 */
export const useUIStore = defineStore('ui', () => {
  const isSettingsOpen = ref(false)
  const isResultOpen = ref(false)
  const resultImage = ref('')
  const resultError = ref('')
  const resultSaving = ref(false)

  let resultClearTimer: ReturnType<typeof setTimeout> | null = null

  function clearResultTimer() {
    if (resultClearTimer) {
      clearTimeout(resultClearTimer)
      resultClearTimer = null
    }
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
    openSettings,
    closeSettings,
    openResult,
    setResultError,
    setResultSaving,
    closeResult,
  }
})
