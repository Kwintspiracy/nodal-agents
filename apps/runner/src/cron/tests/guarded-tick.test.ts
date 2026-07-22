// cron/tests/guarded-tick.test.ts — runCronTickGuarded
//
// Direct tests of the shared re-entrancy guard (finding M-7 + R3) and
// watchdog (finding R1) — the mechanism ticker.ts and routes/cron.ts both
// delegate to. Testing the function directly (not through setInterval or the
// HTTP route) keeps these deterministic and independent of interval timing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunnerDeps } from '../../deps.ts';
import type { CronTickResult } from '../tick.ts';

const {
  getTickGate,
  setTickGate,
  getTickResult,
  setTickResult,
  getTickShouldThrow,
  setTickShouldThrow,
  getStartCount,
  incrementStartCount,
  resetMockTracking,
} = vi.hoisted(() => {
  let _gate: Promise<void> | null = null;
  let _result: unknown = null;
  let _throw = false;
  let _startCount = 0;
  return {
    getTickGate: () => _gate,
    setTickGate: (p: Promise<void> | null) => {
      _gate = p;
    },
    getTickResult: () => _result,
    setTickResult: (r: unknown) => {
      _result = r;
    },
    getTickShouldThrow: () => _throw,
    setTickShouldThrow: (v: boolean) => {
      _throw = v;
    },
    getStartCount: () => _startCount,
    incrementStartCount: () => {
      _startCount++;
    },
    resetMockTracking: () => {
      _gate = null;
      _result = null;
      _throw = false;
      _startCount = 0;
    },
  };
});

vi.mock('../tick.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../tick.ts')>();
  const zero: CronTickResult = {
    orphanJobsReset: 0,
    pendingRecovered: 0,
    stalePendingFailed: 0,
    approvalsExpired: 0,
    orphansReset: 0,
    tasksUnblocked: 0,
    tasksExecuted: 0,
    schedulesFired: 0,
    rootsDelivered: 0,
    curatorStaled: 0,
    curatorArchived: 0,
    curatorReactivated: 0,
    curatorConsolidationDeferred: 0,
    curatorConsolidationRan: 0,
    skillUpdatesChecked: 0,
    skillUpdatesFound: 0,
    retentionJobsDeleted: 0,
    retentionToolCallsDeleted: 0,
  };
  return {
    ...actual,
    runCronTick: async (): Promise<CronTickResult> => {
      incrementStartCount();
      if (getTickShouldThrow()) {
        throw new Error('guarded-tick.test: simulated runCronTick rejection');
      }
      const gate = getTickGate();
      if (gate) await gate;
      return (getTickResult() as CronTickResult | null) ?? zero;
    },
  };
});

import { runCronTickGuarded, _resetGuardedTickForTests } from '../guarded-tick.ts';

function makeStubDeps(): RunnerDeps {
  return {
    db: {} as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

beforeEach(() => {
  resetMockTracking();
  _resetGuardedTickForTests();
});

describe('runCronTickGuarded — re-entrancy guard (findings M-7 / R3)', () => {
  it('a second call while one is in flight is skipped (zero counts, skipped:true)', async () => {
    let releaseGate!: () => void;
    setTickGate(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      }),
    );

    const deps = makeStubDeps();
    const firstCall = runCronTickGuarded(deps);

    // Second call arrives while the first is still stuck on the gate — this
    // simulates the ticker and the /api/cron route (or two overlapping
    // external-scheduler requests) racing each other.
    const secondResult = await runCronTickGuarded(deps);
    expect(secondResult.skipped).toBe(true);
    expect(secondResult.tasksExecuted).toBe(0);
    // The underlying runCronTick was never invoked a second time.
    expect(getStartCount()).toBe(1);

    releaseGate();
    const firstResult = await firstCall;
    expect(firstResult.skipped).toBe(false);

    // Now that the first call finished, a third call runs normally.
    const thirdResult = await runCronTickGuarded(deps);
    expect(thirdResult.skipped).toBe(false);
    expect(getStartCount()).toBe(2);
  });

  it('a rejection from the underlying tick propagates (not swallowed) and still resets `running`', async () => {
    setTickShouldThrow(true);
    const deps = makeStubDeps();

    await expect(runCronTickGuarded(deps)).rejects.toThrow(
      'guarded-tick.test: simulated runCronTick rejection',
    );

    setTickShouldThrow(false);
    // `running` was reset in the `finally` despite the rejection — the next
    // call runs normally, not skipped.
    const result = await runCronTickGuarded(deps);
    expect(result.skipped).toBe(false);
  });

  it('returns the real tick result when nothing overlaps', async () => {
    setTickResult({
      orphanJobsReset: 1,
      pendingRecovered: 2,
      stalePendingFailed: 0,
      approvalsExpired: 0,
      orphansReset: 0,
      tasksUnblocked: 3,
      tasksExecuted: 4,
      schedulesFired: 0,
      rootsDelivered: 1,
      curatorStaled: 0,
      curatorArchived: 0,
      curatorReactivated: 0,
      curatorConsolidationDeferred: 0,
      curatorConsolidationRan: 0,
      retentionJobsDeleted: 0,
      retentionToolCallsDeleted: 0,
    });

    const result = await runCronTickGuarded(makeStubDeps());
    expect(result.skipped).toBe(false);
    expect(result.tasksExecuted).toBe(4);
    expect(result.rootsDelivered).toBe(1);
  });
});

describe('runCronTickGuarded — watchdog (finding R1)', () => {
  it('forces `running` back to false after maxTickMs even though the tick never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Never resolves — the worst-case hang.
      setTickGate(new Promise<void>(() => {}));

      const deps = makeStubDeps();
      const stuckCall = runCronTickGuarded(deps, 5, 1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      const stuckResult = await stuckCall;

      expect(stuckResult.skipped).toBe(false);
      expect(stuckResult.tasksExecuted).toBe(0);
      const loggedStuck = errorSpy.mock.calls.some(([msg]) => /exceeded|stuck/i.test(String(msg)));
      expect(loggedStuck).toBe(true);

      // `running` was reset by the watchdog — a NEW call runs normally
      // (not skipped), even though the FIRST tick is still leaked/pending.
      setTickResult({
        orphanJobsReset: 0,
        pendingRecovered: 0,
        stalePendingFailed: 0,
        approvalsExpired: 0,
        orphansReset: 0,
        tasksUnblocked: 0,
        tasksExecuted: 7,
        schedulesFired: 0,
        rootsDelivered: 0,
        curatorStaled: 0,
        curatorArchived: 0,
        curatorReactivated: 0,
        curatorConsolidationDeferred: 0,
        curatorConsolidationRan: 0,
        retentionJobsDeleted: 0,
        retentionToolCallsDeleted: 0,
      });
      setTickGate(null);
      const nextResult = await runCronTickGuarded(deps, 5, 1_000);
      expect(nextResult.skipped).toBe(false);
      expect(nextResult.tasksExecuted).toBe(7);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
      setTickGate(null);
    }
  });

  it('does not log the watchdog message for a tick that completes well within maxTickMs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps = makeStubDeps();
      const result = await runCronTickGuarded(deps, 5, 60_000);
      expect(result.skipped).toBe(false);
      const loggedStuck = errorSpy.mock.calls.some(([msg]) => /exceeded|stuck/i.test(String(msg)));
      expect(loggedStuck).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
