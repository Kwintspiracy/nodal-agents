// @nodalai/llm — public API

// Types
export type {
  ProviderName,
  ProviderCapabilities,
  ProviderConfig,
  NodalLlmClient,
} from './types.js';
export { PROVIDER_NAMES } from './types.js';

// Errors
export {
  QuotaExhaustedError,
  MessageStructureError,
  RetryExhaustedError,
  ProviderConfigError,
} from './errors.js';
export type { MessageStructureErrorCode } from './errors.js';

// Client factory
export { createLlmClient } from './client.js';

// Message structure validation
export { validateMessageStructure } from './message-structure.js';

// Retry utility
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';

// Embeddings
export { createEmbeddingClient } from './embeddings.js';
export type { EmbeddingProviderConfig, EmbeddingClient } from './embeddings.js';

// Provider registry (capability matrix + presets)
export { CAPABILITY_MATRIX, PROVIDER_PRESETS } from './providers/registry.js';
