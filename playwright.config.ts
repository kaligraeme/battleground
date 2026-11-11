import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the built app (`npm run build`) in a real browser.
 * The server runs with a throwaway data directory and speed 0, so deployments finish at once.
 */
const PORT = Number(process.env.E2E_PORT ?? 18080);
export const E2E_ADMIN_PASSWORD = 'e2e-password-123';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `node -e "require('node:fs').rmSync('.e2e-data',{recursive:true,force:true})" && node dist/battleground.mjs --port ${PORT} --data .e2e-data --speed 0`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    env: { BATTLEGROUND_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
