// @nodalai/llm — Anthropic provider

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';

export function buildAnthropicModel(config: ProviderConfig): LanguageModel {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  // cacheControl is enabled by default in @ai-sdk/anthropic >= 1.x
  // (it just allows marking content for caching, opt-in per message part)
  // We still pass it explicitly for clarity and to respect cachingEnabled flag.
  const cachingEnabled = config.cachingEnabled !== false;

  return provider(config.model, {
    cacheControl: cachingEnabled,
  });
}
