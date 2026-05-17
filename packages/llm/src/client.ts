// @nodal-agents/llm — client factory

import { generateText, streamText, generateObject } from 'ai';
import type { ModelMessage, LanguageModel } from 'ai';

import type { ProviderConfig, NodalLlmClient, ProviderCapabilities } from './types';
import { ProviderConfigError, LLMTimeoutError } from './errors';
import { CAPABILITY_MATRIX } from './providers/registry';
import { validateMessageStructure } from './message-structure';
import { withRetry } from './retry';

import { buildAnthropicModel } from './providers/anthropic';
import { buildOpenAIModel } from './providers/openai';
import { buildOllamaModel } from './providers/ollama';
import { buildOpenAICompatibleModel } from './providers/openai-compatible';
import { buildGoogleModel } from './providers/google';
import { buildMistralModel } from './providers/mistral';
import { buildGroqModel } from './providers/groq';
import { buildOpenRouterModel } from './providers/openrouter';

// ─── Timeout config ───────────────────────────────────────────────────────────

/**
 * Per-call timeout for non-streaming LLM ops. 90s covers slow reasoning models
 * (o-series, sonnet-thinking) while preventing the multi-minute hangs reported
 * live on 2026-05-15 (OpenRouter spike) and 2026-05-18 (DeepSeek V4 Pro 213s).
 * Override via env `LLM_TIMEOUT_MS` for exceptionally long-running providers.
 *
 * Implementation note: we pass this as AI SDK v6's native `timeout` parameter
 * (uses `AbortSignal.timeout()` internally) rather than building our own
 * AbortController. A previous custom-wrapper version (commit `2bb36ec`) did not
 * fire in practice because AI SDK's internal retry (`maxRetries: 2` default)
 * absorbed the aborted attempts as transient errors and retried 3 times per
 * outer attempt — total wall time 213s × 4 retries ≈ 850s before bubbling up.
 * Pairing native timeout with `maxRetries: 0` makes the budget deterministic.
 */
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const LLM_TIMEOUT_MS = (() => {
  const raw = process.env['LLM_TIMEOUT_MS'];
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_TIMEOUT_MS;
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
 * 2. AI SDK native `timeout` + `maxRetries: 0` (our `withRetry` owns retries)
 * 3. withRetry() wrapping (exponential backoff, quota detection, LLMTimeoutError retryable)
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

  const callWithTimeout = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isAbortOrTimeoutError(err)) {
        throw new LLMTimeoutError(config.provider, config.model, LLM_TIMEOUT_MS);
      }
      throw err;
    }
  };

  const clientGenerateText: NodalLlmClient['generateText'] = async (args) => {
    validateIfMessages(args as { messages?: unknown });
    return withRetry(
      () =>
        callWithTimeout(() =>
          generateText({
            ...args,
            model,
            // AI SDK native timeout via AbortSignal.timeout(). Survives middleware
            // wrapping unlike a passed-in abortSignal which their internal retry
            // can swallow.
            timeout: LLM_TIMEOUT_MS,
            // Disable AI SDK internal retry — we own retries via withRetry to
            // preserve typed error handling (Quota/MessageStructure/LLMTimeout).
            maxRetries: 0,
          } as Parameters<typeof generateText>[0]),
        ),
      retryOpts,
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
        callWithTimeout(() =>
          generateObject({
            ...args,
            model,
            timeout: LLM_TIMEOUT_MS,
            maxRetries: 0,
          } as Parameters<typeof generateObject>[0]),
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
