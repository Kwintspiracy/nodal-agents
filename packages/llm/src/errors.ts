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
 * Wraps the last underlying error for inspection.
 */
export class RetryExhaustedError extends Error {
  readonly code = 'retry_exhausted' as const;
  readonly underlyingCause: unknown;

  constructor(attempts: number, underlyingCause: unknown) {
    super(`Retry exhausted after ${attempts} attempts`);
    this.name = 'RetryExhaustedError';
    this.underlyingCause = underlyingCause;
    if (underlyingCause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${underlyingCause.stack}`;
    }
  }
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
