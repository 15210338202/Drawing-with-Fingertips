<template>
  <header class="sticky top-0 z-40 border-b border-line/70 bg-paper/85 backdrop-blur-md">
    <div class="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-3 px-4 sm:px-6">
      <NuxtLink
        to="/"
        class="flex min-h-11 items-center gap-2.5 rounded-xl px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        aria-label="指尖绘迹，回到首页"
      >
        <span class="relative flex h-9 w-9 items-center justify-center rounded-full bg-sage text-sm text-white">
          <svg
            class="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 21c-4.4 0-8-3.6-8-8 0-3.3 2-6.1 4.8-7.3" />
            <path d="M9 21c-2.8-1.2-4.7-4-4.7-7.2 0-1.1.3-2.1.7-3" />
            <path d="M12 16.5c-1.9 0-3.5-1.6-3.5-3.5S10.1 9.5 12 9.5s3.5 1.6 3.5 3.5" />
            <path d="M15.5 21c2.5-1.5 4.3-4.2 4.3-7.2 0-2.2-1-4.2-2.6-5.5" />
            <path d="M18.5 6.5C16.9 4.4 14.6 3 12 3" />
          </svg>
        </span>
        <span class="text-[17px] font-semibold tracking-wide text-ink">指尖绘迹</span>
      </NuxtLink>

      <div class="flex items-center gap-2">
        <slot name="actions">
          <SensoryToggle />
        </slot>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
// 品牌栏只负责导航与全局开关，页面级动作由 actions 插槽注入。
</script>
