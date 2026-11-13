import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  ssr: false,
  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  runtimeConfig: {
    // 【前後端對接點 ①】後端 FastAPI 的位址。
    // 前端所有後端呼叫（/api/v1/acsm/*、/api/v1/tts*）都以此為前綴，
    // 程式裡用 useRuntimeConfig().public.acsmApiBase 取得。
    // 手機走區網測試時，需改成電腦的區網 IP（可用環境變數 NUXT_PUBLIC_ACSM_API_BASE 覆寫）。
    // 後端的 CORS 設為 allow_origins=["*"]，所以瀏覽器（localhost:3000）可直接跨網域呼叫 :8000。
    public: { acsmApiBase: 'http://localhost:8000' }
  }
})
