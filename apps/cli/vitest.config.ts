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
  },
});
