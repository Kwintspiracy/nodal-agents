import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright config for running a spec against a LOCAL-TRUST stack
 * (e.g. the verify-real-packed-install boot) where the single local user is
 * auto-authenticated — no better-auth login, so no globalSetup / storageState.
 * Used to drive telegram-allowlist.spec.ts against the booted pack.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
