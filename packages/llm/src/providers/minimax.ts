// @nodal-agents/llm — MiniMax native transport provider
//
// MiniMax exposes an Anthropic Messages-compatible endpoint at:
//   https://api.minimax.io/anthropic
//
// We use @ai-sdk/anthropic's createAnthropic with a custom baseURL.
//
// Auth difference: MiniMax requires `Authorization: Bearer <key>` NOT the
// Anthropic-native `x-api-key` header. We swap the header via a fetch wrapper.
//
// Beta header stripping: MiniMax rejects the Anthropic-internal beta flags
// `fine-grained-tool-streaming` and `context-1m`. We strip them from the
// `anthropic-beta` header in the fetch wrapper.

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { ProviderConfigError } from '../errors';
import { PROVIDER_PRESETS } from './registry';

// ─── Beta flags MiniMax rejects ───────────────────────────────────────────────

const MINIMAX_REJECTED_BETAS = new Set(['fine-grained-tool-streaming', 'context-1m']);

// ─── Fetch wrapper for auth + beta-header stripping ───────────────────────────

/**
 * Creates a fetch wrapper that:
 * 1. Replaces `x-api-key` with `Authorization: Bearer <key>` (MiniMax auth)
 * 2. Strips beta flags MiniMax rejects from the `anthropic-beta` header
 *
 * This wrapper is attached ONLY to the MiniMax provider (createAnthropic with the
 * MiniMax baseURL), so every request through it already targets MiniMax — the
 * transforms apply unconditionally. No host gate (unlike the DeepSeek shim, which
 * composes with the shared tolerant-fetch); this also keeps a custom MiniMax-
 * compatible baseURL working, where the Bearer swap is exactly what's required.
 */
function createMiniMaxFetch(
  apiKey: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    // Build a mutable Headers object from whatever was passed
    const incoming = new Headers(
      init?.headers as HeadersInit | undefined,
    );

    // Swap auth: remove x-api-key, set Authorization: Bearer
    incoming.delete('x-api-key');
    incoming.set('Authorization', `Bearer ${apiKey}`);

    // Strip rejected beta flags
    const betaHeader = incoming.get('anthropic-beta');
    if (betaHeader) {
      const filtered = betaHeader
        .split(',')
        .map((s) => s.trim())
        .filter((flag) => !MINIMAX_REJECTED_BETAS.has(flag))
        .join(',');
      if (filtered) {
        incoming.set('anthropic-beta', filtered);
      } else {
        incoming.delete('anthropic-beta');
      }
    }

    return baseFetch(input, { ...init, headers: incoming });
  };
}

// ─── Provider builder ──────────────────────────────────────────────────────────

export function buildMiniMaxModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('minimax provider requires an apiKey');
  }

  const baseURL = config.baseURL ?? PROVIDER_PRESETS.minimax.defaultBaseURL;

  const provider = createAnthropic({
    // The SDK sends x-api-key using this value; the fetch wrapper swaps it to
    // Authorization: Bearer before the request reaches the wire.
    apiKey: config.apiKey,
    baseURL,
    fetch: createMiniMaxFetch(config.apiKey),
  });

  return provider(config.model);
}
