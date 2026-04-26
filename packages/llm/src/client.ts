// @nodalai/llm — client factory

import { generateText, streamText, generateObject } from 'ai';
import type { CoreMessage, LanguageModel } from 'ai';

import type { ProviderConfig, NodalLlmClient, ProviderCapabilities } from './types.js';
import { ProviderConfigError } from './errors.js';
import { CAPABILITY_MATRIX } from './providers/registry.js';
import { validateMessageStructure } from './message-structure.js';
import { withRetry } from './retry.js';

import { buildAnthropicModel } from './providers/anthropic.js';
import { buildOpenAIModel } from './providers/openai.js';
import { buildOllamaModel } from './providers/ollama.js';
import { buildOpenAICompatibleModel } from './providers/openai-compatible.js';
import { buildGoogleModel } from './providers/google.js';
import { buildMistralModel } from './providers/mistral.js';
import { buildGroqModel } from './providers/groq.js';
import { buildOpenRouterModel } from './providers/openrouter.js';

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
 * Validation only runs when CoreMessage[] messages are provided.
 * Omit<Message, 'id'>[] (useChat format) is passed through without validation —
 * those are legacy messages and not produced by our orchestrators.
 */
function validateIfMessages(args: { messages?: unknown }): void {
  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  // Only validate if the first message looks like a CoreMessage (has role + content)
  const first = messages[0] as Record<string, unknown> | undefined;
  if (first && typeof first['role'] === 'string' && 'content' in first) {
    validateMessageStructure(messages as CoreMessage[]);
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
    return withRetry(() => generateText({ ...args, model }), retryOpts);
  };

  const clientStreamText: NodalLlmClient['streamText'] = (args) => {
    validateIfMessages(args as { messages?: unknown });
    // streamText returns a StreamTextResult synchronously (not a Promise)
    return streamText({ ...args, model });
  };

  const clientGenerateObject: NodalLlmClient['generateObject'] = async (args) => {
    validateIfMessages(args as { messages?: unknown });
    return withRetry(
      () => generateObject({ ...args, model } as Parameters<typeof generateObject>[0]),
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
