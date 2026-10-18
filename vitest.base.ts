// vitest.base.ts — what EVERY vitest run of this monorepo shares: the test and
// hook timeouts, the environment and the files never to discover.
//
// Each package config is `mergeConfig(baseConfig, defineConfig({ …its own… }))`,
// and a package with no config of its own inherits the root one, which merges
// the same base (vitest takes the nearest `vitest.config.*` going up the tree).
// A per-package config SHADOWS the root completely, which is how apps/cli went
// without any timeout and fell back to vitest's 5 s: the numbers live here,
// once, and the guard in packages/test-kit/src/tests/vitest-base.test.ts fails
// when a config does not merge this file.
//
// WHY 60 s. Most tests are fast (single-digit ms), but turbo runs ~26 package
// suites at once and each vitest spawns its own worker pool: on a shared CI
// runner that oversubscription starves individual tests of CPU, and they blow a
// tight budget while passing in <2 s locally (install.test / actions.test timed
// out at 30 s). Bootstrap tests spin up an embedded database (~10 s under
// load), and tests that spawn real processes (the CLI through tsx: ~0.5 s on a
// free 24-core machine, 4 to 10 s pinned to two contended cores, measured
// 2026-10-18; run 39158880706 went red on its 5 s default). 60 s absorbs the
// starvation without being a hang detector; CI also caps turbo --concurrency.
// A package that measurably needs more says so in its own config (apps/web).
import { defineConfig } from 'vitest/config';

export const TEST_TIMEOUT_MS = 60_000;

/** Never discover tests inside build output or leftover git worktrees
 * (.claude/worktrees/* are stale copies of the tree, not its source). */
export const EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.claude/**',
];

export const baseConfig = defineConfig({
  test: {
    environment: 'node',
    exclude: EXCLUDE,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
