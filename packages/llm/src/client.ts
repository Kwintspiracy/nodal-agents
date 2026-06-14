// @nodal-agents/llm — client factory

import { generateText, streamText, generateObject } from 'ai';
import type { ModelMessage, LanguageModel } from 'ai';

import type { ProviderConfig, NodalLlmClient, ProviderCapabilities } from './types';
import { ProviderConfigError, LLMTimeoutError } from './errors';
import { CAPABILITY_MATRIX } from './providers/registry';
import { validateMessageStructure } from './message-structure';
import { withRetry } from './retry';
import { generateWithToolChoiceFloor } from './tool-choice-floor';

import { buildAnthropicModel } from './providers/anthropic';
import { withAnthropicPromptCaching } from './providers/anthropic-cache';
import { buildOpenAIModel } from './providers/openai';
import { buildOllamaModel } from './providers/ollama';
import { buildOpenAICompatibleModel } from './providers/openai-compatible';
import { buildGoogleModel } from './providers/google';
import { buildMistralModel } from './providers/mistral';
import { buildGroqModel } from './providers/groq';
import { buildOpenRouterModel } from './providers/openrouter';
import { buildDeepSeekModel } from './providers/deepseek';
import { buildMiniMaxModel } from './providers/minimax';

// ─── Timeout config ───────────────────────────────────────────────────────────

/**
 * Per-call timeout for non-streaming LLM ops. 300s matches Hermes' default
 * `_compute_non_stream_stale_timeout` (run_agent.py:3394) which is the
 * reference behaviour for OpenRouter+DeepSeek stability — Hermes routinely
 * completes 50-200k-token prompts on DeepSeek V4 Pro that take 60-180s of
 * upstream model time. Our previous 90s default fired correctly (verified live
 * on job `fa2ea877`: `ms=90013`, `ms=90002` in the new instrumentation logs)
 * but aborted legitimate slow calls, leading to the user-visible "Retry
 * exhausted" pattern that "Hermes works with DeepSeek" was a direct rebuttal of.
 *
 * Override via env `LLM_TIMEOUT_MS` for providers that need a different
 * budget (LM Studio local can be < 60s; some heavy reasoning models may need
 * 600s like Hermes' large-prompt tier).
 *
 * Implementation note: we pass this as AI SDK v6's native `timeout` parameter
 * (uses `AbortSignal.timeout()` internally) with `maxRetries: 0` so the budget
 * is deterministic — AI SDK's internal retry is disabled and our `withRetry`
 * owns retry semantics. The chain has been audited end-to-end on 2026-05-18
 * across `generateText` → `wrapLanguageModel` → middleware → openai-compatible
 * → postJsonToApi → fetch; the AbortSignal reaches the fetch boundary and the
 * timeout fires reliably at the configured budget.
 */
const DEFAULT_LLM_TIMEOUT_MS = 300_000;
const LLM_TIMEOUT_MS = (() => {
  const raw = process.env['LLM_TIMEOUT_MS'];
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_TIMEOUT_MS;
})();

/**
 * Number of additional fresh-connection attempts after a primary timeout.
 * Default 1 — a single stale-retry recovers transient transport hangs without
 * doubling the worst-case budget on every call. Override via LLM_TIMEOUT_RETRIES.
 */
const DEFAULT_LLM_TIMEOUT_RETRIES = 1;
const LLM_TIMEOUT_RETRIES = (() => {
  const raw = process.env['LLM_TIMEOUT_RETRIES'];
  if (!raw) return DEFAULT_LLM_TIMEOUT_RETRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LLM_TIMEOUT_RETRIES;
})();

/**
 * Timeout budget for each stale-retry attempt (fresh-connection retry after a
 * primary timeout). Shorter than LLM_TIMEOUT_MS so a genuinely-down provider
 * doesn't re-pay the full 300s budget on every retry.
 * Default 150 000ms (150s). Override via LLM_STALE_RETRY_TIMEOUT_MS.
 *
 * Worst-case total budget: LLM_TIMEOUT_MS + LLM_TIMEOUT_RETRIES × LLM_STALE_RETRY_TIMEOUT_MS
 * Default: 300s + 1×150s = 450s.
 */
const DEFAULT_LLM_STALE_RETRY_TIMEOUT_MS = 150_000;
const LLM_STALE_RETRY_TIMEOUT_MS = (() => {
  const raw = process.env['LLM_STALE_RETRY_TIMEOUT_MS'];
  if (!raw) return DEFAULT_LLM_STALE_RETRY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_STALE_RETRY_TIMEOUT_MS;
})();

/**
 * Recognise the abort error AI SDK throws when `AbortSignal.timeout()` fires.
 * The spec'd name is `TimeoutError`; older runtimes report `AbortError`; AI SDK
 * may wrap either in its own error class. We match by name on the error or any
 * `cause` chain entry, which catches both bare DOMExceptions and AI SDK
 * `RetryError` / `AISDKError` wrappers.
 */
