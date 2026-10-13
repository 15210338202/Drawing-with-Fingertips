export function useHandTracking() {
  // 后续实现 MediaPipe 手部关键点识别
  const landmarks = ref(null)
  const start = () => {}
  const stop = () => {}

  return { landmarks, start, stop }
}