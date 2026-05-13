// @nodal-agents/llm — OpenRouter provider (OpenAI-compatible, different baseURL)
//
// For agentic OSS model families (DeepSeek V3/V4, Kimi K2, Qwen3-Coder, GLM-4)
// we wrap the language model with a model-family-specific native tool-call
// middleware. Each family emits its own textual markup for tool calls
// (DeepSeek fullwidth unicode, Kimi pipe-bracket, Qwen/GLM XML+JSON),
// so we dispatch to the right parser by model id prefix. The middlewares
// follow a per-model-parser pattern: zero prompt modification, parse the
// native format from the raw response. See `tool-call-middleware.ts`.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';
import {
  deepseekToolCallMiddleware,
  kimiToolCallMiddleware,
  nodalToolCallMiddleware,
} from './parsers';

type ModelFamily = 'deepseek' | 'kimi' | 'nodal-format' | null;

/**
 * Detects the agentic-LLM family of a model id so the right native parser
 * middleware can be applied. Returns `null` for models that use OpenAI tool
 * calling natively (Claude/GPT/Gemini/gemma/etc.) — those need no middleware.
 *
 * Exported for unit testing the dispatch matrix.
 */
export function detectAgenticFamily(modelId: string): ModelFamily {
  if (modelId.startsWith('deepseek/deepseek-v3') || modelId.startsWith('deepseek/deepseek-v4')) {
    return 'deepseek';
  }
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
    case 'deepseek':
      return deepseekToolCallMiddleware;
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
  });

  const base = provider(config.model);

  const middleware = middlewareForFamily(detectAgenticFamily(config.model));
  if (middleware) {
    return wrapLanguageModel({ model: base, middleware });
  }

  return base;
}
