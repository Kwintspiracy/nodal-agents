// @nodal-agents/llm — error classes

// ─── QuotaExhaustedError ───────────────────────────────────────────────────────

/**
 * Raised when the LLM provider returns a billing/quota 429.
 * Workers must NOT self-chain — fail the job immediately.
 * Distinguished from a transient rate-limit 429 via body heuristic.
 */
export class QuotaExhaustedError extends Error {
  readonly code = 'quota_exhausted' as const;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly reason: string,
  ) {
    super(`Quota exhausted: ${provider}/${model}: ${reason}`);
    this.name = 'QuotaExhaustedError';
  }
}

// ─── MessageStructureError ─────────────────────────────────────────────────────

export type MessageStructureErrorCode =
  | 'unmatched_tool_use'
  | 'duplicate_tool_use_id'
  | 'unresolved_tail'
  | 'missing_tool_result_content';

/**
 * Raised by validateMessageStructure() when the conversation history violates
 * tool-use invariants before a POST to the LLM.
 * Workers must NOT self-chain — fix the orchestrator, not the LLM client.
 */
export class MessageStructureError extends Error {
  readonly code: MessageStructureErrorCode;
  readonly context: Record<string, unknown>;

  constructor(code: MessageStructureErrorCode, context: Record<string, unknown>) {
    super(`Message structure violation [${code}]: ${JSON.stringify(context)}`);
    this.name = 'MessageStructureError';
    this.code = code;
    this.context = context;
  }
}

// ─── LLMTimeoutError ──────────────────────────────────────────────────────────

/**
 * Raised when a LLM call exceeds its timeout window. Retryable — the next
 * attempt gets a fresh timeout, so transient provider hangs (e.g. OpenRouter
 * spike) recover automatically. Without this, a stuck fetch hangs the job for
 * 5 minutes until `resetOrphanedJobs` cron tick gives up (caught live
 * 2026-05-15).
 */
export class LLMTimeoutError extends Error {
  readonly code = 'llm_timeout' as const;
  /**
   * Which clock fired (#440). `wall` = the fixed budget of a non-streamed
   * call; the three others belong to a streamed turn (`turn-clocks.ts`).
   */
  readonly reason: LlmTimeoutReason;
  /**
   * Text the model had written when the clock fired. Empty for a non-streamed
   * call (nothing comes back before the end) and for a stream that never
   * spoke. Non-empty means the call was cut WHILE PRODUCING: the runner
   * resumes from it instead of replaying the turn (#441).
   */
  readonly partialText: string;
  /**
   * True when the call can be RESUMED from `partialText`: the model wrote
   * text and nothing else. A call that had already emitted a tool call is not
   * resumable — the text alone would drop the call — and is replayed instead.
   */
  readonly resumable: boolean;
  /**
   * True when the provider SERVED the call before it was cut: it had sent
   * text, reasoning or a tool call. Such a call was billed, is counted by the
   * caller, and is never failed over — even with no text to resume from
   * (Codex review of #449, pass 6: a tool-call-only cut looked silent).
   */
  readonly served: boolean;
  /**
   * Characters the model generated before the cut: text, reasoning and tool
   * arguments. The provider bills them all, so the caller's usage estimate
   * reads this, not the visible text alone (Codex review of #449, pass 7).
   */
  readonly generatedChars: number;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly timeoutMs: number,
    details: {
      reason: LlmTimeoutReason;
      partialText: string;
      resumable?: boolean;
      /** The provider had sent something (text, reasoning, tool call). */
      served?: boolean;
      /** Everything generated before the cut (text, reasoning, tool args). */
      generatedChars?: number;
      /** The stream error behind a `stream_error` cut. */
      cause?: unknown;
    } = {
      reason: 'wall',
      partialText: '',
    },
  ) {
    super(
      details.reason === 'wall'
        ? `LLM call timed out after ${timeoutMs}ms: ${provider}/${model}`
        : details.reason === 'stream_error'
          ? `LLM stream broke after ${details.partialText.length} chars received (${details.cause instanceof Error ? details.cause.message.slice(0, 160) : String(details.cause).slice(0, 160)}): ${provider}/${model}`
          : `LLM call timed out after ${timeoutMs}ms (${details.reason}, ${details.partialText.length} chars received): ${provider}/${model}`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'LLMTimeoutError';
    this.reason = details.reason;
    this.partialText = details.partialText;
    this.resumable = details.resumable ?? details.partialText !== '';
    this.served = details.served ?? details.partialText !== '';
    this.generatedChars = details.generatedChars ?? details.partialText.length;
  }
}

