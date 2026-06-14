// retry-hardening.test.ts — classifier hardening: 529/408 retryable, 400/401/403/422 not,
// socket hang up / econnreset retryable.
//
// These tests extend (not replace) retry.test.ts. They cover the new entries added by
// CHANGE 1 in the hardening spec.

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry';
import { RetryExhaustedError } from '../errors';

vi.useFakeTimers();

function makeHttpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeNetworkError(message: string): Error {
  return new Error(message);
}

// ─── New retryable HTTP statuses ───────────────────────────────────────────────

describe('withRetry — 529 (Overloaded, Anthropic/MiniMax native)', () => {
  it('retries on 529 and recovers', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeHttpError(529, 'Overloaded'))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError when 529 persists across all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(529, 'Overloaded'));

    const assertion = expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });
});

describe('withRetry — 408 (Request Timeout, transport/gateway)', () => {
  it('retries on 408 and recovers', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeHttpError(408, 'Request Timeout'))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError when 408 persists across all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(408, 'Request Timeout'));

    const assertion = expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ─── Non-retryable 4xx (must NOT be retried) ──────────────────────────────────

describe('withRetry — non-retryable 4xx (400/401/403/422)', () => {
  it('does NOT retry 400 Bad Request', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(400, 'Bad Request'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry 401 Unauthorized', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(401, 'Unauthorized'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry 403 Forbidden', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(403, 'Forbidden'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry 422 Unprocessable Entity', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(422, 'Unprocessable Entity'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 422 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── Network error message heuristics ─────────────────────────────────────────

describe('withRetry — network error message heuristics', () => {
  it('retries on "socket hang up" (dropped native connection)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeNetworkError('socket hang up'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "econnreset" (connection reset by peer)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeNetworkError('read ECONNRESET'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "ECONNRESET" (uppercase variant)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "fetch failed" (existing — preserved)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeNetworkError('fetch failed'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
