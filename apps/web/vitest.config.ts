import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Playwright specs live in tests/e2e/*.spec.ts and tests/manual/*.spec.ts
    // and use @playwright/test, which isn't compatible with the vitest runner.
    // Exclude them so `pnpm test` only runs unit tests; `pnpm e2e` runs the
    // Playwright suite separately.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/manual/**'],
    // Default 5000ms is too tight: the FIRST test in actions.test.ts pays the
    // full module init of the (large, ~5k-line) actions.ts via dynamic import —
    // server-only mock, env parse, vi.mock chains — and times out under turbo
    // concurrent load on slower runners (CI Ubuntu, 2 vCPU). History: 15s →
    // 30s (run #25803978814) → 60s, after the parallel-agent UI merge grew
    // actions.ts and it crept past 30s again → 120s here (2026-07-17), after
    // the 0.8 office/outlook suites (real file I/O, zip work in tools + 127
    // adapter tests) raised turbo-concurrent load enough that 10 DB-backed
    // tests paying the actions.ts import crossed 60s while green standalone.
    // It's a load cost, not a hang — give real head-room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