export type LlmTimeoutReason =
  | 'wall'
  | 'idle_before_first_token'
  | 'idle_between_tokens'
  | 'absolute'
  /**
   * Not a clock: the stream broke with an error AFTER writing text. Carried
   * on the same error so the whole cut path (no replay from scratch, no
   * failover, resume from the text) applies to it unchanged.
   */
  | 'stream_error';

// ─── LLMCallCancelledError ─────────────────────────────────────────────────────

/**
 * The caller aborted the call (the job was cancelled: a person pressed Stop).
 * Never retried, never failed over: nobody wants the answer any more. Carries
 * what the model had written, so the cancelled job keeps it.
 */
export class LLMCallCancelledError extends Error {
  readonly code = 'llm_call_cancelled' as const;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly partialText: string,
    /** The provider had sent something before the Stop: the call was billed. */
    public readonly served: boolean = partialText !== '',
    /** Everything generated before the Stop (text, reasoning, tool args). */
    public readonly generatedChars: number = partialText.length,
  ) {
    super(`LLM call cancelled after ${partialText.length} chars received: ${provider}/${model}`);
    this.name = 'LLMCallCancelledError';
  }
}

// ─── RetryExhaustedError ───────────────────────────────────────────────────────

/**
 * Raised when withRetry() exhausts all attempts.
 *
 * The message includes a summary of the last underlying error so it survives
 * downstream layers that only persist `error.message` (notably our
 * `agent_jobs.error` column populated by `failJob`). Without this, every live
 * retry-exhausted failure stored the same opaque "Retry exhausted after N
 * attempts" with zero clue whether the underlying cause was an abort/timeout,
 * a 5xx, a fetch failure, or something else — and we wasted three patch cycles
 * speculating instead of measuring.
 */
export class RetryExhaustedError extends Error {
  readonly code = 'retry_exhausted' as const;
  readonly underlyingCause: unknown;

  constructor(attempts: number, underlyingCause: unknown) {
    super(
      `Retry exhausted after ${attempts} attempts; last: ${formatCauseSummary(underlyingCause)}`,
    );
    this.name = 'RetryExhaustedError';
    this.underlyingCause = underlyingCause;
    if (underlyingCause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${underlyingCause.stack}`;
    }
  }
}

// ─── AllProvidersFailedError ───────────────────────────────────────────────────

/**
 * Raised by the failover client when EVERY provider in the configured chain
 * (primary + fallbacks) failed with a transient/availability error (5xx
 * exhausted, timeout, or quota). This is the loud, opt-in failure surface:
 * the user explicitly configured a fallback chain, so reaching this means the
 * whole chain is down — not a silent smart fallback. The last underlying cause
 * is summarised into the message so `agent_jobs.error` stays actionable.
 */
export class AllProvidersFailedError extends Error {
  readonly code = 'all_providers_failed' as const;
  readonly underlyingCause: unknown;

  constructor(providerCount: number, underlyingCause: unknown) {
    super(
      `All ${providerCount} LLM providers failed; last: ${formatCauseSummary(underlyingCause)}`,
    );
    this.name = 'AllProvidersFailedError';
    this.underlyingCause = underlyingCause;
    if (underlyingCause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${underlyingCause.stack}`;
    }
  }
}

function formatCauseSummary(cause: unknown): string {
  if (cause instanceof Error) {
    const name = cause.name || 'Error';
    const msg = (cause.message || '').slice(0, 160);
    return `${name}: ${msg}`;
  }
  return String(cause).slice(0, 160);
}

