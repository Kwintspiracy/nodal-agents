// @nodalai/llm — Ollama provider

import { createOllama } from 'ollama-ai-provider';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';

export function buildOllamaModel(config: ProviderConfig): LanguageModel {
  const baseURL = config.baseURL ?? PROVIDER_PRESETS.ollama.defaultBaseURL;

  const provider = createOllama({ baseURL });

  return provider(config.model);
}
