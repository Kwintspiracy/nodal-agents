// @nodal-agents/llm — OpenRouter provider (OpenAI-compatible, different baseURL)
//
// For agentic OSS model families (Kimi K2, Qwen3-Coder, GLM-4) we wrap the
// language model with a model-family-specific native tool-call middleware.
// Each family emits its own textual markup for tool calls (Kimi pipe-bracket
// tokens, Qwen/GLM XML+JSON), so we dispatch to the right parser by model id
// prefix. The middlewares follow a per-model-parser pattern: zero prompt
// modification, parse the native format from the raw response. See
// `tool-call-middleware.ts`.
//
// DeepSeek V3/V4 was historically wired through here on the assumption it
// emitted fullwidth Unicode markup. Live observation (2026-05) proved that
// DeepSeek V4 Pro emits standard OpenAI tool_calls — the only spec violation
// is `function.arguments` returned as an object instead of a JSON string, and
// that is now normalised upstream by `tolerant-fetch.ts` at the fetch
// boundary. No middleware needed for DeepSeek anymore.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';
import { kimiToolCallMiddleware, nodalToolCallMiddleware } from './parsers';
import { createTolerantFetch } from './tolerant-fetch';

type ModelFamily = 'kimi' | 'nodal-format' | null;

/**
 * Detects the agentic-LLM family of a model id so the right native parser
 * middleware can be applied. Returns `null` for models that use OpenAI tool
 * calling natively (Claude/GPT/Gemini/gemma/DeepSeek/etc.) — those need no
 * middleware.
 *
 * Exported for unit testing the dispatch matrix.
 */
export function detectAgenticFamily(modelId: string): ModelFamily {
  if (modelId.startsWith('moonshotai/kimi-k2')) {
    return 'kimi';
  }
  if (
    modelId.startsWith('qwen/qwen3-coder') ||
    modelId.startsWith('zai/glm-4.5') ||
    modelId.startsWith('zai/glm-4.7')
  ) {
    return 'nodal-format';
  }
  return null;
}

function middlewareForFamily(family: ModelFamily): LanguageModelMiddleware | null {
  switch (family) {
    case 'kimi':
      return kimiToolCallMiddleware;
    case 'nodal-format':
      return nodalToolCallMiddleware;
    case null:
      return null;
  }
}

export function buildOpenRouterModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('openrouter provider requires an apiKey');
  }

  const baseURL = config.baseURL ?? PROVIDER_PRESETS.openrouter.defaultBaseURL;

  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL,
    apiKey: config.apiKey,
    // Normalise non-spec responses (e.g. DeepSeek V4 returning function.arguments
    // as an object instead of a JSON string) before AI SDK's Zod schema sees them.
    fetch: createTolerantFetch(),
  });

  const base = provider(config.model);

  const middleware = middlewareForFamily(detectAgenticFamily(config.model));
  if (middleware) {
    return wrapLanguageModel({ model: base, middleware });
  }

  return base;
}
