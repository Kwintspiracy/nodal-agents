// @nodalai/llm — retry with exponential backoff + jitter
// Ports retry_with_backoff from AgentOne/agent/resilience.py

import { QuotaExhaustedError, MessageStructureError, RetryExhaustedError } from './errors';

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503]);

/**
 * Determines if an error is a billing/quota-exhausted 429 vs a transient
 * rate-limit 429 that should be retried.
 *
 * Heuristic: inspect the message for billing/quota keywords.
 * Conservative — returns false if the message doesn't match known patterns.
 */
function isQuotaError(err: unknown, provider: string, model: string): boolean {
  const msg = errorMessage(err).toLowerCase();
  const quotaKeywords = ['quota', 'billing', 'insufficient', 'rate limit exceeded', 'credit'];
  return quotaKeywords.some((kw) => msg.includes(kw))
    ? (() => {
        throw new QuotaExhaustedError(provider, model, msg);
      })()
    : false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getStatusCode(err: unknown): number | null {
  if (err instanceof Error && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  if (err instanceof Error && 'statusCode' in err) {
    const s = (err as { statusCode: unknown }).statusCode;
    if (typeof s === 'number') return s;
  }
  return null;
}

function isRetryableError(err: unknown): boolean {
  const status = getStatusCode(err);
  if (status !== null) {
    return RETRYABLE_HTTP_STATUSES.has(status);
  }
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.) are retryable
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  );
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Provider name for QuotaExhaustedError context */
  provider?: string;
  /** Model name for QuotaExhaustedError context */
  model?: string;
}

/**
 * Calls fn() and retries on transient errors with exponential backoff + jitter.
 *
 * NEVER retries:
 * - MessageStructureError (structural bug — will fail again deterministically)
 * - QuotaExhaustedError (billing depleted — more calls won't help)
 * - Non-retryable HTTP errors (4xx except 429)
 *
 * @param fn          Zero-argument async function to execute
 * @param options     Retry configuration
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const provider = options.provider ?? 'unknown';
  const model = options.model ?? 'unknown';

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Non-retryable by class — fail immediately
      if (err instanceof MessageStructureError) throw err;
      if (err instanceof QuotaExhaustedError) throw err;

      // 429: check if it's a quota error first (throws QuotaExhaustedError if so)
      const status = getStatusCode(err);
      if (status === 429) {
        isQuotaError(err, provider, model);
      }

      // Non-retryable HTTP error
      if (!isRetryableError(err)) throw err;

      lastErr = err;

      if (attempt < maxRetries) {
        const jitter = Math.random() * 500; // 0–500ms jitter
        const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
        await sleep(delay);
      }
    }
  }

  throw new RetryExhaustedError(maxRetries + 1, lastErr);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
