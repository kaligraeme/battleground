import { defineConfig } from 'vite';

// The browser client. In development the Vite server proxies the game socket to the Node server.
export default defineConfig({
  root: 'src/client',
  publicDir: false,
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
} as never);
