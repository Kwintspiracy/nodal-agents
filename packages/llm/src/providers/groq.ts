// @nodal-agents/llm — Groq provider

import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { providerFetch } from '../transport';
import { resolveProviderEndpoint } from '../endpoint';

export function buildGroqModel(config: ProviderConfig): LanguageModel {
  const { baseURL, apiKey } = resolveProviderEndpoint(config);
  const provider = createGroq({
    apiKey,
    baseURL,
    fetch: providerFetch,
  });

  return provider(config.model);
}
