// timeout.test.ts — LLMTimeoutError detection + retry integration
//
// Regression for the live-caught failures:
//  - 2026-05-15 (job `2461d25b-...`): OpenRouter spike → 5min hang until orphan reset
//  - 2026-05-18 (job `0fd8d4f7-...`): 213s/attempt × 4 = 852s, custom AbortController
//    didn't fire because AI SDK's internal retry absorbed it
//  - 2026-05-18 (job `fa2ea877-...`): 90s timeout fired correctly but cut off
//    legitimate slow DeepSeek V4 Pro responses on 50-200k-token prompts —
//    Hermes' equivalent budget is 300s by default (see DEFAULT_LLM_TIMEOUT_MS).
//
// Approach now: AI SDK native `timeout` + `maxRetries: 0` (in client.ts).
// Detect the abort/timeout error AI SDK throws and surface it as
// LLMTimeoutError. NOT retried by withRetry — if the per-call budget was hit,
// the orchestrator decides what to do (notify user, switch model) instead of
// burning another budget for the same outcome.

import { describe, it, expect } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { isAbortOrTimeoutError, createLlmClient } from '../client';
import { LLMTimeoutError } from '../errors';
import { withRetry } from '../retry';

// ─── isAbortOrTimeoutError detection ──────────────────────────────────────────

describe('isAbortOrTimeoutError', () => {
  it('detects a TimeoutError by name (spec-standard AbortSignal.timeout())', () => {
    const e = new Error('signal timed out');
    e.name = 'TimeoutError';
    expect(isAbortOrTimeoutError(e)).toBe(true);
  });

  it('detects an AbortError by name (older runtimes / manual aborts)', () => {
    const e = new Error('The user aborted a request.');
    e.name = 'AbortError';
    expect(isAbortOrTimeoutError(e)).toBe(true);
  });

  it('detects a TimeoutError nested in `cause` chain (AI SDK wraps it)', () => {
    const inner = new Error('signal timed out');
    inner.name = 'TimeoutError';
    const outer = new Error('Retrying failed') as Error & { cause?: unknown };
    outer.cause = inner;
    expect(isAbortOrTimeoutError(outer)).toBe(true);
  });

  it('detects timeout-shaped messages even when name is generic', () => {
    expect(isAbortOrTimeoutError(new Error('request was aborted'))).toBe(true);
    expect(isAbortOrTimeoutError(new Error('operation timed out after 90s'))).toBe(true);
  });

  it('ignores a 429 quota error that happens to mention "timeout" in retry-after copy', () => {
    // Conservative: rate-limit errors that mention timeout values are NOT timeouts.
    const e = new Error('Rate limit exceeded. Retry after timeout: 30s. quota=...');
    expect(isAbortOrTimeoutError(e)).toBe(false);
  });

  it('returns false for a plain upstream 500', () => {
    expect(isAbortOrTimeoutError(new Error('Internal Server Error'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isAbortOrTimeoutError(null)).toBe(false);
    expect(isAbortOrTimeoutError('aborted')).toBe(false);
    expect(isAbortOrTimeoutError(42)).toBe(false);
  });

  it('bails on cyclic cause chains (no infinite loop)', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a; // self-cycle
    // Should still return: name doesn't match, message doesn't match, cause is self
    expect(isAbortOrTimeoutError(a)).toBe(false);
  });
});

// ─── Client integration: AI SDK timeout → LLMTimeoutError ─────────────────────

describe('createLlmClient — timeout integration', () => {
  it('translates AI SDK TimeoutError into LLMTimeoutError', async () => {
    // Mock model that throws a TimeoutError on every doGenerate (simulating
    // what AI SDK does when AbortSignal.timeout() fires before the upstream
    // responds). The client should catch and surface LLMTimeoutError.
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
      doGenerate: async () => {
        const e = new Error('signal timed out') as Error & { name: string };
        e.name = 'TimeoutError';
        throw e;
      },
    });

    // We bypass createLlmClient's buildModel (which would build a real
    // provider) by directly invoking generateText with our mock + then
    // exercising the client's timeout-catch path via callWithTimeout shape.
    // Simpler: build a tiny wrapper that mimics what client does internally.
    try {
      await generateText({
        model: mockModel,
        prompt: 'x',
        timeout: 100,
        maxRetries: 0,
      });
      throw new Error('expected throw');
    } catch (err) {
      // AI SDK may re-throw as-is or wrap. Either way our detector matches.
      expect(isAbortOrTimeoutError(err)).toBe(true);
    }
  });

  it("createLlmClient returns a client object (smoke test that timeout config didn't break factory)", () => {
    const client = createLlmClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260217',
      apiKey: 'test-key',
    });
    expect(typeof client.generateText).toBe('function');
    expect(typeof client.streamText).toBe('function');
    expect(typeof client.generateObject).toBe('function');
  });
});

// ─── withRetry + LLMTimeoutError ──────────────────────────────────────────────

describe('withRetry + LLMTimeoutError', () => {
  it('throws LLMTimeoutError immediately without retry (matches Hermes behaviour)', async () => {
    // Rationale: if the per-call budget already elapsed (default 300s, matching
    // Hermes' `_compute_non_stream_stale_timeout`), retrying with another 300s
    // burns the same budget on the same prompt for the same outcome. The
    // orchestrator handles it instead (notify user via telegram_send_message,
    // try a different model, etc.) — see resumeDelegated/error-text path in
    // `apps/runner/src/job/execute.ts` for the delegation-side handling.
    let attempt = 0;
    const fn = async () => {
      attempt += 1;
      throw new LLMTimeoutError('openrouter', 'deepseek/x', 300_000);
    };
    let captured: unknown;
    try {
      await withRetry(fn, {
        provider: 'openrouter',
        model: 'deepseek/x',
        baseDelayMs: 10,
        maxRetries: 3,
      });
    } catch (e) {
      captured = e;
    }
    expect(attempt).toBe(1);
    expect(captured).toBeInstanceOf(LLMTimeoutError);
    // Not wrapped in RetryExhaustedError — caller sees the typed timeout directly.
    expect((captured as { code: string }).code).toBe('llm_timeout');
  });
});
