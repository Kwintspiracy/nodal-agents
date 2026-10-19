// @nodal-agents/llm — provider registry: presets + capability matrix

import type { ProviderName, ProviderCapabilities } from '../types';

// ─── Provider presets (default baseURL + model) ────────────────────────────────

/**
 * Preset configuration for providers that need a non-default baseURL.
 * Remote cloud providers (Anthropic, OpenAI, Google, Mistral, Groq) don't need
 * a defaultBaseURL because the SDK handles it.
 *
 * No `defaultModel` field: nothing reads it (only `.defaultBaseURL` is
 * consumed, by each provider builder) — it was dead weight duplicating the
 * CLI wizard's own `LlmPreset.defaultModel` in `apps/cli/src/lib/llm-presets.ts`,
 * which IS the one actually read by `init.ts`. Removed rather than left stale
 * (audit #2 toilettage — this file's copy had drifted: 'MiniMax-M1' no longer
 * exists in the catalog and 'anthropic/claude-3.5-sonnet' was never added to it).
 */
export const PROVIDER_PRESETS = {
  ollama: {
    defaultBaseURL: 'http://localhost:11434',
  },
  'lm-studio': {
    defaultBaseURL: 'http://localhost:1234/v1',
  },
  'jan-ai': {
    defaultBaseURL: 'http://localhost:1337/v1',
  },
  'llama-cpp': {
    defaultBaseURL: 'http://localhost:8080/v1',
  },
  vllm: {
    defaultBaseURL: 'http://localhost:8000/v1',
  },
  openrouter: {
    defaultBaseURL: 'https://openrouter.ai/api/v1',
  },
  deepseek: {
    defaultBaseURL: 'https://api.deepseek.com/v1',
  },
  minimax: {
    // MiniMax's Anthropic Messages-compatible endpoint (native protocol, no proxy).
    defaultBaseURL: 'https://api.minimax.io/anthropic',
  },
  moonshot: {
    // Global endpoint. The China-region host (api.moonshot.cn/v1) is NOT a
    // separate provider — same wire protocol, reached via the ProviderConfig
    // baseURL override; the moonshot.ts fetch shim host-gates both.
    defaultBaseURL: 'https://api.moonshot.ai/v1',
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
 * Whether a model takes images is not here: it is per model
 * (`modelCanSeeImages`, @nodal-agents/shared/model-catalog), the one source.
 * structuredOutputs: native schema-enforced JSON mode.
 * streaming: provider supports streamed responses.
 */
export const CAPABILITY_MATRIX: Record<ProviderName, ProviderCapabilities> = {
  anthropic: {
    toolUse: true,
    promptCaching: true,
    structuredOutputs: false, // Anthropic uses tool-based structured output, not native schema mode
    streaming: true,
  },
  openai: {
    toolUse: true,
    promptCaching: false,
    structuredOutputs: true,
    streaming: true,
  },
  ollama: {
    toolUse: true,
    promptCaching: false, // local inference, no caching layer
    structuredOutputs: true, // Ollama supports JSON mode
    streaming: true,
  },
  'openai-compatible': {
    toolUse: true,
    promptCaching: false,
    structuredOutputs: false,
    streaming: true,
  },
  google: {
    toolUse: true,
    promptCaching: false,
    structuredOutputs: true,
    streaming: true,
  },
  mistral: {
    toolUse: true,
    promptCaching: false,
    structuredOutputs: true,
    streaming: true,
  },
  groq: {
    toolUse: true,
    promptCaching: false,
    structuredOutputs: true,
    streaming: true,
  },
  openrouter: {
    toolUse: true,
    promptCaching: false, // depends on underlying model; conservative default
    structuredOutputs: false,
    streaming: true,
  },
  deepseek: {
    toolUse: true,
    promptCaching: false, // DeepSeek does not support Anthropic-style cache_control headers
    structuredOutputs: false,
    streaming: true,
  },
  minimax: {
    toolUse: true,
    promptCaching: false, // MiniMax's Anthropic endpoint does not support cache_control
    structuredOutputs: false,
    streaming: true,
  },
  moonshot: {
    toolUse: true,
    // Moonshot's own docs don't mention cache_control-style extended prompt
    // caching for the Kimi K2 line.
    promptCaching: false,
    structuredOutputs: false,
    streaming: true,
  },
} as const;
