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
// 504 = Gateway Timeout (reverse-proxy/gateway gave up waiting on the upstream — transient,
//   same family as 502/503; audit#2 M-13. Was missing, so a transient gateway timeout failed
//   the call outright instead of retrying.)
// 529 = Overloaded (Anthropic/MiniMax native — transient capacity pressure, not a quota)
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

// ─── Rate-limit (capacity) retry policy ───────────────────────────────────────
//
// 429/529 mean the provider is out of capacity RIGHT NOW — a congestion that
// resolves on the minute scale, not the network-blip scale the generic 1/2/4s
// backoff was built for. Job 47d651c2 (2026-07-17) died exactly there: 4
// attempts in ~7s against an upstream throttle that needed minutes.
//
// Policy (constants match Hermes, conversation_loop.py:4121-4146):
//  - Honor the Retry-After header when present, capped at 600s. Hermes #26293:
//    a 120s cap retried before Anthropic Tier-1's ~171s bucket reset and
//    re-tripped the limit; 600s covers realistic reset windows while rejecting
//    pathological values.
//  - No header → jittered exponential backoff, base 2s, capped at 60s/attempt.
//  - Cumulative wait budget so repeated large Retry-After values can't pin a
//    job for tens of minutes — beyond it, exhaust loudly.
//
// Articulation with failover (Nodal-specific, no Hermes equivalent): when the
// agent HAS a fallback provider configured (`hasFallback`), out-waiting the
// congestion is the wrong move — the backup can serve NOW. One quick retry at
// most, and any wait longer than FALLBACK_MAX_WAIT_MS exhausts immediately so
// failover.ts takes over.
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const RETRY_AFTER_CAP_MS = 600_000;
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_TOTAL_WAIT_BUDGET_MS = 900_000;
const FALLBACK_MAX_WAIT_MS = 5_000;
const FALLBACK_RATE_LIMIT_MAX_RETRIES = 1;

/**
 * Rate-limit/capacity class: 429, 529, or an explicit rate-limit message when
 * the transport didn't surface a status (some gateways wrap the upstream 429
 * in a 200-with-error-body that the SDK rethrows without a status).
 */
function isRateLimitClass(err: unknown, status: number | null): boolean {
  if (status === 429 || status === 529) return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('rate limit') || msg.includes('rate-limited') || msg.includes('rate_limit');
}

/**
 * Extract a numeric Retry-After (in ms) from the error or its cause chain.
 * AI SDK's APICallError exposes `responseHeaders`; wrapped errors keep it on
 * the cause. Numeric seconds only (like Hermes) — HTTP-date values are rare on
 * LLM APIs and a misparsed date is worse than falling back to backoff.
 */
function getRetryAfterMs(err: unknown): number | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    const headers = (cur as { responseHeaders?: unknown }).responseHeaders;
    if (headers && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === 'retry-after' && typeof value === 'string') {
          const seconds = Number(value);
          if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        }
      }
    }
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return null;
}

/**
 * Determines if an error is a billing/quota-exhausted 429 vs a transient
 * rate-limit 429 that should be retried.
 *
 * Heuristic: inspect the message for billing/quota keywords.
 * Conservative — returns false if the message doesn't match known patterns.
 *
 * 'rate limit exceeded' is deliberately NOT in this list: it's the literal,
 * generic phrasing providers (OpenRouter, Groq, ...) use for an ordinary
 * per-minute throttle, which is transient and must go through the normal
 * retryable 429 path. Only real quota/billing terms mark a 429 as fatal.
 */
function isQuotaError(err: unknown, provider: string, model: string): boolean {
  const msg = errorMessage(err).toLowerCase();
  const quotaKeywords = ['quota', 'billing', 'insufficient', 'credit'];
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
  /**
   * True when this client sits in a failover chain with at least one provider
   * AFTER it. Rate-limit waits are then capped short (FALLBACK_MAX_WAIT_MS) so
   * the chain fails over to the backup instead of out-waiting the congestion.
   * The LAST provider of a chain (and a chainless client) keeps the patient
   * policy — waiting is its only remaining card.
   */
  hasFallback?: boolean;
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
  const hasFallback = options.hasFallback ?? false;

  let lastErr: unknown;
  const start = Date.now();
  let attempts = 0; // total fn() calls made
  let genericRetries = 0; // retries spent on the generic (network/5xx) path
  let rateLimitRetries = 0; // retries spent on the rate-limit (429/529) path
  let rateLimitWaitMs = 0; // cumulative sleep on the rate-limit path

  const exhaust = (): never => {
    const totalMs = Date.now() - start;
    console.warn(
      `[llm-retry-exhausted] provider=${provider} model=${model} attempts=${attempts} total_ms=${totalMs}`,
    );
    throw new RetryExhaustedError(attempts, lastErr);
  };

  for (;;) {
    attempts++;
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

      const rateLimited = isRateLimitClass(err, status);
      const retryBudget = rateLimited
        ? hasFallback
          ? FALLBACK_RATE_LIMIT_MAX_RETRIES
          : RATE_LIMIT_MAX_RETRIES
        : maxRetries;

      // Log the attempt outcome so live failures carry diagnosable info.
      // Without this, RetryExhaustedError stored only "Retry exhausted after N
      // attempts" and we burnt 3 patch cycles speculating on the cause.
      logAttempt({
        attempt: attempts,
        of: retryBudget + 1,
        provider,
        model,
        ms: attemptMs,
        err,
      });

      lastErr = err;

      if (rateLimited) {
        if (rateLimitRetries >= retryBudget) exhaust();
        const retryAfterMs = getRetryAfterMs(err);
        // Retry-After is exact — no jitter; computed backoff gets 0–500ms jitter.
        const delay =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
            : Math.min(
                RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries),
                RATE_LIMIT_MAX_DELAY_MS,
              ) +
              Math.random() * 500;
        // With a fallback behind us, a long wait is worse than failing over.
        if (hasFallback && delay > FALLBACK_MAX_WAIT_MS) exhaust();
        if (rateLimitWaitMs + delay > RATE_LIMIT_TOTAL_WAIT_BUDGET_MS) exhaust();
        console.warn(
          `[llm-rate-limited] provider=${provider} model=${model} ` +
            `waiting_ms=${Math.round(delay)} source=${retryAfterMs !== null ? 'retry-after' : 'backoff'} ` +
            `attempt=${rateLimitRetries + 1}/${retryBudget}`,
        );
        rateLimitWaitMs += delay;
        rateLimitRetries++;
        await sleep(delay);
        continue;
      }

      // Non-retryable HTTP error
      if (!isRetryableError(err)) throw err;

      if (genericRetries >= maxRetries) exhaust();
      const jitter = Math.random() * 500; // 0–500ms jitter
      const delay = baseDelayMs * Math.pow(2, genericRetries) + jitter;
      genericRetries++;
      await sleep(delay);
    }
  }
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
