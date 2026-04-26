// retry.test.ts — withRetry() behavior

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry.js';
import { QuotaExhaustedError, MessageStructureError, RetryExhaustedError } from '../errors.js';

// Override setTimeout globally for tests so backoff doesn't slow things down
vi.useFakeTimers();

function makeHttpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 (transient rate limit)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeHttpError(429, 'Too Many Requests'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500', async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeHttpError(500)).mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 502', async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeHttpError(502)).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 503', async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeHttpError(503)).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(400, 'Bad Request'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(401, 'Unauthorized'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 404', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(404, 'Not Found'));
    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws RetryExhaustedError after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(makeHttpError(503, 'Service Unavailable'));

    const assertion = expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it('does NOT retry MessageStructureError — fails immediately', async () => {
    const structErr = new MessageStructureError('unresolved_tail', { messageIndex: 0 });
    const fn = vi.fn().mockRejectedValue(structErr);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBeInstanceOf(MessageStructureError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry QuotaExhaustedError — fails immediately', async () => {
    const quotaErr = new QuotaExhaustedError('openai', 'gpt-4o', 'quota exceeded');
    const fn = vi.fn().mockRejectedValue(quotaErr);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts billing 429 to QuotaExhaustedError', async () => {
    const billingErr = makeHttpError(429, 'You have exceeded your quota. billing limit reached.');
    const fn = vi.fn().mockRejectedValue(billingErr);

    await expect(
      withRetry(fn, { maxRetries: 3, provider: 'openai', model: 'gpt-4o' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts insufficient_quota 429 to QuotaExhaustedError', async () => {
    const quotaErr = makeHttpError(429, 'insufficient quota remaining');
    const fn = vi.fn().mockRejectedValue(quotaErr);

    await expect(
      withRetry(fn, { maxRetries: 3, provider: 'anthropic', model: 'claude-3-5-sonnet' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('plain transient 429 is retried (not converted to quota error)', async () => {
    const rateLimitErr = makeHttpError(429, 'Too Many Requests please slow down');
    const fn = vi.fn().mockRejectedValueOnce(rateLimitErr).mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
