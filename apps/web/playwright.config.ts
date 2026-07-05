import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for Nodal-Agents web e2e.
 *
 * Tests assume a local Nodal-Agents stack is already running (web + runner + DB).
 * Bring it up with `pnpm e2e:up` (wraps `nodal-agents up` — add `-- --dev` for
 * HMR) before `pnpm e2e`. Plain `nodal-agents up`/`nodal-agents up --dev` also
 * work EXCEPT for the OAuth specs below, which need `pnpm e2e:up` specifically.
 *
 * OAuth e2e specs (oauth-flow, notion-oauth, credentials-reuse, airtable-oauth)
 * drive the callback route with a synthetic "mock-" authorization code instead
 * of a real provider round-trip. That bypass is OFF by default (I-9, audit #2)
 * — `pnpm e2e:up` (tests/e2e/up-with-oauth-mock.mjs) sets
 * NODALAI_ALLOW_OAUTH_MOCK=1 for you before spawning `nodal-agents up`, so
 * those specs work with no extra manual step. This flag is NEVER set by a
 * plain `nodal-agents up` — never set it yourself outside e2e.
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
