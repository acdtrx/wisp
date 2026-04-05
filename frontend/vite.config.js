import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        // Long SSE (container/VM create progress) — avoid idle timeout between chunks
        timeout: 0,
        proxyTimeout: 0,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      external: [/^\/vendor\//],
    },
  },
});
