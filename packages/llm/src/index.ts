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
  LLMCallCancelledError,
  AllProvidersFailedError,
  isContextOverflowError,
  LLMStreamPartError,
  describeThrown,
} from './errors';
export type { MessageStructureErrorCode, LlmTimeoutReason } from './errors';
export type { GenerateTextCallOptions } from './types';
export {
  computeTurnClocks,
  isLocalEndpoint,
  estimateContextTokens,
  estimateToolTokens,
} from './turn-clocks';
export type { TurnClocks } from './turn-clocks';

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

// Speech generation (text in, audio file out) — #487
export { createOpenRouterSpeech, withGeminiStyle } from './providers/speech-models';
export type { SpeechGenerator, SpeechRequest, GeneratedSpeech } from './providers/speech-models';

// Le sous-ensemble de JSON Schema que Gemini accepte (#119). Exporté pour que
// les VRAIS schémas d'outils, qui vivent dans @nodal-agents/tools, soient
// passés à l'assainisseur dans un test : le sens des dépendances interdit
// l'import inverse.
export {
  sanitizeGeminiTools,
  convertSchemaForGemini,
  isGeminiModel,
} from './providers/gemini-schema';
export { patchOpenRouterRequestBody } from './providers/openrouter';
