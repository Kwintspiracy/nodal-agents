// cron/tests/ticker.test.ts
// Acceptance criteria:
//   - startCronTicker → tick fires within intervalMs
//   - stop() prevents further ticks
//   - onError callback called on tick error, ticker continues
//   - a `skipped:true` result (re-entrancy guard) logs a warning, not an error
//
// The re-entrancy guard (M-7/R3) and the stuck-tick watchdog (R1) no longer
// live in ticker.ts — they moved to guarded-tick.ts's `runCronTickGuarded`,
// shared with the HTTP /api/cron route (routes/cron.ts). Those mechanisms
// are tested directly and more thoroughly in cron/tests/guarded-tick.test.ts.
// This file only tests ticker.ts's OWN remaining responsibility: firing
// `runCronTickGuarded` on an interval, handling its resolved/rejected
// outcomes, and the handle lifecycle (stop()).

import { describe, it, expect, vi } from 'vitest';
import { startCronTicker } from '../ticker.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { GuardedTickResult } from '../guarded-tick.ts';

const { getMode, setMode, getCallCount, getLastMaxTickMs, recordCall } = vi.hoisted(() => {
  let _mode: 'resolve' | 'skip' | 'throw' = 'resolve';
  let _callCount = 0;
  let _lastMaxTickMs: number | undefined;
  return {
    getMode: () => _mode,
    setMode: (m: 'resolve' | 'skip' | 'throw') => {
      _mode = m;
    },
    getCallCount: () => _callCount,
    getLastMaxTickMs: () => _lastMaxTickMs,
    recordCall: (maxTickMs: number | undefined) => {
      _callCount++;
      _lastMaxTickMs = maxTickMs;
    },
  };
});

vi.mock('../guarded-tick.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../guarded-tick.ts')>();
  return {
    ...actual,
    runCronTickGuarded: async (
      _deps: unknown,
      _maxTasksPerTick?: number,
      maxTickMs?: number,
    ): Promise<GuardedTickResult> => {
      recordCall(maxTickMs);
      const zero: GuardedTickResult = {
        orphanJobsReset: 0,
        pendingRecovered: 0,
        stalePendingFailed: 0,
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
        retentionJobsDeleted: 0,
        retentionToolCallsDeleted: 0,
        skipped: false,
      };
      if (getMode() === 'throw') {
        throw new Error('ticker.test: simulated runCronTickGuarded rejection');
      }
      if (getMode() === 'skip') {
        return { ...zero, skipped: true };
      }
      return zero;
    },
  };
});

// ─── Minimal deps stub ────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('startCronTicker', () => {
  it('stop() is callable without error (handle lifecycle)', () => {
    const deps = makeStubDeps();
    const ticker = startCronTicker(deps, {
      intervalMs: 10_000,
      onError: () => {},
    });

    // stop should not throw
    expect(() => ticker.stop()).not.toThrow();
  });

  it('stop() can be called multiple times without error', () => {
    const deps = makeStubDeps();
    const ticker = startCronTicker(deps, {
      intervalMs: 10_000,
      onError: () => {},
    });

    expect(() => {
      ticker.stop();
      ticker.stop(); // calling twice is safe
    }).not.toThrow();
  });

  it('onError callback is called when runCronTickGuarded rejects, ticker continues', async () => {
    const errors: unknown[] = [];
    const deps = makeStubDeps();

    setMode('throw');
    try {
      const ticker = startCronTicker(deps, {
        intervalMs: 30, // very short for fast test
        onError: (e) => {
          errors.push(e);
        },
      });

      // Wait for at least one tick to fire and fail
      await new Promise((resolve) => setTimeout(resolve, 150));

      ticker.stop();

      expect(errors.length).toBeGreaterThan(0);
    } finally {
      setMode('resolve');
    }
  });

  it('logs a warning (not onError) when a tick is skipped by the re-entrancy guard', async () => {
    const errors: unknown[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deps = makeStubDeps();

    setMode('skip');
    try {
      const ticker = startCronTicker(deps, {
        intervalMs: 30,
        onError: (e) => {
          errors.push(e);
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      ticker.stop();

      // A skipped result is NOT an error — onError must not fire for it.
      expect(errors.length).toBe(0);
      const loggedSkip = warnSpy.mock.calls.some(([msg]) => String(msg).includes('skipped'));
      expect(loggedSkip).toBe(true);
    } finally {
      setMode('resolve');
      warnSpy.mockRestore();
    }
  });

  it('forwards opts.maxTickMs through to runCronTickGuarded', async () => {
    const deps = makeStubDeps();
    const ticker = startCronTicker(deps, { intervalMs: 30, onError: () => {}, maxTickMs: 42_000 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    ticker.stop();

    expect(getCallCount()).toBeGreaterThan(0);
    expect(getLastMaxTickMs()).toBe(42_000);
  });

  it('returns a handle with a stop method', () => {
    const deps = makeStubDeps();
    const ticker = startCronTicker(deps, { intervalMs: 60_000, onError: () => {} });

    expect(ticker).toBeDefined();
    expect(typeof ticker.stop).toBe('function');

    ticker.stop();
  });
});
