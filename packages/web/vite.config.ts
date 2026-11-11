import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API server the dev server proxies to (run `npm run dev:server`).
const API_TARGET = process.env.BATTLEGROUND_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  // Relative asset URLs so the UI can be mounted under any path prefix.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
});
