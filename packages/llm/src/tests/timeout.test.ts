// timeout.test.ts — withTimeout helper + LLMTimeoutError retry integration
//
// Regression for the live-caught hang on 2026-05-15 (job `2461d25b-...`):
// OpenRouter spike → fetch never returns → runner stuck 5min until cron
// orphan reset. Now: 90s timeout, retry on LLMTimeoutError, fresh attempt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from '../client';
import { LLMTimeoutError } from '../errors';
import { withRetry } from '../retry';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the inner result when the call completes in time', async () => {
    const result = await withTimeout(async () => 'ok', 1000, 'openrouter', 'deepseek/x');
    expect(result).toBe('ok');
  });

  it('throws LLMTimeoutError when the inner call exceeds the timeout', async () => {
    const slow = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('AbortError')));
        // never resolves on its own — only aborts via signal
      });
    const promise = withTimeout(slow, 100, 'openrouter', 'deepseek/x');
    vi.advanceTimersByTime(101);
    await expect(promise).rejects.toBeInstanceOf(LLMTimeoutError);
    await expect(promise).rejects.toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/x',
      timeoutMs: 100,
      code: 'llm_timeout',
    });
  });

  it('rethrows non-abort errors unwrapped (no false-positive timeout)', async () => {
    const failing = async () => {
      throw new Error('upstream 500');
    };
    await expect(withTimeout(failing, 1000, 'openai', 'gpt-4o')).rejects.toThrow('upstream 500');
  });

  it('clears the timer when the inner call resolves quickly', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(async () => 42, 5000, 'p', 'm');
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('withRetry + LLMTimeoutError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on LLMTimeoutError until success', async () => {
    let attempt = 0;
    const fn = async () => {
      attempt += 1;
      if (attempt < 3) throw new LLMTimeoutError('openrouter', 'deepseek/x', 90_000);
      return 'eventually-ok';
    };
    // Attach a settled handler BEFORE timers drain so no rejection bubbles
    // up as unhandled mid-flight (intermediate attempts throw before the
    // final attempt resolves).
    let resolved: unknown;
    let rejected: unknown;
    const promise = withRetry(fn, {
      provider: 'openrouter',
      model: 'deepseek/x',
      baseDelayMs: 10,
      maxRetries: 3,
    }).then(
      (v) => (resolved = v),
      (e) => (rejected = e),
    );
    await vi.runAllTimersAsync();
    await promise;
    expect(rejected).toBeUndefined();
    expect(resolved).toBe('eventually-ok');
    expect(attempt).toBe(3);
  });

  it('stops at maxRetries when timeouts persist (RetryExhaustedError wraps last)', async () => {
    const fn = async () => {
      throw new LLMTimeoutError('openrouter', 'deepseek/x', 90_000);
    };
    let captured: unknown;
    const promise = withRetry(fn, {
      provider: 'openrouter',
      model: 'deepseek/x',
      baseDelayMs: 10,
      maxRetries: 1,
    }).catch((e) => {
      captured = e;
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(captured).toMatchObject({
      code: 'retry_exhausted',
    });
    expect((captured as { underlyingCause: { code: string } }).underlyingCause.code).toBe(
      'llm_timeout',
    );
  });
});
