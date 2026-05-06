// @nodalai/llm — OpenRouter provider (OpenAI-compatible, different baseURL)

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';

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

  return provider(config.model);
}
