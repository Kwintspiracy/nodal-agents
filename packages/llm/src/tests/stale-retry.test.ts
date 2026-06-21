// stale-retry.test.ts — withStaleRetry() unit tests
//
// All tests use an injected call fn and injected timeout opts so no real timers
// are needed. The fn receives the per-attempt timeoutMs and can inspect it or
// throw on demand — fully deterministic, no fake timers required.
//
// CHANGE 2 from the hardening spec:
//  - timeout-then-succeed → resolves (1 stale retry consumed)
//  - always-timeout → LLMTimeoutError after primary + all retries
//  - non-timeout error → propagates immediately (no stale retry)
//  - per-attempt timeout values are primary then stale-retry budget

import { describe, it, expect, vi } from 'vitest';
import { withStaleRetry } from '../client';
import { LLMTimeoutError } from '../errors';

// Sentinel error that mimics an AbortSignal.timeout() firing.
// Uses name='TimeoutError' so isAbortOrTimeoutError detects it.
function makeTimeoutError(): Error {
  const e = new Error('signal timed out');
  e.name = 'TimeoutError';
  return e;
}

// A distinct non-timeout error (e.g. a 500).
function makeServerError(): Error {
  const e = new Error('Internal Server Error') as Error & { status: number };
  (e as unknown as Record<string, number>)['status'] = 500;
  return e;
}

const PROVIDER_MODEL = { provider: 'deepseek', model: 'deepseek-r1' };

// Opts that give us minimal, deterministic budgets for the tests.
// The fn does NOT actually sleep — the timeoutMs values are just passed in
// as arguments for inspection.
const TEST_OPTS = {
  primaryTimeoutMs: 300,
  retryTimeoutMs: 150,
  maxRetries: 1,
};

// ─── Basic recovery ────────────────────────────────────────────────────────────

describe('withStaleRetry — timeout-then-succeed', () => {
  it('resolves when the first stale retry succeeds', async () => {
    let callCount = 0;
    const fn = async (timeoutMs: number): Promise<string> => {
      callCount += 1;
      if (callCount === 1) {
        // Primary: simulate timeout
        expect(timeoutMs).toBe(300); // must use primaryTimeoutMs
        throw makeTimeoutError();
      }
      // Stale retry: succeed
      expect(timeoutMs).toBe(150); // must use retryTimeoutMs
      return 'recovered';
    };

    const result = await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);
    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('resolves on primary if no timeout (zero stale retries consumed)', async () => {
    const fn = vi.fn().mockResolvedValue('fast');

    const result = await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);
    expect(result).toBe('fast');
    expect(fn).toHaveBeenCalledTimes(1);
    // Primary timeout should have been used
    expect(fn).toHaveBeenCalledWith(300);
  });
});

// ─── Always-timeout → LLMTimeoutError ─────────────────────────────────────────

describe('withStaleRetry — always-timeout', () => {
  it('throws LLMTimeoutError after primary + all stale retries exhaust', async () => {
    const fn = vi.fn().mockImplementation((_timeoutMs: number) => {
      return Promise.reject(makeTimeoutError());
    });

    await expect(withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS)).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );

    // maxRetries=1 → primary (1) + 1 stale retry = 2 total calls
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('LLMTimeoutError carries the primary provider+model', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(makeTimeoutError()));

    let caught: unknown;
    try {
      await withStaleRetry(fn, PROVIDER_MODEL, { ...TEST_OPTS, maxRetries: 0 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LLMTimeoutError);
    const err = caught as LLMTimeoutError;
    expect(err.provider).toBe('deepseek');
    expect(err.model).toBe('deepseek-r1');
    expect(err.timeoutMs).toBe(300); // primaryTimeoutMs
  });

  it('with maxRetries=0 (disabled), a single timeout throws LLMTimeoutError immediately', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(makeTimeoutError()));

    await expect(
      withStaleRetry(fn, PROVIDER_MODEL, { ...TEST_OPTS, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(fn).toHaveBeenCalledTimes(1); // only the primary call
  });

  it('with maxRetries=2, calls primary + 2 stale retries before LLMTimeoutError', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(makeTimeoutError()));

    await expect(
      withStaleRetry(fn, PROVIDER_MODEL, { ...TEST_OPTS, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(fn).toHaveBeenCalledTimes(3); // primary + 2 retries
  });
});

// ─── Non-timeout error → immediate propagation ─────────────────────────────────

describe('withStaleRetry — non-timeout error propagates immediately', () => {
  it('propagates a 500 error without stale retry', async () => {
    const serverErr = makeServerError();
    const fn = vi.fn().mockRejectedValue(serverErr);

    await expect(withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS)).rejects.toBe(serverErr);
    // Only the primary attempt — no stale retry for non-timeout errors
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-timeout error even if it occurs on a stale-retry attempt', async () => {
    // Primary times out → stale retry → non-timeout error
    let callCount = 0;
    const serverErr = makeServerError();
    const fn = async (_timeoutMs: number): Promise<string> => {
      callCount += 1;
      if (callCount === 1) throw makeTimeoutError();
      throw serverErr; // stale retry gets a non-timeout error
    };

    await expect(withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS)).rejects.toBe(serverErr);
    expect(callCount).toBe(2);
  });
});

// ─── Per-attempt timeout values ────────────────────────────────────────────────

describe('withStaleRetry — per-attempt timeout values', () => {
  it('passes primaryTimeoutMs to the first call', async () => {
    const seen: number[] = [];
    const fn = async (timeoutMs: number): Promise<string> => {
      seen.push(timeoutMs);
      return 'ok';
    };

    await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);
    expect(seen).toEqual([300]);
  });

  it('passes primaryTimeoutMs first then retryTimeoutMs for each stale attempt', async () => {
    const seen: number[] = [];
    let callCount = 0;

    const fn = async (timeoutMs: number): Promise<string> => {
      seen.push(timeoutMs);
      callCount += 1;
      if (callCount === 1) throw makeTimeoutError(); // primary times out
      return 'ok'; // stale retry succeeds
    };

    await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);
    expect(seen).toEqual([300, 150]);
  });

  it('all stale retries use retryTimeoutMs (not primaryTimeoutMs)', async () => {
    const seen: number[] = [];
    const fn = async (timeoutMs: number): Promise<string> => {
      seen.push(timeoutMs);
      throw makeTimeoutError(); // always time out
    };

    await expect(
      withStaleRetry(fn, PROVIDER_MODEL, {
        primaryTimeoutMs: 300,
        retryTimeoutMs: 150,
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(seen).toEqual([300, 150, 150]);
  });
});

// ─── Log output verification ───────────────────────────────────────────────────

describe('withStaleRetry — logging', () => {
  it('logs [llm-stale-retry] when a stale retry is triggered', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let callCount = 0;
    const fn = async (_timeoutMs: number): Promise<string> => {
      callCount += 1;
      if (callCount === 1) throw makeTimeoutError();
      return 'ok';
    };

    await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);

    const logged = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[llm-stale-retry]'))).toBe(true);
    expect(logged.some((l) => l.includes('deepseek'))).toBe(true);
    expect(logged.some((l) => l.includes('attempt=1/1'))).toBe(true);

    warnSpy.mockRestore();
  });

  it('does NOT log [llm-stale-retry] when the primary succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue('fast');

    await withStaleRetry(fn, PROVIDER_MODEL, TEST_OPTS);

    const logged = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[llm-stale-retry]'))).toBe(false);

    warnSpy.mockRestore();
  });
});
