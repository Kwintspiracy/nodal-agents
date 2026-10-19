// vitest.base.ts — what EVERY vitest run of this monorepo shares: the test and
// hook timeouts, the environment and the files never to discover.
//
// Each package has its OWN config, `mergeConfig(baseConfig, defineConfig({ …its
// own… }))`, even when it has nothing of its own: nothing relies on vitest
// looking in a parent directory. A per-package config SHADOWS any other, which
// is how apps/cli went without any timeout and fell back to vitest's 5 s: the
// numbers live here, once, and the guard in
// packages/test-kit/src/tests/vitest-base.test.ts fails when a package has no
// config or its config does not merge this file FIRST.
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
import { fileURLToPath } from 'node:url';
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

/**
 * Every package's tests build each agent's run folders under a synthetic entity
 * id (since #506); this setup keeps that off the real home directory. Packages
 * list it in their own `setupFiles`.
 */
export const WORKSPACES_ROOT_SETUP = fileURLToPath(
  new URL('./packages/test-kit/src/setup-workspaces-root.ts', import.meta.url),
);

export const baseConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: EXCLUDE,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
