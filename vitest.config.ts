import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Never discover tests inside build output or leftover git worktrees
    // (.claude/worktrees/* are stale copies of the tree, not its source) — a
    // root-level `vitest <path>` glob would otherwise match those duplicates.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**', '**/.claude/**'],
    // Bootstrap tests in apps/runner spin up an embedded pglite DB before
    // their first assertion — that setup alone takes ~10s under parallel
    // turbo runs. The vitest default 5s per-test + hook timeout times out
    // before the DB is ready, producing the only known CI flake. 30s
    // leaves head-room without masking real regressions.
    // Generous timeouts: the tests themselves are fast (often single-digit ms),
    // but turbo runs all ~26 package test suites concurrently and each vitest
    // spawns its own worker pool — on a shared CI runner that oversubscription
    // starves individual tests of CPU and they blow a tight per-test budget
    // (observed: install.test / actions.test timing out at 30s while passing in
    // <2s locally). 60s absorbs the starvation; CI also caps turbo --concurrency.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
