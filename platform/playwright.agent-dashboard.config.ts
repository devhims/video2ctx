import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e', testMatch: 'agent-sessions.spec.ts', workers: 1,
  timeout: 45_000, expect: { timeout: 10_000 }, reporter: 'line',
  outputDir: '../.scratch/agent-sessions-dashboard/playwright-results',
  use: { baseURL: 'http://127.0.0.1:3021', trace: 'retain-on-failure', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'node test/fixtures/agent-dashboard-server.mjs', cwd: import.meta.dirname, url: 'http://127.0.0.1:8797/health', reuseExistingServer: false },
    { command: 'npm run start -- --hostname 127.0.0.1 --port 3021', cwd: '../web', env: { PLATFORM_API_BASE_URL: 'http://127.0.0.1:8797' }, url: 'http://127.0.0.1:3021/dashboard', reuseExistingServer: false, timeout: 60_000 },
  ],
});
