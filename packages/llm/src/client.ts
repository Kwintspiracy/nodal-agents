// @nodal-agents/llm — client factory

import { generateText, streamText, generateObject } from 'ai';
import type { ModelMessage, LanguageModel } from 'ai';

import type { ProviderConfig, NodalLlmClient, ProviderCapabilities } from './types';
import { ProviderConfigError, LLMTimeoutError } from './errors';
import { CAPABILITY_MATRIX } from './providers/registry';
import { validateMessageStructure } from './message-structure';
import { withRetry } from './retry';

// ─── Timeout config ───────────────────────────────────────────────────────────

/**
 * Per-call timeout for non-streaming LLM ops. 90s covers slow reasoning models
 * (o-series, sonnet-thinking) while preventing the 5-min hang reported live on
 * 2026-05-15 (OpenRouter spike). Override via env `LLM_TIMEOUT_MS` for
 * exceptionally long-running providers.
 */
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const LLM_TIMEOUT_MS = (() => {
  const raw = process.env['LLM_TIMEOUT_MS'];
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LLM_TIMEOUT_MS;
})();

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  provider: string,
  model: string,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new LLMTimeoutError(provider, model, ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

import { buildAnthropicModel } from './providers/anthropic';
import { buildOpenAIModel } from './providers/openai';
import { buildOllamaModel } from './providers/ollama';
import { buildOpenAICompatibleModel } from './providers/openai-compatible';
import { buildGoogleModel } from './providers/google';
import { buildMistralModel } from './providers/mistral';
import { buildGroqModel } from './providers/groq';
import { buildOpenRouterModel } from './providers/openrouter';

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
 * 2. withRetry() wrapping (exponential backoff, quota detection)
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

  const clientGenerateText: NodalLlmClient['generateText'] = async (args) => {
    validateIfMessages(args as { messages?: unknown });
    return withRetry(
      () =>
        withTimeout(
          (signal) =>
            generateText({
              ...args,
              model,
              abortSignal: signal,
            } as Parameters<typeof generateText>[0]),
          LLM_TIMEOUT_MS,
          config.provider,
          config.model,
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
        withTimeout(
          (signal) =>
            generateObject({
              ...args,
              model,
              abortSignal: signal,
            } as Parameters<typeof generateObject>[0]),
          LLM_TIMEOUT_MS,
          config.provider,
          config.model,
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
