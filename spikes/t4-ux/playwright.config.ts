import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.T4_PORT ?? 4317)
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.T4_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: {
    command: process.env.T4_PROD ? `node scripts/serve-prod.mjs ${PORT}` : `pnpm exec vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
