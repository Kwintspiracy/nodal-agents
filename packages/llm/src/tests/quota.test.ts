// quota.test.ts — quota detection logic

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry';
import { QuotaExhaustedError } from '../errors';

vi.useFakeTimers();

function makeHttpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('quota detection', () => {
  it('converts "quota" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'You have exceeded your quota');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { provider: 'openai', model: 'gpt-4o' })).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts "billing" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'billing limit reached for your account');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { provider: 'anthropic', model: 'claude-3-5-sonnet' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('converts "insufficient" 429 to QuotaExhaustedError', async () => {
    const err = makeHttpError(429, 'insufficient_quota: You have run out of credits');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { provider: 'openai', model: 'gpt-4o-mini' }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('plain "rate limit exceeded" 429 is retried, NOT converted to QuotaExhaustedError', async () => {
    // 'rate limit exceeded' is the generic phrasing providers (OpenRouter, Groq,
    // ...) use for an ordinary per-minute throttle — transient, not a billing
    // fatal. Only a message co-occurring with a real quota/billing term (see
    // the test below) should be fatal.
    const err = makeHttpError(429, 'Rate limit exceeded for your current plan');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, {
      provider: 'groq',
      model: 'llama3-8b',
      maxRetries: 2,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('"rate limit exceeded" co-occurring with a real quota/billing term is still fatal', async () => {
    const err = makeHttpError(
      429,
      'Rate limit exceeded — you have exceeded your current quota, check your billing',
    );
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { provider: 'openai', model: 'gpt-4o' })).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('QuotaExhaustedError carries provider, model, reason', async () => {
    const err = makeHttpError(429, 'quota exceeded for entity');
    const fn = vi.fn().mockRejectedValue(err);
    try {
      await withRetry(fn, { provider: 'mistral', model: 'mistral-large' });
    } catch (e) {
      expect(e).toBeInstanceOf(QuotaExhaustedError);
      const qe = e as QuotaExhaustedError;
      expect(qe.provider).toBe('mistral');
      expect(qe.model).toBe('mistral-large');
      expect(qe.reason).toBeTruthy();
    }
  });

  it('plain "Too Many Requests" 429 is retried (not quota)', async () => {
    const err = makeHttpError(429, 'Too Many Requests');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, {
      provider: 'openai',
      model: 'gpt-4o',
      maxRetries: 2,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('QuotaExhaustedError has code "quota_exhausted"', () => {
    const qe = new QuotaExhaustedError('openai', 'gpt-4o', 'test reason');
    expect(qe.code).toBe('quota_exhausted');
  });

  it('QuotaExhaustedError message contains provider and model', () => {
    const qe = new QuotaExhaustedError('anthropic', 'claude-3-5-sonnet', 'ran out');
    expect(qe.message).toContain('anthropic');
    expect(qe.message).toContain('claude-3-5-sonnet');
  });
});
