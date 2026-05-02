import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for NodalAI web e2e.
 *
 * Tests assume a local NodalAI stack is already running (web + runner + DB).
 * Bring it up with `nodalai up --dev` or `nodalai up` before `pnpm e2e`.
 * Each test file's beforeAll pings /api/health and skips if the stack is
 * unreachable so a missing server fails loud rather than a stack of opaque
 * timeouts.
 *
 * Override the target URL with PLAYWRIGHT_BASE_URL (e.g. for staging).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
