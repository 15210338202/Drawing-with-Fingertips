<template>
  <aside class="flex min-h-[25.875rem] flex-col rounded-card border border-line bg-surface shadow-soft lg:sticky lg:top-20">
    <div
      class="flex gap-1 border-b border-line/80 p-2"
      role="tablist"
      aria-label="小绘面板"
    >
      <button
        id="assistant-tab-chat"
        type="button"
        role="tab"
        :aria-selected="tab === 'chat'"
        aria-controls="assistant-panel-chat"
        class="min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        :class="tab === 'chat' ? 'bg-sage-soft text-sage' : 'text-muted hover:bg-surface-2/70 hover:text-ink'"
        @click="tab = 'chat'"
      >
        小绘
      </button>
      <button
        id="assistant-tab-styles"
        type="button"
        role="tab"
        :aria-selected="tab === 'styles'"
        aria-controls="assistant-panel-styles"
        class="min-h-10 flex-1 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
        :class="tab === 'styles' ? 'bg-sage-soft text-sage' : 'text-muted hover:bg-surface-2/70 hover:text-ink'"
        @click="tab = 'styles'"
      >
        风格
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <div
        v-show="tab === 'chat'"
        id="assistant-panel-chat"
        role="tabpanel"
        aria-labelledby="assistant-tab-chat"
      >
        <AgentPanel embedded />
      </div>
      <div
        v-show="tab === 'styles'"
        id="assistant-panel-styles"
        role="tabpanel"
        aria-labelledby="assistant-tab-styles"
      >
        <StyleGallery embedded />
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import AgentPanel from '~/components/AgentPanel.vue'
import StyleGallery from '~/components/StyleGallery.vue'

const tab = ref<'chat' | 'styles'>('chat')
</script>
