import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Bootstrap tests in apps/runner spin up an embedded pglite DB before
    // their first assertion — that setup alone takes ~10s under parallel
    // turbo runs. The vitest default 5s per-test + hook timeout times out
    // before the DB is ready, producing the only known CI flake. 30s
    // leaves head-room without masking real regressions.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/*.config.*',
        '**/coverage/**',
      ],
    },
  },
});
