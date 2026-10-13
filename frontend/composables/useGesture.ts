export function useGesture() {
  // 后续实现捏合/张开/握拳状态机
  const state = ref<'idle' | 'drawing'>('idle')
  return { state }
}