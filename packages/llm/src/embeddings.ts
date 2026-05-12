// @nodalai/llm — embedding client

import { embed } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { createOpenAI } from '@ai-sdk/openai';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface EmbeddingProviderConfig {
  provider: 'ollama' | 'openai' | 'keyword';
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface EmbeddingClient {
  /**
   * Embed a text string.
   * Returns a float array for real embedding providers.
   * Returns null for the keyword provider — caller falls back to substring search.
   */
  embed(text: string): Promise<number[] | null>;
  /**
   * Number of dimensions for this embedding model.
   * null for keyword (no real embedding).
   */
  dimensions: number | null;
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

const OLLAMA_DEFAULT_MODEL = 'mxbai-embed-large';
const OLLAMA_DEFAULT_DIMENSIONS = 1024;
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
const OPENAI_DEFAULT_DIMENSIONS = 1536;

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createEmbeddingClient(config: EmbeddingProviderConfig): EmbeddingClient {
  if (config.provider === 'keyword') {
    return {
      embed: async (_text: string) => null,
      dimensions: null,
    };
  }

  if (config.provider === 'ollama') {
    const model = config.model ?? OLLAMA_DEFAULT_MODEL;
    const baseURL = config.baseURL ?? OLLAMA_DEFAULT_BASE_URL;
    const ollamaProvider = createOllama({ baseURL });
    const embeddingModel = ollamaProvider.embedding(model);

    return {
      embed: async (text: string) => {
        const result = await embed({ model: embeddingModel, value: text });
        return result.embedding;
      },
      dimensions: OLLAMA_DEFAULT_DIMENSIONS,
    };
  }

  if (config.provider === 'openai') {
    const model = config.model ?? OPENAI_DEFAULT_MODEL;
    const openaiProvider = createOpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
    const embeddingModel = openaiProvider.embedding(model);

    return {
      embed: async (text: string) => {
        const result = await embed({ model: embeddingModel, value: text });
        return result.embedding;
      },
      dimensions: OPENAI_DEFAULT_DIMENSIONS,
    };
  }

  // TypeScript exhaustiveness check
  const _exhaustive: never = config.provider;
  throw new Error(`Unknown embedding provider: ${String(_exhaustive)}`);
}
