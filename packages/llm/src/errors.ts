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
 * 5 minutes until `resetOrphanedJobs` cron tick gives up (caught live 2026-05-15
 * job `2461d25b-83ca-4874-a43c-955e88807e07`).
 */
export class LLMTimeoutError extends Error {
  readonly code = 'llm_timeout' as const;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly timeoutMs: number,
  ) {
    super(`LLM call timed out after ${timeoutMs}ms: ${provider}/${model}`);
    this.name = 'LLMTimeoutError';
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
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
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
