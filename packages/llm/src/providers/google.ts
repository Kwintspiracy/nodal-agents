// @nodalai/llm — Google Generative AI provider

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types.js';

export function buildGoogleModel(config: ProviderConfig): LanguageModel {
  const provider = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return provider(config.model);
}
