// @nodal-agents/llm — provider registry: capability matrix (addresses: `PROVIDER_ENDPOINTS` in @nodal-agents/shared)

import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderName, ProviderCapabilities } from '../types';

// ─── Capability matrix ─────────────────────────────────────────────────────────

/**
 * Capability matrix — single source of truth.
 * Used by both the CLI wizard (Brique 17) and the runner (Brique 13).
 * Capabilities are conservative: flag only what works reliably across all
 * models for a given provider. Orchestration only requires toolUse.
 *
 * promptCaching: the PROVIDER'S default for "this client sends Anthropic-style
 * cache_control breakpoints". Only the native Anthropic route says yes for every
 * model it serves. A route that carries many vendors' models (OpenRouter) says no
 * here and lets the model decide: `promptCachingFor` below.
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
    promptCaching: false, // per MODEL: the catalog's `cacheControl` (promptCachingFor)
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

/**
 * Does the client send Anthropic-style `cache_control` breakpoints for this
 * (provider, model)? Decided from the MODEL, not from the route (#425).
 *
 * Anthropic does not cache a repeated prefix by itself: the request has to
 * carry the breakpoints. That is true of a Claude model whichever door it is
 * reached by, so the catalog states it per model (`capabilities.cacheControl`)
 * and the answer follows the model through every route: OpenRouter today, a
 * direct Anthropic key as before.
 *
 * - A catalogued model that states it: its own answer.
 * - Otherwise the provider's default in `CAPABILITY_MATRIX`: the native
 *   Anthropic route is `true` for any model id (a new Claude not yet
 *   catalogued keeps its cache); an aggregator or any other provider is
 *   `false`, so an uncatalogued model sends no marker (a marker some servers
 *   reject is not worth a guess made from the model's name). A Claude missing
 *   from the catalog is a catalog gap, which the catalog test
 *   (`model-catalog.test.ts`) refuses.
 */
export function promptCachingFor(provider: ProviderName, modelId: string): boolean {
  const stated = findModelCatalogEntry(provider, modelId)?.capabilities.cacheControl;
  return stated ?? CAPABILITY_MATRIX[provider].promptCaching;
}

/**
 * The capability row of a provider with the answers that depend on the model
 * resolved for it: what the client and the conformance suite read.
 */
export function capabilitiesFor(provider: ProviderName, modelId: string): ProviderCapabilities {
  return { ...CAPABILITY_MATRIX[provider], promptCaching: promptCachingFor(provider, modelId) };
}
