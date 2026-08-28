import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GATEWAY_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5172,
    strictPort: true, // Fail if port is taken so there's no ambiguity
  },
})
