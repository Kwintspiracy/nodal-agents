// @nodal-agents/llm — Anthropic provider

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';

export function buildAnthropicModel(config: ProviderConfig): LanguageModel {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  // AI SDK v6 controls prompt caching per-message via providerOptions, not at
  // model construction time. The model factory itself takes only the model id.
  // Callers wanting caching pass `providerOptions: { anthropic: { cacheControl
  // : { type: 'ephemeral' } } }` on the relevant message part. The cachingEnabled
  // field on ProviderConfig is now informational (read by NodalLlmClient
  // .capabilities) — no behavioural effect at construction time.
  return provider(config.model);
}
