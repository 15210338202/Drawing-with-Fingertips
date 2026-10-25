// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: '指尖绘迹',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'description', content: '用手势把心里的画面画出来，一个安静、低刺激的创作空间。' },
        { name: 'theme-color', content: '#f6f1e7' },
      ],
    },
    pageTransition: { name: 'page', mode: 'out-in' },
  },
  experimental: {
    appManifest: false
  },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()]
  },
  modules: ['@pinia/nuxt'],
  nitro: {
    preset: 'cloudflare-pages',
    prerender: { autoSubfolderIndex: false }, // 避免 Cloudflare 路由匹配问题
  },
})