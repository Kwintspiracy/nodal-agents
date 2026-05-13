// @nodal-agents/llm — OpenAI provider

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';

export function buildOpenAIModel(config: ProviderConfig): LanguageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return provider(config.model);
}
