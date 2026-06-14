// @nodal-agents/llm — retry with exponential backoff + jitter
// Ports retry_with_backoff from AgentOne/agent/resilience.py

import {
  QuotaExhaustedError,
  MessageStructureError,
  RetryExhaustedError,
  LLMTimeoutError,
} from './errors';

// 429 = transient rate-limit (billing 429 is caught before this set, see isQuotaError)
// 500/502/503 = upstream server errors (transient)
// 408 = Request Timeout (transport/gateway timeout — transient, different from our AbortSignal timeout)
// 529 = Overloaded (Anthropic/MiniMax native — transient capacity pressure, not a quota)
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 529]);

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
  // LLMTimeoutError is NOT retryable: if we waited the full per-call budget
  // (default 300s, matching Hermes' `_compute_non_stream_stale_timeout`) and
  // got nothing back, retrying spends another 300s for the same outcome on
  // the same prompt. Surface the timeout to the caller (orchestrator) so it
  // can take an actual decision — notify the user, switch model, give up.
  // Hermes' transport never retries on its stale timeout for the same reason.
  if (err instanceof LLMTimeoutError) return false;

  const msg = errorMessage(err).toLowerCase();

  // Malformed / unparseable provider response. The provider returned a body the
  // SDK couldn't read as JSON (truncated stream, transient encoding glitch, or a
  // non-JSON error page). Checked BEFORE the status gate because the status code
  // is unreliable here — a 200 with a corrupted body is common, and the SDK then
  // computes isRetryable=false. These are almost always transient at the
  // transport layer, so a bounded retry clears them. Live trigger: JobHunter job
  // baee450d (2026-06-04) died at turn 3 on a single such blip with no retry.
  if (
    msg.includes('invalid json response') ||
    msg.includes('unexpected end of json') ||
    msg.includes('unexpected token')
  ) {
    return true;
  }

  // Honor the AI SDK's own retryability verdict when it carries one. APICallError
  // flags 408/409/429/5xx and provider-specific transient cases as retryable; we
  // trust that signal rather than re-deriving it.
  if (err instanceof Error && (err as { isRetryable?: unknown }).isRetryable === true) {
    return true;
  }

  const status = getStatusCode(err);
  if (status !== null) {
    return RETRYABLE_HTTP_STATUSES.has(status);
  }
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.) are retryable.
  // 'socket hang up' and 'econnreset' cover dropped native connections
  // common on DeepSeek/MiniMax direct endpoints under load.
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset')
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
  const start = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    try {
      return await fn();
    } catch (err) {
      const attemptMs = Date.now() - attemptStart;

      // Non-retryable by class — fail immediately
      if (err instanceof MessageStructureError) throw err;
      if (err instanceof QuotaExhaustedError) throw err;

      // 429: check if it's a quota error first (throws QuotaExhaustedError if so)
      const status = getStatusCode(err);
      if (status === 429) {
        isQuotaError(err, provider, model);
      }

      // Log the attempt outcome so live failures carry diagnosable info.
      // Without this, RetryExhaustedError stored only "Retry exhausted after N
      // attempts" and we burnt 3 patch cycles speculating on the cause.
      logAttempt({
        attempt: attempt + 1,
        of: maxRetries + 1,
        provider,
        model,
        ms: attemptMs,
        err,
      });

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

  const totalMs = Date.now() - start;
  console.warn(
    `[llm-retry-exhausted] provider=${provider} model=${model} attempts=${maxRetries + 1} total_ms=${totalMs}`,
  );
  throw new RetryExhaustedError(maxRetries + 1, lastErr);
}

function logAttempt({
  attempt,
  of,
  provider,
  model,
  ms,
  err,
}: {
  attempt: number;
  of: number;
  provider: string;
  model: string;
  ms: number;
  err: unknown;
}): void {
  const errName = err instanceof Error ? err.name : 'unknown';
  const errMsg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const causeName = cause instanceof Error ? cause.name : undefined;
  const causeMsg = cause instanceof Error ? cause.message.slice(0, 160) : undefined;
  const statusCode = getStatusCode(err);
  const parts = [
    `provider=${provider}`,
    `model=${model}`,
    `attempt=${attempt}/${of}`,
    `ms=${ms}`,
    `err=${errName}`,
    `msg=${JSON.stringify(errMsg)}`,
  ];
  if (statusCode !== null) parts.push(`status=${statusCode}`);
  if (causeName) parts.push(`causeName=${causeName}`);
  if (causeMsg) parts.push(`causeMsg=${JSON.stringify(causeMsg)}`);
  console.warn(`[llm-attempt-failed] ${parts.join(' ')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
