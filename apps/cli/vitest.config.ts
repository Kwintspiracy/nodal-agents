import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    // One test file at a time.
    //
    // This suite is unusual: it drives real OS state — spawning process trees,
    // killing them, and enumerating the Windows process table through WMI. That
    // enumeration is expensive and does not parallelise. Vitest gives each file
    // its own worker, so three files exercising it at once put a dozen
    // concurrent WMI queries on a two-core CI runner; they throttled each other
    // until every one timed out, and each timeout handed back an empty table.
    // The suite then failed for want of machine, not for want of correctness
    // (Windows CI, 2026-08-21).
    //
    // The in-process single-flight in processSnapshotWin cannot help here —
    // separate workers are separate processes. Serial files can.
    //
    // Cost is small and worth naming: the whole suite runs in ~4s locally, and
    // these tests spend most of their time waiting on the OS rather than on the
    // CPU, so little parallelism was being bought in the first place.
    fileParallelism: false,
    // The vitest default (5 s per test) is the only config in the monorepo that
    // was left at it, and this suite spawns REAL processes: `nodal-home.test.ts`
    // starts the CLI through tsx (`node --import tsx src/index.ts`), which is
    // ~0.5 s on a free 24-core machine and 4 to 10 s on two contended cores
    // (measured 2026-10-18: pinned to 2 cores with 6 busy loops, 4 runs out of 4
    // timed out at 5000 ms on the 'bad NODALAI_HOME' cases, while the spawn
    // itself finishes). Windows CI went red on exactly this (run 39158880706).
    // The spawn already carries its own 60 s bound; the test must not be cut
    // earlier than the process it waits for. Same value as the root, runner and
    // db configs.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
