// rate-limit-policy.test.ts — 429/529 capacity-class retry policy.
//
// Live trigger: job 47d651c2 (2026-07-17) — Alfred's kimi-k3 hit an upstream
// 429 right after a successful delegation; 4 retries in ~7s were spent before
// the congestion could possibly clear, and the job died with the child's
// research result stranded in DB.
//
// Policy under test (constants mirror Hermes conversation_loop.py:4121-4146):
//  - Retry-After header honored exactly, capped at 600s.
//  - No header → exponential backoff base 2s, capped 60s/attempt, jittered.
//  - Rate-limit retry budget: 5 without fallback, 1 with fallback.
//  - With a fallback configured, any wait > 5s exhausts immediately (failover
//    serves faster than waiting).
//  - Cumulative rate-limit wait capped at 900s.

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry';
import { RetryExhaustedError } from '../errors';

vi.useFakeTimers();

function makeRateLimitError(
  status: number,
  message: string,
  responseHeaders?: Record<string, string>,
): Error {
  const err = new Error(message) as Error & {
    status: number;
    responseHeaders?: Record<string, string>;
  };
  err.status = status;
  if (responseHeaders) err.responseHeaders = responseHeaders;
  return err;
}

describe('withRetry — Retry-After header', () => {
  it('waits exactly the Retry-After duration before retrying', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError(429, 'Too Many Requests', { 'retry-after': '30' }))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    // Just before the 30s window: no second attempt yet.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fn).toHaveBeenCalledTimes(1);
    // At 30s the retry fires (Retry-After is exact — no jitter).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('reads Retry-After from the cause chain (wrapped APICallError)', async () => {
    const inner = makeRateLimitError(429, 'rate limited', { 'Retry-After': '10' });
    const wrapper = new Error('AI_APICallError: rate limited') as Error & {
      status: number;
      cause?: unknown;
    };
    wrapper.status = 429;
    wrapper.cause = inner;
    const fn = vi.fn().mockRejectedValueOnce(wrapper).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('caps Retry-After at 600s (Hermes #26293)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        makeRateLimitError(429, 'Too Many Requests', { 'retry-after': '3600' }),
      )
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('ignores a non-numeric Retry-After and falls back to backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        makeRateLimitError(429, 'Too Many Requests', {
          'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
        }),
      )
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    // Backoff base 2s + ≤500ms jitter — fires well before 3s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });
});

describe('withRetry — rate-limit backoff without header', () => {
  it('gives a persistent 429 the rate-limit budget (5 retries), not maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(makeRateLimitError(429, 'Too Many Requests'));

    const assertion = expect(withRetry(fn, { maxRetries: 2 })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(6); // 1 attempt + 5 rate-limit retries
  });

  it('waits on the 2s-base scale, not the 1s generic scale', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError(429, 'Too Many Requests'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    // Before the 2s base delay: no retry yet (generic path would have fired at 1s+jitter).
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fn).toHaveBeenCalledTimes(1);
    // 2s base + ≤500ms jitter — fires by 2.5s.
    await vi.advanceTimersByTimeAsync(700);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toBe('ok');
  });

  it('treats a message-only rate-limit error (no status) as retryable', async () => {
    // The live 47d651c2 shape: AI_APICallError text mentions the throttle but
    // the transport surfaced no usable status code.
    const err = new Error(
      '[Moonshot AI] moonshotai/kimi-k3 is temporarily rate-limited upstream. Please retry shortly',
    );
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry — hasFallback (failover-aware fast exhaust)', () => {
  it('exhausts immediately when Retry-After exceeds the 5s fallback cap', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(makeRateLimitError(429, 'Too Many Requests', { 'retry-after': '30' }));

    await expect(withRetry(fn, { maxRetries: 3, hasFallback: true })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1); // no wait, no retry — failover takes over
  });

  it('allows one quick retry then exhausts (budget 1 with fallback)', async () => {
    const fn = vi.fn().mockRejectedValue(makeRateLimitError(429, 'Too Many Requests'));

    const assertion = expect(
      withRetry(fn, { maxRetries: 3, hasFallback: true }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(2); // 1 attempt + 1 quick retry (2s base ≤ 5s cap)
  });

  it('recovers on the quick retry when the throttle clears', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeRateLimitError(429, 'Too Many Requests', { 'retry-after': '2' }))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, hasFallback: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT shorten the generic (non-rate-limit) path', async () => {
    const err = new Error('HTTP 503') as Error & { status: number };
    err.status = 503;
    const fn = vi.fn().mockRejectedValue(err);

    const assertion = expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, hasFallback: true }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // 1 attempt + 2 generic retries, unchanged
  });
});

describe('withRetry — cumulative rate-limit wait budget', () => {
  it('exhausts once cumulative Retry-After waits would exceed 900s', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(makeRateLimitError(429, 'Too Many Requests', { 'retry-after': '600' }));

    const assertion = expect(withRetry(fn, { maxRetries: 3 })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    await vi.runAllTimersAsync();
    await assertion;

    // First wait: 600s (total 600 ≤ 900). Second wait would reach 1200s > 900 →
    // exhaust after 2 calls, not 6.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
