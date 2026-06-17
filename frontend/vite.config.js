import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // All /api requests forwarded to backend during development
      '/api': { target: 'http://localhost:3001', changeOrigin: true }
    }
  }
});
