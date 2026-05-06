// @nodalai/llm — Groq provider

import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';

export function buildGroqModel(config: ProviderConfig): LanguageModel {
  const provider = createGroq({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return provider(config.model);
}
