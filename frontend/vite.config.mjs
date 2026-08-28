import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: process.env.GATEWAY_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // All /api requests forwarded to backend during development
      '/api': { target: 'http://localhost:3001', changeOrigin: true }
    }
  }
});
