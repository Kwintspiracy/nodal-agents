// @nodal-agents/llm — public API

// Types
export type { ProviderName, ProviderCapabilities, ProviderConfig, NodalLlmClient } from './types';
export { PROVIDER_NAMES } from './types';

// Errors
export {
  QuotaExhaustedError,
  MessageStructureError,
  RetryExhaustedError,
  ProviderConfigError,
  LLMTimeoutError,
  AllProvidersFailedError,
  isContextOverflowError,
} from './errors';
export type { MessageStructureErrorCode } from './errors';

// Client factory
export { createLlmClient } from './client';

export { probeContextWindow } from './probe-context';

// Provider failover (opt-in chain: primary + fallbacks)
export { createFailoverLlmClient } from './failover';
export { buildLlmCallObservation, emitLlmCall } from './observe';
export type { LlmCallObservation, LlmCallObserver, LlmClientMeta } from './observe';

// Message structure validation
export { validateMessageStructure } from './message-structure';

// Retry utility
export { withRetry } from './retry';
export type { RetryOptions } from './retry';

// Embeddings
export {
  createEmbeddingClient,
  validateEmbeddingDimension,
  EXPECTED_EMBEDDING_DIM,
} from './embeddings';
export type { EmbeddingProviderConfig, EmbeddingClient } from './embeddings';

// Provider registry (capability matrix + presets)
export { CAPABILITY_MATRIX, PROVIDER_PRESETS } from './providers/registry';

// Image generation (media — Phase 1)
export {
  buildImageModel,
  generateImageWithProvider,
  IMAGE_CAPABLE_PROVIDERS,
} from './providers/image-models';
export type { GeneratedImage } from './providers/image-models';
