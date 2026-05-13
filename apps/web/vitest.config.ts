import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Playwright e2e specs live in tests/e2e/*.spec.ts and use
    // @playwright/test, which isn't compatible with the vitest runner.
    // Exclude them so `pnpm test` only runs unit tests; `pnpm e2e`
    // runs the Playwright suite separately.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    // Default 5000ms is too tight: the first test in actions.test.ts triggers
    // full module init (server-only mock, env parse, vi.mock chains) and times
    // out under turbo concurrent load on slower runners (CI Ubuntu, 2 vCPU).
    // 15s was set initially; bumped to 30s after CI run #25803978814 still
    // timed out on `rejects slug with uppercase letters` under GHA load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
