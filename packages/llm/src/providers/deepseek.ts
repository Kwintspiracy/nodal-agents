// @nodal-agents/llm — DeepSeek native transport provider
//
// Uses @ai-sdk/deepseek (first-party SDK adapter for api.deepseek.com, OpenAI-compat
// protocol). All model options are injected via the fetch wrapper on outgoing request
// bodies — the SDK's model factory accepts no second argument.
//
// CRITICAL — reasoning_content round-trip shim
// --------------------------------------------
// DeepSeek Reasoner (R1) requires that ANY assistant message produced with a
// tool_call MUST include `reasoning_content` when replayed in the conversation.
// If absent or empty string, the API returns HTTP 400:
//   "reasoning_content must be passed back"
//
// The AI SDK may leave reasoning_content as "" on tool-call turns (it captures
// the thinking block but doesn't always write it back into the history). We
// intercept the outgoing request body and pad any empty reasoning_content to a
// single space " " (minimum the validator accepts, semantically neutral).
//
// The shim is HOST-GATED: only applies when the request URL host is
// `api.deepseek.com`. All other hosts pass through unmodified.
//
// thinking mode injection
// ----------------------
// DeepSeek Reasoner models must include `thinking: { type: "enabled" }` in the
// request body. The @ai-sdk/deepseek SDK reads this from providerOptions.deepseek
// at call time, but the runner is generic and does not pass model-specific
// providerOptions. Instead we inject the flag directly into the request body in
// our fetch wrapper — only when the model is a reasoning model (catalog-gated).
//
// We compose with createTolerantFetch() so the arguments-as-object normalisation
// is also applied to responses.

import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';
import { ProviderConfigError } from '../errors';
import { PROVIDER_PRESETS } from './registry';
import { createTolerantFetch } from './tolerant-fetch';

// ─── reasoning_content round-trip shim ────────────────────────────────────────

/**
 * Rewrite an outgoing DeepSeek request body so that every assistant message
 * that carries a `tool_calls` array has a non-empty `reasoning_content` field.
 *
 * DeepSeek Reasoner (R1/thinking mode) returns HTTP 400 when an assistant
 * message has `tool_calls` AND `reasoning_content` is absent or empty string.
 * A single space `" "` satisfies the validator while being semantically neutral.
 *
 * Pure function — exported for unit testing. Input is the already-parsed body
 * object (mutated in-place for performance; caller passes a JSON.parse result).
 */
export function padDeepSeekReasoning(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;

  const messages = (body as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) return body;

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (m['role'] !== 'assistant') continue;

    const toolCalls = m['tool_calls'];
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

    // Only pad when reasoning_content is absent or empty — preserve real content.
    const existing = m['reasoning_content'];
    if (existing === undefined || existing === null || existing === '') {
      m['reasoning_content'] = ' ';
    }
  }

  return body;
}

/**
 * Inject `thinking: { type: 'enabled' }` into the request body when it isn't
 * already present. Required for DeepSeek Reasoner to activate thinking mode.
 *
 * Pure function — exported for unit testing.
 */
export function injectDeepSeekThinking(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  // Don't overwrite if the caller already set thinking (e.g. via providerOptions)
  if (b['thinking'] !== undefined) return body;
  b['thinking'] = { type: 'enabled' };
  return body;
}

/**
 * Create a fetch wrapper that:
 * 1. Is HOST-GATED — only modifies requests to `api.deepseek.com`
 * 2. Pads reasoning_content on assistant tool-call messages (round-trip shim)
 * 3. Optionally injects `thinking: { type: 'enabled' }` for reasoning models
 * 4. Composes with createTolerantFetch for response normalisation
 */
function createDeepSeekFetch(
  opts: { injectThinking: boolean } = { injectThinking: false },
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const tolerant = createTolerantFetch(baseFetch);

  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    // Determine host for gate check
    let host: string | undefined;
    if (typeof input === 'string') {
      try {
        host = new URL(input).host;
      } catch {
        /* non-URL string — host stays undefined */
      }
    } else if (input instanceof URL) {
      host = input.host;
    } else {
      try {
        host = new URL((input as Request).url).host;
      } catch {
        /* ignore */
      }
    }

    // Only apply shims for api.deepseek.com requests
    const isDeepSeekHost = host === 'api.deepseek.com';
    if (!isDeepSeekHost || !init?.body) {
      return tolerant(input, init);
    }

    // Parse + patch the request body before sending
    let patchedInit = init;
    try {
      const rawBody =
        typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      let parsed: unknown = JSON.parse(rawBody);
      // Apply reasoning_content padding (always for deepseek host requests)
      parsed = padDeepSeekReasoning(parsed);
      // Inject thinking mode flag when required by the model
      if (opts.injectThinking) {
        parsed = injectDeepSeekThinking(parsed);
      }
      patchedInit = { ...init, body: JSON.stringify(parsed) };
    } catch {
      // If body parsing fails (malformed JSON, streamed body, etc.), pass through unchanged
    }

    return tolerant(input, patchedInit);
  };
}

// ─── Provider builder ──────────────────────────────────────────────────────────

export function buildDeepSeekModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('deepseek provider requires an apiKey');
  }

  const baseURL = config.baseURL ?? PROVIDER_PRESETS.deepseek.defaultBaseURL;

  // Gate thinking injection on the catalog reasoning flag. Non-reasoning models
  // (deepseek-chat) must NOT receive the thinking flag — it's only valid for
  // deepseek-reasoner.
  const entry = findModelCatalogEntry('deepseek', config.model);
  const isReasoning = entry?.capabilities.reasoning === true;

  const provider = createDeepSeek({
    apiKey: config.apiKey,
    baseURL,
    fetch: createDeepSeekFetch({ injectThinking: isReasoning }),
  });

  return provider(config.model);
}
