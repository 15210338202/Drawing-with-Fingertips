<script setup lang="ts">
import { useAppStore } from '~/stores/app'

const appStore = useAppStore()

/**
 * 等 hydration 完成后再读 localStorage。
 * 不能在 state 初始化/插件挂载前读：SSR 输出的是关闭态，客户端如果一上来就是开启态，
 * 根节点的 class 会和 SSR 对不上，Vue hydration 可能保留旧 class。
 */
onMounted(() => {
  appStore.initSensoryMode()
})
</script>

<template>
  <div
    class="min-h-screen"
    :class="{ 'sensory-friendly': appStore.isSensoryFriendly }"
  >
    <NuxtPage />
  </div>
</template>
