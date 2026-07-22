// @nodal-agents/llm — OpenAI provider
//
// Reasoning (per-agent effort brick, 2026-07-20): when ProviderConfig carries
// a reasoningEffort and the catalog declares the model controllable, a fetch
// shim sets the top-level `reasoning_effort` field on the outgoing body
// ('max' clamps to 'high' — not an OpenAI level; the catalog levels keep the
// UI from offering it anyway). Auto and 'off' send NOTHING — byte-identical
// to pre-feature requests. No host gate (same precedent as the MiniMax and
// Anthropic shims: this builder only ever serves the openai provider).

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';

/**
 * Set `reasoning_effort` on an outgoing OpenAI body unless already present.
 * Pure function — exported for unit testing.
 */
export function injectOpenAIReasoningEffort(body: unknown, effort: string): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  if (b['reasoning_effort'] !== undefined) return body;
  b['reasoning_effort'] = effort;
  return body;
}

function createOpenAIReasoningFetch(
  effort: string,
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
      const patched = injectOpenAIReasoningEffort(JSON.parse(rawBody), effort);
      patchedInit = { ...init, body: JSON.stringify(patched) };
    } catch {
      // Malformed/streamed body — pass through unchanged rather than break the call.
    }
    return baseFetch(input, patchedInit);
  };
}

export function buildOpenAIModel(config: ProviderConfig): LanguageModel {
  const effort = config.reasoningEffort;
  const control = findModelCatalogEntry('openai', config.model)?.capabilities.reasoningControl;
  const wire =
    effort && effort !== 'off' && control ? (effort === 'max' ? 'high' : effort) : undefined;

  const provider = createOpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(wire ? { fetch: createOpenAIReasoningFetch(wire) } : {}),
  });

  return provider(config.model);
}
