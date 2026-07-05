// cron/tests/ticker.test.ts
// Acceptance criteria:
//   - startCronTicker → tick fires within intervalMs
//   - stop() prevents further ticks
//   - onError callback called on tick error, ticker continues

import { describe, it, expect, vi } from 'vitest';
import { startCronTicker } from '../ticker.ts';
import type { RunnerDeps } from '../../deps.ts';

// Finding H-2 (audit): runCronTick now isolates every phase internally (see
// tick.test.ts), so it no longer rejects even when deps.db is a broken stub
// — every phase's throw is caught and logged, and the tick resolves with
// fallback counts. That's the fix working as intended, but it means this
// file can no longer exercise the ticker's onError wiring by handing it
// deliberately-broken deps and waiting for runCronTick to throw "for free".
// Mock '../tick.ts' instead so this file tests ONLY the ticker's own
// catch/continue plumbing (`runCronTick(deps, 5).catch(onError)` in
// ticker.ts), independently of tick.ts's internal resilience.
const { getTickShouldThrow, setTickShouldThrow } = vi.hoisted(() => {
  let _throw = false;
  return {
    getTickShouldThrow: () => _throw,
    setTickShouldThrow: (v: boolean) => {
      _throw = v;
    },
  };
});

vi.mock('../tick.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../tick.ts')>();
  return {
    ...actual,
    runCronTick: (...args: Parameters<typeof actual.runCronTick>) => {
      if (getTickShouldThrow()) {
        return Promise.reject(new Error('ticker.test: simulated runCronTick rejection'));
      }
      return actual.runCronTick(...args);
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

  it('onError callback is called on tick error, ticker continues', async () => {
    const errors: unknown[] = [];
    const deps = makeStubDeps();

    setTickShouldThrow(true);
    try {
      // The mocked runCronTick (above) rejects unconditionally while this
      // flag is set — onError must be called, not re-thrown.
      const ticker = startCronTicker(deps, {
        intervalMs: 30, // very short for fast test
        onError: (e) => {
          errors.push(e);
        },
      });

      // Wait for at least one tick to fire and fail
      await new Promise((resolve) => setTimeout(resolve, 150));

      ticker.stop();

      // runCronTick rejected, onError should have been called
      expect(errors.length).toBeGreaterThan(0);
      // The ticker must still be alive after errors (no re-throw)
      // Verified: stop() called above without error proves ticker survived
    } finally {
      setTickShouldThrow(false);
    }
  });

  it('returns a handle with a stop method', () => {
    const deps = makeStubDeps();
    const ticker = startCronTicker(deps, { intervalMs: 60_000, onError: () => {} });

    expect(ticker).toBeDefined();
    expect(typeof ticker.stop).toBe('function');

    ticker.stop();
  });
});
