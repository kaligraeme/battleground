import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests drive the built game (`npm run build`). The server runs with frail monsters
 * (--quick) and a one-second countdown so a run moves along quickly.
 */
const PORT = Number(process.env.E2E_PORT ?? 18787);

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `node dist/server.mjs --port ${PORT} --quick --countdown 1`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
