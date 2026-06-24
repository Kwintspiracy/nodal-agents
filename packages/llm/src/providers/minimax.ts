// @nodal-agents/llm — MiniMax native transport provider
//
// MiniMax exposes an Anthropic Messages-compatible endpoint. The messages route
// is `https://api.minimax.io/anthropic/v1/messages` (the `/v1` matters — the
// `/anthropic` root alone 404s; probed live: `/anthropic/messages`→404,
// `/anthropic/v1/messages`→401). @ai-sdk/anthropic POSTs to `${baseURL}/messages`
// (its default baseURL already includes `/v1`), so the baseURL we hand it MUST
// end in `/v1`. Saved keys store the `/anthropic` root (so the connection test
// can hit `/anthropic/v1/models`), hence we normalize here.
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
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';
import { ProviderConfigError } from '../errors';
import { PROVIDER_PRESETS } from './registry';

// ─── Beta flags MiniMax rejects ───────────────────────────────────────────────

const MINIMAX_REJECTED_BETAS = new Set(['fine-grained-tool-streaming', 'context-1m']);

// ─── Extended thinking (manual mode) ──────────────────────────────────────────
//
// MiniMax's Anthropic-compatible endpoint supports extended thinking in MANUAL
// mode only (not Claude's adaptive mode) — confirmed by Hermes' adapter. A
// reasoning model like M3 is crippled without it: it's the "thinking" that makes
// M3 as strong as it is. So we inject the Anthropic Messages `thinking` block —
// the exact analogue of what we already do for DeepSeek Reasoner (injectDeepSeek-
// Thinking), but in Anthropic shape with an explicit budget_tokens.
//
// The budget also doubles as the time bound that the OpenRouter route lacked
// (uncapped M3 thinking once overran the 300s call timeout): manual thinking is
// hard-capped at budget_tokens, so it can't run away.

/** Manual thinking budget for MiniMax reasoning models (tokens). Matches Hermes' 'medium'. */
const MINIMAX_THINKING_BUDGET = 8000;
/** Output headroom required ON TOP of the thinking budget (Anthropic: max_tokens > budget_tokens). */
const MINIMAX_OUTPUT_HEADROOM = 4096;

/**
 * Inject Anthropic-style manual extended thinking into a MiniMax request body,
 * and satisfy the API's constraints when thinking is on:
 *   - `max_tokens` MUST exceed `budget_tokens` → bump it if too low/absent.
 *   - `temperature` MUST be 1 and `top_p`/`top_k` MUST be unset → normalise.
 * Idempotent: a body that already carries `thinking` is left untouched.
 *
 * Pure function — exported for unit testing.
 */
export function injectMiniMaxThinking(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  if (b['thinking'] !== undefined) return body;
  b['thinking'] = { type: 'enabled', budget_tokens: MINIMAX_THINKING_BUDGET };
  const minMax = MINIMAX_THINKING_BUDGET + MINIMAX_OUTPUT_HEADROOM;
  const curMax = typeof b['max_tokens'] === 'number' ? (b['max_tokens'] as number) : 0;
  if (curMax <= MINIMAX_THINKING_BUDGET) b['max_tokens'] = minMax;
  // Extended thinking rejects sampling controls other than temperature=1.
  b['temperature'] = 1;
  delete b['top_p'];
  delete b['top_k'];
  return body;
}

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
  opts: { injectThinking: boolean } = { injectThinking: false },
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    // Build a mutable Headers object from whatever was passed
    const incoming = new Headers(init?.headers as HeadersInit | undefined);

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

    // Inject manual extended thinking for reasoning models (M3). Parse → patch →
    // re-serialize the JSON body, mirroring the DeepSeek Reasoner injection.
    let patchedBody = init?.body;
    if (opts.injectThinking && init?.body) {
      try {
        const rawBody =
          typeof init.body === 'string' ? init.body : await new Response(init.body).text();
        patchedBody = JSON.stringify(injectMiniMaxThinking(JSON.parse(rawBody)));
      } catch {
        // Malformed/streamed body — pass through unchanged rather than break the call.
      }
    }

    return baseFetch(input, { ...init, headers: incoming, body: patchedBody });
  };
}

// ─── baseURL normalization ────────────────────────────────────────────────────

/**
 * Ensure the MiniMax anthropic baseURL ends in `/v1`, since @ai-sdk/anthropic
 * appends `/messages` to it. Saved keys store the `/anthropic` root (the
 * connection test adds `/v1/models` itself), which would make the SDK POST to
 * `/anthropic/messages` → 404. Idempotent: a baseURL already ending in `/v1` is
 * left as-is. Trailing slashes are stripped first.
 */
export function normalizeMiniMaxBaseURL(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

// ─── Provider builder ──────────────────────────────────────────────────────────

export function buildMiniMaxModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('minimax provider requires an apiKey');
  }

  const baseURL = normalizeMiniMaxBaseURL(
    config.baseURL ?? PROVIDER_PRESETS.minimax.defaultBaseURL,
  );

  // Gate thinking injection on the catalog reasoning flag. Non-reasoning models
  // (MiniMax-M2 / M2.7) must NOT receive the thinking block — only M3 is a
  // reasoning model. Mirrors buildDeepSeekModel.
  const entry = findModelCatalogEntry('minimax', config.model);
  const isReasoning = entry?.capabilities.reasoning === true;

  const provider = createAnthropic({
    // The SDK sends x-api-key using this value; the fetch wrapper swaps it to
    // Authorization: Bearer before the request reaches the wire.
    apiKey: config.apiKey,
    baseURL,
    fetch: createMiniMaxFetch(config.apiKey, { injectThinking: isReasoning }),
  });

  return provider(config.model);
}
