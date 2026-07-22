// @nodal-agents/llm — Anthropic provider
//
// Reasoning (per-agent effort brick, 2026-07-20): when ProviderConfig carries
// a reasoningEffort, a fetch shim injects the model's control per the catalog:
//   - kind 'adaptive-effort' (Claude ≥4.6): `output_config: { effort }` —
//     Anthropic's adaptive thinking knob (mirrors Hermes' anthropic_adapter).
//   - kind 'budget' (Haiku 4.5): `thinking: { type:'enabled', budget_tokens }`
//     + the API's constraints (max_tokens > budget, temperature=1, no top_p/k)
//     — the exact shape the MiniMax shim already uses (same Messages API).
// Auto (no effort) and 'off' inject NOTHING — byte-identical to pre-feature
// requests (Anthropic never had an injection before this brick).
// No host gate, mirroring the MiniMax shim's precedent: this builder is only
// ever constructed for the anthropic provider, so every request through it —
// including a custom Claude-compatible baseURL — wants the same treatment.

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { findModelCatalogEntry, type ReasoningControl } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';

/** Output headroom required ON TOP of the thinking budget (max_tokens > budget_tokens). */
const ANTHROPIC_OUTPUT_HEADROOM = 4096;

/**
 * Inject the reasoning control into an outgoing Anthropic Messages body.
 * Idempotent: a body already carrying `thinking` or `output_config` is left
 * untouched (never overwrite an explicit caller setting).
 * Pure function — exported for unit testing.
 */
export function injectAnthropicReasoning(
  body: unknown,
  control: ReasoningControl,
  effort: 'low' | 'medium' | 'high' | 'max',
): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;

  if (control.kind === 'adaptive-effort') {
    if (b['output_config'] !== undefined) return body;
    b['output_config'] = { effort };
    return body;
  }

  if (control.kind === 'budget') {
    if (b['thinking'] !== undefined) return body;
    const budget = control.budgets?.[effort];
    if (!budget) return body;
    b['thinking'] = { type: 'enabled', budget_tokens: budget };
    const curMax = typeof b['max_tokens'] === 'number' ? (b['max_tokens'] as number) : 0;
    if (curMax <= budget) b['max_tokens'] = budget + ANTHROPIC_OUTPUT_HEADROOM;
    // Extended thinking rejects sampling controls other than temperature=1.
    b['temperature'] = 1;
    delete b['top_p'];
    delete b['top_k'];
    return body;
  }

  return body;
}

function createAnthropicReasoningFetch(
  control: ReasoningControl,
  effort: 'low' | 'medium' | 'high' | 'max',
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (!init?.body) return baseFetch(input, init);
    let patchedInit = init;
    try {
      const rawBody =
        typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const patched = injectAnthropicReasoning(JSON.parse(rawBody), control, effort);
      patchedInit = { ...init, body: JSON.stringify(patched) };
    } catch {
      // Malformed/streamed body — pass through unchanged rather than break the call.
    }
    return baseFetch(input, patchedInit);
  };
}

export function buildAnthropicModel(config: ProviderConfig): LanguageModel {
  const effort = config.reasoningEffort;
  const control = findModelCatalogEntry('anthropic', config.model)?.capabilities.reasoningControl;
  const reasoningFetch =
    effort && effort !== 'off' && control
      ? createAnthropicReasoningFetch(control, effort)
      : undefined;

  const provider = createAnthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(reasoningFetch ? { fetch: reasoningFetch } : {}),
  });

  // AI SDK v6 controls prompt caching per-message via providerOptions, not at
  // model construction time. The model factory itself takes only the model id.
  // Callers wanting caching pass `providerOptions: { anthropic: { cacheControl
  // : { type: 'ephemeral' } } }` on the relevant message part. The cachingEnabled
  // field on ProviderConfig is now informational (read by NodalLlmClient
  // .capabilities) — no behavioural effect at construction time.
  return provider(config.model);
}
