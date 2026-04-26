// @nodalai/llm — OpenAI provider

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types.js';

export function buildOpenAIModel(config: ProviderConfig): LanguageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return provider(config.model);
}
