// @nodalai/llm — Ollama provider

import { createOllama } from 'ollama-ai-provider';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types.js';
import { PROVIDER_PRESETS } from './registry.js';

export function buildOllamaModel(config: ProviderConfig): LanguageModel {
  const baseURL = config.baseURL ?? PROVIDER_PRESETS.ollama.defaultBaseURL;

  const provider = createOllama({ baseURL });

  return provider(config.model);
}
