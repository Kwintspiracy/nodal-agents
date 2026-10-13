// @nodal-agents/llm — OpenAI-compatible provider (LM Studio, Jan.ai, llama.cpp, vLLM, custom)

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { ProviderConfigError } from '../errors';
import { createTolerantFetch } from './tolerant-fetch';

export function buildOpenAICompatibleModel(config: ProviderConfig): LanguageModel {
  if (!config.baseURL) {
    throw new ProviderConfigError(
      'openai-compatible provider requires a baseURL (e.g. http://localhost:1234/v1)',
    );
  }

  const provider = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: config.baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    // Normalise non-spec tool_call args before AI SDK's strict schema parses.
    fetch: createTolerantFetch(),
    // Usage in the stream is sent only when asked (stream_options.include_usage).
    // Without it a streamed turn has no output count and is refused as
    // output_usage_not_reported (Codex review of #571).
    includeUsage: true,
  });

  return provider(config.model);
}
