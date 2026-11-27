// @nodal-agents/llm — Ollama provider

import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { providerFetch } from '../transport';
import { resolveProviderEndpoint } from '../endpoint';

export function buildOllamaModel(config: ProviderConfig): LanguageModel {
  const { baseURL } = resolveProviderEndpoint(config);

  const provider = createOllama({ baseURL, fetch: providerFetch });

  return provider(config.model);
}
