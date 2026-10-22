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
//
// THE POOL, AND THE REPORT FILE (#841). Every run uses vitest's forks pool with
// one addition: a worker that dies without vitest asking says how (exit code,
// signal, the files it was running — packages/test-kit/src/vitest-worker-exit.ts).
// And when `NODAL_VITEST_REPORT_DIR` is set (CI), each package also writes its
// results there (packages/test-kit/src/vitest-run-report.ts), named after its
// directory, plus the worker-exit lines: the job uploads that directory, so a
// run whose log turbo flushed badly, or whose worker died with no output, still
// leaves behind which files never reported.
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { RunReportReporter } from './packages/test-kit/src/vitest-run-report.ts';
import { exitReportingForks } from './packages/test-kit/src/vitest-worker-exit.ts';

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

/** Where CI wants the report files; unset everywhere else. */
export const REPORT_DIR_ENV = 'NODAL_VITEST_REPORT_DIR';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** `packages/tools` → `packages__tools`; the repository root → `root`. turbo and
 * pnpm run each package's `vitest run` from the package's own directory. */
export function reportName(cwd: string): string {
  return relative(REPO_ROOT, cwd).split(sep).join('__') || 'root';
}

const reportDir = process.env[REPORT_DIR_ENV];
const name = reportName(process.cwd());

export const baseConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: EXCLUDE,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    pool: exitReportingForks(
      reportDir ? { logFile: join(reportDir, `${name}.worker-exits.log`) } : {},
    ),
    ...(reportDir
      ? {
          reporters: [
            'default',
            new RunReportReporter(name, join(reportDir, `${name}.vitest-report.json`)),
          ],
        }
      : {}),
  },
});
