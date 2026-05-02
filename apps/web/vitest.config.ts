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