export function isAbortOrTimeoutError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      const name = cur.name;
      if (name === 'TimeoutError' || name === 'AbortError') return true;
      const msg = cur.message ?? '';
      if (/aborted|timed?\s*out|timeout/i.test(msg) && !/quota|rate/i.test(msg)) {
        // Conservative: only treat generic abort/timeout text as timeout when
        // it doesn't look like a rate-limit response that mentioned a timeout
        // value in the message.
        return true;
      }
      const inner = (cur as { cause?: unknown }).cause;
      if (inner === cur) return false;
      cur = inner;
    } else {
      return false;
    }
  }
  return false;
}

// ─── Stale-call fresh-connection retry ────────────────────────────────────────

/**
 * Options for withStaleRetry — injected by unit tests to avoid real timers.
 * Production code uses the module-level constants (LLM_TIMEOUT_MS etc.).
 */
export interface StaleRetryOptions {
  /** Timeout for the primary attempt in ms (default: LLM_TIMEOUT_MS) */
  primaryTimeoutMs?: number;
  /** Timeout for each stale-retry attempt in ms (default: LLM_STALE_RETRY_TIMEOUT_MS) */
  retryTimeoutMs?: number;
  /** Max extra attempts after primary timeout (default: LLM_TIMEOUT_RETRIES) */
  maxRetries?: number;
  /** Provider label for log lines */
  provider?: string;
  /** Model label for log lines */
  model?: string;
}

/**
 * Wraps a timed LLM call with a fresh-connection retry when a timeout fires.
 *
 * Rationale: a primary call that hangs until the full LLM_TIMEOUT_MS budget
 * often indicates a transient transport stall (TCP keepalive delay, kernel
 * connection cache, upstream load-shedder). A fresh connection to the same
 * endpoint frequently recovers in < 30s. Without this, a single stale
 * connection forces a full failover to the next provider — wasting the primary
 * provider's remaining capacity and adding latency.
 *
 * Semantics (matching Hermes' `_compute_non_stream_stale_timeout` approach):
 *  - attempt 0: call fn(primaryTimeoutMs) — full budget preserved.
 *  - on timeout (isAbortOrTimeoutError): up to `maxRetries` more attempts,
 *    each with fn(retryTimeoutMs) and a console.warn log.
 *  - if ALL attempts timeout → throws LLMTimeoutError (same as today, so
 *    withRetry treats it as non-retryable → failover kicks in).
 *  - NON-timeout error → rethrown immediately (withRetry handles it; stale-
 *    retry is timeout-specific and must not suppress network/5xx errors).
 *
 * Unit testability: `fn` receives the per-attempt timeout so tests can
 * inspect it; inject a mock `fn` that throws/resolves on demand without
 * waiting for real timers.
 *
 * @param fn           Call fn that accepts a timeout in ms and returns a Promise<T>.
 * @param providerModel Provider+model label for LLMTimeoutError and log lines.
 * @param opts         Optional overrides (for tests / env-level customisation).
 */
export async function withStaleRetry<T>(
  fn: (timeoutMs: number) => Promise<T>,
  providerModel: { provider: string; model: string },
  opts: StaleRetryOptions = {},
): Promise<T> {
  const primaryMs = opts.primaryTimeoutMs ?? LLM_TIMEOUT_MS;
  const retryMs = opts.retryTimeoutMs ?? LLM_STALE_RETRY_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? LLM_TIMEOUT_RETRIES;
  const provider = opts.provider ?? providerModel.provider;
  const model = opts.model ?? providerModel.model;

  // attempt 0: primary call
  try {
    return await fn(primaryMs);
  } catch (primaryErr) {
    if (!isAbortOrTimeoutError(primaryErr)) {
      // Non-timeout: withRetry handles it — surface immediately
      throw primaryErr;
    }

    // Timeout on primary — enter stale-retry loop
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.warn(
        `[llm-stale-retry] provider=${provider} model=${model} attempt=${attempt}/${maxRetries} ` +
          `primaryTimeoutMs=${primaryMs} retryTimeoutMs=${retryMs}`,
      );
      try {
        return await fn(retryMs);
      } catch (retryErr) {
        if (!isAbortOrTimeoutError(retryErr)) {
          // Non-timeout surfaced on retry — propagate as-is
          throw retryErr;
        }
        // Timeout again — continue to next attempt or fall through to throw
      }
    }

    // All attempts timed out → LLMTimeoutError so failover takes over
    throw new LLMTimeoutError(provider, model, primaryMs);
  }
}

// ─── Model builder dispatch ────────────────────────────────────────────────────

