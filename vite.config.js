import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'https://pms-va.tiktok-row.net', changeOrigin: true },
      '/gateway': { target: 'https://pms-va.tiktok-row.net', changeOrigin: true },
    },
  },
})