// ─── ProviderConfigError ───────────────────────────────────────────────────────

/**
 * Raised when a ProviderConfig is invalid (missing required fields, unknown provider).
 */
export class ProviderConfigError extends Error {
  readonly code = 'provider_config_error' as const;

  constructor(public readonly detail: string) {
    super(`Provider config error: ${detail}`);
    this.name = 'ProviderConfigError';
  }
}

// ─── Context-window overflow detection (É-3) ───────────────────────────────────

/**
 * Best-effort classifier: does this provider error mean the prompt exceeded the
 * model's context window? Matches the phrasing the major providers and local
 * runtimes (LM Studio/Ollama) use. É-3 garde: when a model's real window is
 * smaller than configured, compaction can't save it — so instead of a silent
 * death we surface this LOUD with an actionable message (set the window in the
 * LLM provider settings). Substring match on the message is deliberately broad;
 * a false positive only changes the error label, never the fact that it failed.
 */
export function isContextOverflowError(err: unknown): boolean {
  // Read to the end: an overflow phrase can sit far into a provider message.
  const msg = (err === undefined || err === null ? '' : describeThrown(err, 100_000)).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('context length') ||
    msg.includes('context window') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context') ||
    msg.includes('exceed context') ||
    msg.includes('exceeds context') ||
    msg.includes('prompt is too long') ||
    msg.includes('too many tokens') ||
    (msg.includes('reduce') && msg.includes('length') && msg.includes('token'))
  );
}

// ─── Stream error parts that are not Error objects (#478) ─────────────────────

/**
 * What a provider sent as an error part of a stream, when it was not an
 * `Error`. OpenRouter forwards an upstream failure mid-stream as a plain object
 * (`{ error: { code, message } }` or `{ code, message }`), and the AI SDK hands
 * it on untouched. Thrown as is, it was logged as `[object Object]`, classified
 * `unknown`, never retried, and the job failed as `unknown_error` with no
 * reason (jobs c71d90f1 and 0afde65b, 24/09). Wrapped here, the message and
 * the HTTP-like code survive, so the retry policy and the context-overflow
 * check can read them.
 */
export class LLMStreamPartError extends Error {
  /** The code the provider gave, when it is an HTTP status (retry.ts reads it). */
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    statusCode: number | undefined,
    /** The value the stream carried, untouched. */
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = 'LLMStreamPartError';
    this.statusCode = statusCode;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function httpLike(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/**
 * A thrown value, said in words: an `Error`'s message, else what the object
 * carries (`message`, `error.message`, and a string or number `code`). Capped:
 * it goes into logs and into `llm_calls.error`. Never `[object Object]`.
 *
 * Never the object itself (review of PR #479): a gateway can echo the request
 * (the prompt, headers) in its error, and that must not land in logs or the
 * database. Without a message, only the object's keys are said.
 */
export function describeThrown(value: unknown, max = 500): string {
  if (value instanceof Error) return value.message.slice(0, max);
  const record = asRecord(value);
  if (record) {
    const inner = asRecord(record['error']);
    const message = inner?.['message'] ?? record['message'];
    const rawCode = inner?.['code'] ?? record['code'] ?? record['status'];
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined;
    if (typeof message === 'string' && message !== '') {
      return (code !== undefined ? `${String(code)}: ${message}` : message).slice(0, max);
    }
    return `object with keys: ${Object.keys(record).join(', ')}`.slice(0, max);
  }
  return String(value).slice(0, max);
}

/** An error part of a stream, as an `Error` the rest of the client can read. */
export function streamPartError(value: unknown): Error {
  if (value instanceof Error) return value;
  const record = asRecord(value);
  const inner = asRecord(record?.['error']);
  const statusCode =
    httpLike(inner?.['code']) ??
    httpLike(inner?.['status']) ??
    httpLike(record?.['code']) ??
    httpLike(record?.['status']) ??
    httpLike(record?.['statusCode']);
  return new LLMStreamPartError(describeThrown(value), statusCode, value);
}
