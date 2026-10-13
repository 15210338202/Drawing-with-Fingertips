<template>
  <div class="min-h-screen bg-gray-100 p-4">
    <h1 class="text-2xl font-bold mb-4">指尖绘迹</h1>

    <!-- 上半部分：摄像头 + 画布 -->
    <div class="grid grid-cols-2 gap-4">
      <CameraPreview />
      <DrawingCanvas />
    </div>

    <!-- 下半部分：工具栏 + Agent 面板 + 风格库 -->
    <div class="mt-4 flex gap-4">
      <Toolbar />
      <AgentPanel />
      <StyleGallery />
    </div>
  </div>
</template>