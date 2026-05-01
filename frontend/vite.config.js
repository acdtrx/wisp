import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        // Long SSE (container/VM create progress) — avoid idle timeout between chunks
        timeout: 0,
        proxyTimeout: 0,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      external: [/^\/vendor\//],
      output: {
        // Split the eagerly-used UI foundation into a `vendor` chunk so it
        // caches across releases. Heavy lazy-only deps (react-markdown for
        // release notes, @xterm/* for the console) are deliberately left out
        // — Rollup's default behaviour groups them into their dynamic-import
        // parent's chunk, so they only ship when the user actually opens
        // that view. Bundling them into `vendor` would re-merge them into
        // the eager bundle and inflate it past 500 kB.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler|zustand|lucide-react)[\\/]/.test(id)) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
