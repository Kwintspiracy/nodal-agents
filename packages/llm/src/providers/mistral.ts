// @nodal-agents/llm — Mistral provider

import { createMistral } from '@ai-sdk/mistral';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { providerFetch } from '../transport';
import { resolveProviderEndpoint } from '../endpoint';

export function buildMistralModel(config: ProviderConfig): LanguageModel {
  const { baseURL, apiKey } = resolveProviderEndpoint(config);
  const provider = createMistral({
    apiKey,
    baseURL,
    fetch: providerFetch,
  });

  return provider(config.model);
}
