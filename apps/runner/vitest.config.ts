import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/tests/setup-workspaces-root.ts'],
    // This per-package config SHADOWS the root vitest.config.ts entirely —
    // the root's generous timeouts must be replicated here or runner tests
    // fall back to the 5s default and flake on oversubscribed CI runners
    // (see the root config's comment; observed on install.test.ts, CI run
    // 29939729072: 100MB-buffer zip-guard tests + pglite spin-up > 5s).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
