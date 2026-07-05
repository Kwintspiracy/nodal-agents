// @nodal-agents/llm — embedding client

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

// ─── Schema constant ───────────────────────────────────────────────────────────

/**
 * The dimension the pgvector column is created with.
 * Defined in packages/db/src/schema/memory.ts: vectorType('embedding', { dimensions: 1536 })
 * Any real embedding provider MUST produce vectors of exactly this length.
 */
export const EXPECTED_EMBEDDING_DIM = 1536;

// ─── Dimension guard ───────────────────────────────────────────────────────────

/**
 * Validates that a real embedding vector matches the DB schema dimension.
 * Throws a descriptive error on mismatch so the misconfiguration is immediately
 * visible instead of silently degrading to keyword search on every call.
 *
 * Keyword provider (null vector) is intentional and always valid — skip check.
 */
export function validateEmbeddingDimension(
  vector: number[],
  provider: string,
  model: string,
): void {
  if (vector.length !== EXPECTED_EMBEDDING_DIM) {
    throw new Error(
      `Embedding model '${model}' (${provider}) produced ${vector.length} dims but the DB expects ${EXPECTED_EMBEDDING_DIM}. ` +
        `Configure a ${EXPECTED_EMBEDDING_DIM}-dim model or set EMBEDDING_PROVIDER=keyword.`,
    );
  }
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

// mxbai-embed-large is Ollama's most commonly available embedding model, but it
// natively outputs 1024-dim vectors — NOT the 1536 the pgvector column expects
// (audit#2 M-14). Every call with the default model is therefore guaranteed to
// throw via validateEmbeddingDimension below (fail-loud, not a silent
// mismatch), until the operator configures EMBEDDING_MODEL to a model that
// actually outputs 1536 dims, or sets EMBEDDING_PROVIDER=openai/keyword. This
// is a real out-of-the-box gap, not a bug in the guard: no widely-available
// Ollama embedding model natively emits 1536 dims today.
const OLLAMA_DEFAULT_MODEL = 'mxbai-embed-large';
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';

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
        validateEmbeddingDimension(result.embedding, 'ollama', model);
        return result.embedding;
      },
      // Not a per-provider guess (audit#2 M-14): validateEmbeddingDimension
      // above throws on any embed() call that doesn't produce exactly
      // EXPECTED_EMBEDDING_DIM, so the only dimension a caller can ever
      // observe from a successful call — for ANY real provider/model — is
      // EXPECTED_EMBEDDING_DIM. Reporting the model's native dimension here
      // (e.g. mxbai-embed-large's actual 1024) would describe a value that
      // can never actually reach the caller without throwing first.
      dimensions: EXPECTED_EMBEDDING_DIM,
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
        validateEmbeddingDimension(result.embedding, 'openai', model);
        return result.embedding;
      },
      dimensions: EXPECTED_EMBEDDING_DIM,
    };
  }

  // TypeScript exhaustiveness check
  const _exhaustive: never = config.provider;
  throw new Error(`Unknown embedding provider: ${String(_exhaustive)}`);
}
