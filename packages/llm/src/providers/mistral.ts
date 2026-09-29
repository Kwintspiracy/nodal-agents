// @nodal-agents/llm — Mistral provider

import { createMistral } from '@ai-sdk/mistral';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { providerFetch } from '../transport';

export function buildMistralModel(config: ProviderConfig): LanguageModel {
  const provider = createMistral({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    fetch: providerFetch,
  });

  return provider(config.model);
}
