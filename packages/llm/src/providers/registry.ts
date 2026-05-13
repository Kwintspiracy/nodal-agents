// @nodal-agents/llm — provider registry: presets + capability matrix

import type { ProviderName, ProviderCapabilities } from '../types';

// ─── Provider presets (default baseURL + model) ────────────────────────────────

/**
 * Preset configuration for providers that need a baseURL or a default model.
 * Remote cloud providers (Anthropic, OpenAI, Google, Mistral, Groq) don't need
 * a defaultBaseURL because the SDK handles it.
 */
export const PROVIDER_PRESETS = {
  ollama: {
    defaultBaseURL: 'http://localhost:11434',
    defaultModel: 'llama3.3:70b',
  },
  'lm-studio': {
    defaultBaseURL: 'http://localhost:1234/v1',
    defaultModel: '',
  },
  'jan-ai': {
    defaultBaseURL: 'http://localhost:1337/v1',
    defaultModel: '',
  },
  'llama-cpp': {
    defaultBaseURL: 'http://localhost:8080/v1',
    defaultModel: '',
  },
  vllm: {
    defaultBaseURL: 'http://localhost:8000/v1',
    defaultModel: '',
  },
  openrouter: {
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
  },
} as const;

// ─── Capability matrix ─────────────────────────────────────────────────────────

/**
 * Capability matrix — single source of truth.
 * Used by both the CLI wizard (Brique 17) and the runner (Brique 13).
 * Capabilities are conservative: flag only what works reliably across all
 * models for a given provider. Orchestration only requires toolUse.
 *
 * promptCaching: only Anthropic supports the extended-TTL cache_control header.
 * vision: provider + at least one mainstream model supports image input.
 * structuredOutputs: native schema-enforced JSON mode.
 * streaming: provider supports streamed responses.
 */
export const CAPABILITY_MATRIX: Record<ProviderName, ProviderCapabilities> = {
  anthropic: {
    toolUse: true,
    promptCaching: true,
    vision: true,
    structuredOutputs: false, // Anthropic uses tool-based structured output, not native schema mode
    streaming: true,
  },
  openai: {
    toolUse: true,
    promptCaching: false,
    vision: true,
    structuredOutputs: true,
    streaming: true,
  },
  ollama: {
    toolUse: true,
    promptCaching: false, // local inference, no caching layer
    vision: false, // model-dependent; conservative default
    structuredOutputs: true, // Ollama supports JSON mode
    streaming: true,
  },
  'openai-compatible': {
    toolUse: true,
    promptCaching: false,
    vision: false, // model-dependent; conservative default
    structuredOutputs: false,
    streaming: true,
  },
  google: {
    toolUse: true,
    promptCaching: false,
    vision: true,
    structuredOutputs: true,
    streaming: true,
  },
  mistral: {
    toolUse: true,
    promptCaching: false,
    vision: false,
    structuredOutputs: true,
    streaming: true,
  },
  groq: {
    toolUse: true,
    promptCaching: false,
    vision: false,
    structuredOutputs: true,
    streaming: true,
  },
  openrouter: {
    toolUse: true,
    promptCaching: false, // depends on underlying model; conservative default
    vision: false, // depends on underlying model; conservative default
    structuredOutputs: false,
    streaming: true,
  },
} as const;
