import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy handler: reads X-PMS-Cookie header from the browser request
// and forwards it as Cookie to the upstream PMS API
function onProxyReq(proxyReq, req) {
  const pmsCookie = req.headers['x-pms-cookie']
  if (pmsCookie) {
    proxyReq.setHeader('Cookie', pmsCookie)
  }
  // Remove the custom header so it doesn't reach upstream
  proxyReq.removeHeader('x-pms-cookie')
  // Set Referer to the target domain to avoid CSRF rejection
  proxyReq.setHeader('Referer', 'https://pms-va.tiktok-row.net/')
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://pms-va.tiktok-row.net',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => { proxy.on('proxyReq', onProxyReq) },
      },
      '/gateway': {
        target: 'https://pms-va.tiktok-row.net',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => { proxy.on('proxyReq', onProxyReq) },
      },
    },
  },
})
