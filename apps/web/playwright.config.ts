import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for Nodal-Agents web e2e.
 *
 * Tests assume a local Nodal-Agents stack is already running (web + runner + DB).
 * Bring it up with `nodal-agents up --dev` or `nodal-agents up` before `pnpm e2e`.
 *
 * Auth: global-setup creates/logs-in the sentinel user `e2e-playwright@nodalai.local`
 * and saves the session cookie to tests/e2e/.auth/user.json. Every project loads
 * this storageState so no test ever needs to handle /login manually.
 *
 * Override the target URL with PLAYWRIGHT_BASE_URL (e.g. for staging).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000';
const AUTH_STATE = path.join(__dirname, 'tests/e2e/.auth/user.json');

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    storageState: AUTH_STATE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
  ],
});