function buildModel(config: ProviderConfig): LanguageModel {
  switch (config.provider) {
    case 'anthropic':
      return buildAnthropicModel(config);
    case 'openai':
      return buildOpenAIModel(config);
    case 'ollama':
      return buildOllamaModel(config);
    case 'openai-compatible':
      return buildOpenAICompatibleModel(config);
    case 'google':
      return buildGoogleModel(config);
    case 'mistral':
      return buildMistralModel(config);
    case 'groq':
      return buildGroqModel(config);
    case 'openrouter':
      return buildOpenRouterModel(config);
    case 'deepseek':
      return buildDeepSeekModel(config);
    case 'minimax':
      return buildMiniMaxModel(config);
    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.provider;
      throw new ProviderConfigError(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

// ─── Message structure helper ──────────────────────────────────────────────────

/**
 * Extract messages from the args object if present, and validate structure.
 * Validation only runs when ModelMessage[] messages are provided.
 * Omit<Message, 'id'>[] (useChat format) is passed through without validation —
 * those are legacy messages and not produced by our orchestrators.
 */
function validateIfMessages(args: { messages?: unknown }): void {
  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  // Only validate if the first message looks like a ModelMessage (has role + content)
  const first = messages[0] as Record<string, unknown> | undefined;
  if (first && typeof first['role'] === 'string' && 'content' in first) {
    validateMessageStructure(messages as ModelMessage[]);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a NodalLlmClient bound to a specific provider+model.
 * All calls go through:
 * 1. Message structure validation (throws MessageStructureError on violations)
 * 2. withStaleRetry() — primary call with AI SDK native timeout; on timeout,
 *    up to LLM_TIMEOUT_RETRIES fresh-connection re-attempts with a shorter
 *    budget (LLM_STALE_RETRY_TIMEOUT_MS) before surfacing LLMTimeoutError.
 * 3. withRetry() wrapping (exponential backoff, quota detection; LLMTimeoutError
 *    is non-retryable here — failover.ts picks it up).
 *
 * streamText is intentionally left without stale-retry (streaming timeout
 * semantics differ — a per-chunk budget is needed, not a total call budget).
 */
export function createLlmClient(config: ProviderConfig): NodalLlmClient {
  if (!config.provider) {
    throw new ProviderConfigError('provider is required');
  }
  if (!config.model) {
    throw new ProviderConfigError('model is required');
  }

  const model = buildModel(config);
  const capabilities: ProviderCapabilities = CAPABILITY_MATRIX[config.provider];

  const retryOpts = { provider: config.provider, model: config.model };
  const providerModel = { provider: config.provider, model: config.model };

  // Anthropic does NOT auto-cache — opt it in by annotating cache_control
  // breakpoints (system + sliding last message). Other providers either cache
  // transparently (DeepSeek/OpenRouter) or don't support it; they pass through
  // untouched. `cachingEnabled === false` is an explicit opt-out.
  const cachingOn =
    config.provider === 'anthropic' &&
    capabilities.promptCaching &&
    config.cachingEnabled !== false;

  const clientGenerateText: NodalLlmClient['generateText'] = async (args) => {
    validateIfMessages(args as { messages?: unknown });
    const toolChoice = (args as { toolChoice?: unknown }).toolChoice;
    const prepared = cachingOn ? withAnthropicPromptCaching(args) : args;
    // tool_choice floor: if the provider rejects a forced tool_choice value
    // (some OpenRouter routes reject it), retry once with 'auto' — logged.
    return generateWithToolChoiceFloor(
      (override) =>
        withRetry(
          () =>
            withStaleRetry(
              (timeoutMs) =>
                generateText({
                  ...prepared,
                  model,
                  ...(override ? { toolChoice: override } : {}),
                  // AI SDK native timeout via AbortSignal.timeout(). Survives
                  // middleware wrapping unlike a passed-in abortSignal which their
                  // internal retry can swallow. timeoutMs varies per attempt:
                  // LLM_TIMEOUT_MS for the primary, LLM_STALE_RETRY_TIMEOUT_MS
                  // for subsequent fresh-connection stale retries.
                  timeout: timeoutMs,
                  // Disable AI SDK internal retry — we own retries via withRetry to
                  // preserve typed error handling (Quota/MessageStructure/LLMTimeout).
                  maxRetries: 0,
                } as Parameters<typeof generateText>[0]),
              providerModel,
            ),
          retryOpts,
        ),
      toolChoice,
      `${config.provider}/${config.model}`,
    );
  };

  const clientStreamText: NodalLlmClient['streamText'] = (args) => {
    validateIfMessages(args as { messages?: unknown });
    // streamText returns a StreamTextResult synchronously (not a Promise).
    // Streaming semantics differ from generateText (timeout would have to be
    // per-chunk, not total) — left untouched here. Add when a streaming user
    // surfaces a hang in the wild.
    return streamText({ ...args, model } as Parameters<typeof streamText>[0]);
  };

  const clientGenerateObject: NodalLlmClient['generateObject'] = async (args) => {
    validateIfMessages(args as { messages?: unknown });
    return withRetry(
      () =>
        withStaleRetry(
          (timeoutMs) =>
            generateObject({
              ...args,
              model,
              timeout: timeoutMs,
              maxRetries: 0,
            } as Parameters<typeof generateObject>[0]),
          providerModel,
        ),
      retryOpts,
    );
  };

  return {
    config,
    capabilities,
    generateText: clientGenerateText,
    streamText: clientStreamText,
    generateObject: clientGenerateObject,
  };
}
