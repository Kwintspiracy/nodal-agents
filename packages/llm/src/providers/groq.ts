// @nodal-agents/llm — Groq provider

import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { providerFetch } from '../transport';

export function buildGroqModel(config: ProviderConfig): LanguageModel {
  const provider = createGroq({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    fetch: providerFetch,
  });

  return provider(config.model);
}
