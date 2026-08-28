// phase-failure-logging.test.ts — the cron tick's failure logging, wired.
//
// This suite exists because of a specific trap: testing lib/repeat-log.ts on
// its own proves the collapser works, NOT that a given call site uses it
// correctly. The defect codex found on PR #42 was exactly that — the
// pending-recovery phase called `logRepeatingFailure` but never the matching
// `reportRepeatingRecovery`, so its counter never reset. Every phase behind
// `guardPhase` did it right; the one phase guarded by hand did not. Only a
// test that drives the real `runCronTick` can tell those apart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { findPendingJobsToRecoverMock, runScheduleTickMock } = vi.hoisted(() => ({
  findPendingJobsToRecoverMock: vi.fn(),
  runScheduleTickMock: vi.fn(),
}));

// Every other phase is stubbed to a no-op success: this suite is about the
// FAILURE-LOGGING wiring of one phase, and a real phase throwing for unrelated
// reasons would muddy the assertion.
vi.mock('../../cron/reset-orphans.ts', () => ({
  resetOrphanedJobs: vi.fn(async () => 0),
  resetOrphanedTasks: vi.fn(async () => 0),
  expireStaleApprovals: vi.fn(async () => 0),
  failStalePendingJobs: vi.fn(async () => 0),
  findPendingJobsToRecover: findPendingJobsToRecoverMock,
}));
vi.mock('../../cron/unblock-ready.ts', () => ({ unblockReadyTasks: vi.fn(async () => 0) }));
vi.mock('../../cron/execute-ready.ts', () => ({ executeReadyTasks: vi.fn(async () => 0) }));
vi.mock('../../cron/run-schedules.ts', () => ({ runScheduleTick: runScheduleTickMock }));
vi.mock('../../cron/deliver-results.ts', () => ({ deliverCompletedRoots: vi.fn(async () => 0) }));
vi.mock('../../cron/run-curator.ts', () => ({
  runCuratorTick: vi.fn(async () => ({
    staled: 0,
    archived: 0,
    reactivated: 0,
    consolidationDeferred: 0,
    consolidationRan: 0,
  })),
}));
vi.mock('../../cron/run-skill-update-check.ts', () => ({
  runSkillUpdateCheckTick: vi.fn(async () => ({ checked: 0, updatesFound: 0 })),
}));
vi.mock('../../cron/prune-media.ts', () => ({ pruneJobMediaFiles: vi.fn(async () => 0) }));
vi.mock('@nodal-agents/db', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/db')>();
  return { ...actual, pruneOldJobs: vi.fn(async () => ({ jobsDeleted: 0, toolCallsDeleted: 0 })) };
});

import { runCronTick } from '../../cron/tick.ts';
import { _resetRepeatLogForTests } from '../../lib/repeat-log.ts';
import type { RunnerDeps } from '../../deps.ts';

const deps = { db: {}, llmClient: {}, registry: {} } as unknown as RunnerDeps;

let warns: string[];

beforeEach(() => {
  _resetRepeatLogForTests();
  vi.clearAllMocks();
  runScheduleTickMock.mockResolvedValue(0);
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pending-recovery phase — failure logging is wired both ways', () => {
  it('logs the first failure, then collapses the repeats', async () => {
    findPendingJobsToRecoverMock.mockRejectedValue(new Error('connection refused'));

    for (let i = 0; i < 15; i++) await runCronTick(deps);

    const lines = warns.filter((w) => w.includes('findPendingJobsToRecover failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('connection refused');
  });

  it('reports recovery, so a LATER outage is logged from its first failure', async () => {
    // Outage 1.
    findPendingJobsToRecoverMock.mockRejectedValue(new Error('connection refused'));
    for (let i = 0; i < 5; i++) await runCronTick(deps);

    // It comes back.
    findPendingJobsToRecoverMock.mockResolvedValue([]);
    await runCronTick(deps);
    expect(warns.join('\n')).toContain('findPendingJobsToRecover recovered after 5 failed tick(s)');
    warns.length = 0;

    // Outage 2. Without the recovery call the counter would still sit at 5,
    // and this first failure of a NEW incident would be silently swallowed
    // until the 20th — the suppression outliving the incident it was made for.
    findPendingJobsToRecoverMock.mockRejectedValue(new Error('connection refused'));
    await runCronTick(deps);

    expect(warns.filter((w) => w.includes('findPendingJobsToRecover failed'))).toHaveLength(1);
  });

  it('surfaces a CHANGED error immediately rather than at the next threshold', async () => {
    findPendingJobsToRecoverMock.mockRejectedValue(new Error('connection refused'));
    for (let i = 0; i < 5; i++) await runCronTick(deps);
    warns.length = 0;

    // The reason changes — this is the line that explains the real cause.
    findPendingJobsToRecoverMock.mockRejectedValue(new Error('password authentication failed'));
    await runCronTick(deps);

    const lines = warns.filter((w) => w.includes('findPendingJobsToRecover failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('password authentication failed');
  });

  it('stays silent on a healthy tick', async () => {
    findPendingJobsToRecoverMock.mockResolvedValue([]);

    for (let i = 0; i < 10; i++) await runCronTick(deps);

    expect(warns.filter((w) => w.includes('findPendingJobsToRecover'))).toEqual([]);
  });
});

describe('runScheduleTick — out-of-order completions do not fake a recovery', () => {
  // Found by codex review on PR #42, 9th pass. runScheduleTick is deliberately
  // fire-and-forget (a slow schedule must not stall delivery), so invocations
  // from overlapping ticks can settle out of order. An OLD, slow success
  // landing after a NEWER failure would clear that failure and announce a
  // recovery that never happened — and the next real failure would then be
  // logged as a fresh incident. Only the most recent invocation may touch the
  // repeating-failure state.
  it('ignores a stale success that lands after a newer failure', async () => {
    findPendingJobsToRecoverMock.mockResolvedValue([]);

    let releaseSlowSuccess: () => void = () => {};
    const slowSuccess = new Promise<number>((resolve) => {
      releaseSlowSuccess = () => resolve(0);
    });
    runScheduleTickMock.mockReturnValueOnce(slowSuccess);
    runScheduleTickMock.mockRejectedValueOnce(new Error('connection refused'));

    // Tick 1 starts the slow call; tick 2's call fails immediately.
    await runCronTick(deps);
    await runCronTick(deps);
    await new Promise((r) => setImmediate(r));
    warns.length = 0;

    // The stale success finally lands.
    releaseSlowSuccess();
    await slowSuccess;
    await new Promise((r) => setImmediate(r));

    // It must NOT claim the site recovered — the latest word is a failure.
    expect(warns.filter((w) => w.includes('runScheduleTick recovered'))).toEqual([]);
  });
});
