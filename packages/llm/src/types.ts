// @nodalai/llm — core types

import type { generateText, streamText, generateObject } from 'ai';

// ─── Provider names ────────────────────────────────────────────────────────────

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'openai-compatible'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'openrouter';

/**
 * All supported provider names as a runtime array.
 * Used by CLI wizard (Brique 17) and validation utilities.
 */
export const PROVIDER_NAMES: ProviderName[] = [
  'anthropic',
  'openai',
  'ollama',
  'openai-compatible',
  'google',
  'mistral',
  'groq',
  'openrouter',
];

// ─── Capability flags ──────────────────────────────────────────────────────────

/**
 * Capability flags for a provider/model combination.
 * Used by orchestration code to determine which features are safe to use.
 * toolUse is the only capability required for orchestration — all others are opt-in.
 */
export interface ProviderCapabilities {
  /** Provider supports tool/function calling */
  toolUse: boolean;
  /** Provider supports Anthropic-style prompt caching (extended TTL cache headers) */
  promptCaching: boolean;
  /** Provider supports image/vision inputs */
  vision: boolean;
  /** Provider supports native structured outputs (JSON mode / schema enforcement) */
  structuredOutputs: boolean;
  /** Provider supports streaming responses */
  streaming: boolean;
}

// ─── Provider configuration ────────────────────────────────────────────────────

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  /** API key — falls back to provider-specific env var if omitted */
  apiKey?: string;
  /** Base URL — required for openai-compatible; optional override for others */
  baseURL?: string;
  /**
   * Enable prompt caching where supported (Anthropic only).
   * Defaults to true when the provider supports it.
   */
  cachingEnabled?: boolean;
}

// ─── NodalLlmClient ────────────────────────────────────────────────────────────

/**
 * A configured LLM client scoped to a specific provider+model.
 * generateText / streamText / generateObject are pre-bound to the model —
 * callers omit the `model` field. Message structure validation runs
 * automatically before every request.
 */
export interface NodalLlmClient {
  config: ProviderConfig;
  capabilities: ProviderCapabilities;

  generateText: (
    args: Omit<Parameters<typeof generateText>[0], 'model'>,
  ) => ReturnType<typeof generateText>;

  streamText: (
    args: Omit<Parameters<typeof streamText>[0], 'model'>,
  ) => ReturnType<typeof streamText>;

  generateObject: (
    args: Omit<Parameters<typeof generateObject>[0], 'model'>,
  ) => ReturnType<typeof generateObject>;
}
