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

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { findModelCatalogEntry } from '@nodal-agents/shared';
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

  // Official OpenRouter provider (not the generic openai-compatible adapter):
  // it understands OpenRouter's unified reasoning format and preserves each
  // model's `reasoning_details` in the assistant message's providerMetadata for
  // a perfect round-trip across tool-call turns — the generic adapter only
  // round-trips a flat reasoning string and drops the structured details +
  // signatures that reasoning models (MiniMax M3, Gemini 3) require.
  const provider = createOpenRouter({
    apiKey: config.apiKey,
    baseURL,
    // 'strict' is the documented mode for the first-party OpenRouter API
    // ('compatible' is for 3rd-party proxies). We hit openrouter.ai directly.
    compatibility: 'strict',
    // Normalise non-spec responses (e.g. DeepSeek V4 returning function.arguments
    // as an object instead of a JSON string) before the SDK's Zod schema sees them.
    fetch: createTolerantFetch(),
  });

  // For reasoning models, explicitly enable reasoning so OpenRouter returns the
  // `reasoning_details` (rather than excluding them). Non-reasoning models are
  // unaffected. The runner then echoes those details back each turn via the
  // assistant message it replays. `extraBody` sends the raw `reasoning` body
  // param (the typed `reasoning` setting would also require max_tokens/effort).
  //
  // `usage: { include: true }` opts into OpenRouter's per-call billing metadata.
  // Without this flag the response may omit `usage.cost`; with it, cost is
  // always present (even when 0) and lands in `providerMetadata.openrouter.usage`
  // on the AI SDK response — read in execute.ts as the real dollar cost of this
  // call. Generic: applies to every OpenRouter model; no model-specific logic.
  const isReasoning = findModelCatalogEntry('openrouter', config.model)?.capabilities.reasoning;
  const base = provider.chat(config.model, {
    extraBody: {
      usage: { include: true },
      ...(isReasoning ? { reasoning: { enabled: true } } : {}),
    },
  });

  const middleware = middlewareForFamily(detectAgenticFamily(config.model));
  if (middleware) {
    return wrapLanguageModel({ model: base, middleware });
  }

  return base;
}
