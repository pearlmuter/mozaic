import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Mozaic server serves the built UI; in dev, Vite proxies API calls to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      '/api': { target: 'http://127.0.0.1:47811', ws: true },
    },
  },
})
