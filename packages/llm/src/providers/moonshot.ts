// @nodal-agents/llm — Moonshot (Kimi) native transport provider
//
// Moonshot exposes an OpenAI-compatible chat-completions endpoint at
// api.moonshot.ai/v1 (global). The China-region host api.moonshot.cn/v1 uses
// the identical wire protocol — it is NOT a second provider, just a baseURL
// override (ProviderConfig.baseURL) on this same provider; both hosts are
// gated below so the shim applies either way.
//
// Uses @ai-sdk/openai-compatible with a fetch shim that host-gates three
// Moonshot-specific quirks (mirrors the DeepSeek/MiniMax pattern):
//
//   1. temperature is never sent — Moonshot's docs don't document a
//      temperature parameter for the Kimi K2 line (it's managed server-side);
//      the field is deleted from the outgoing body unconditionally.
//   2. `thinking` and `reasoning_effort` are mutually exclusive — sending
//      both risks an HTTP 400 ("cannot specify both 'thinking' and
//      'reasoning_effort'"). Reasoning-capable models (catalog-gated) get
//      `thinking: {type:'enabled'}` injected and any `reasoning_effort` field
//      stripped; never the reverse.
//   3. Moonshot only accepts a strict subset of JSON Schema for tool
//      parameters (see moonshot-schema.ts) — every tool's
//      `function.parameters` is rewritten through the shared sanitizer.
//
// Composes with createTolerantFetch for response-side normalisation, same as
// every other openai-compatible-shaped provider (arguments-as-object repair).

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';
import { ProviderConfigError } from '../errors';
import { PROVIDER_PRESETS } from './registry';
import { createTolerantFetch } from './tolerant-fetch';
import { sanitizeMoonshotTools } from './moonshot-schema';

const MOONSHOT_HOSTS = new Set(['api.moonshot.ai', 'api.moonshot.cn']);

function requestHost(input: Parameters<typeof globalThis.fetch>[0]): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).host;
    if (input instanceof URL) return input.host;
    return new URL((input as Request).url).host;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite an outgoing Moonshot request body: drop `temperature`, enforce the
 * `thinking` XOR `reasoning_effort` rule, and sanitize tool schemas.
 * Pure function — exported for unit testing.
 */
export function patchMoonshotRequestBody(
  body: unknown,
  opts: { injectThinking: boolean; reasoningEffort?: string },
): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;

  delete b['temperature'];

  if (opts.injectThinking) {
    // K2-line: `thinking` XOR `reasoning_effort` — sending both is a 400.
    b['thinking'] = { type: 'enabled' };
    delete b['reasoning_effort'];
  } else if (opts.reasoningEffort) {
    // K3-line: intensity via the top-level `reasoning_effort` field (the only
    // accepted value today is 'max' — enforced by the catalog levels).
    b['reasoning_effort'] = opts.reasoningEffort;
  }

  if (Array.isArray(b['tools'])) {
    b['tools'] = sanitizeMoonshotTools(b['tools']);
  }

  return body;
}

/**
 * Create a fetch wrapper that:
 * 1. Is HOST-GATED — only rewrites requests to api.moonshot.ai / api.moonshot.cn
 * 2. Applies patchMoonshotRequestBody to the outgoing JSON body
 * 3. Composes with createTolerantFetch for response normalisation
 */
function createMoonshotFetch(
  opts: { injectThinking: boolean; reasoningEffort?: string },
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const tolerant = createTolerantFetch(baseFetch);

  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const host = requestHost(input);
    if (!host || !MOONSHOT_HOSTS.has(host) || !init?.body) {
      return tolerant(input, init);
    }

    let patchedInit = init;
    try {
      const rawBody =
        typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const patched = patchMoonshotRequestBody(JSON.parse(rawBody), opts);
      patchedInit = { ...init, body: JSON.stringify(patched) };
    } catch {
      // Malformed/streamed body — pass through unchanged rather than break the call.
    }

    return tolerant(input, patchedInit);
  };
}

// ─── Provider builder ──────────────────────────────────────────────────────────

export function buildMoonshotModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('moonshot provider requires an apiKey');
  }

  const baseURL = config.baseURL ?? PROVIDER_PRESETS.moonshot.defaultBaseURL;

  // Gate thinking injection on the catalog reasoning flag AND the K2 line.
  // `thinking: {type:'enabled'}` is a K2-line parameter (kimi-k2.6,
  // kimi-k2.7-code). Kimi K3 always reasons server-side and is configured via
  // the top-level `reasoning_effort` field instead (currently `max` only, the
  // server default) — injecting `thinking` there risks the documented 400
  // ("cannot specify both 'thinking' and 'reasoning_effort'"), so K3 gets a
  // clean body. A custom/uncatalogued model id defaults to false either way.
  const entry = findModelCatalogEntry('moonshot', config.model);
  const isReasoning = entry?.capabilities.reasoning === true && config.model.startsWith('kimi-k2');

  // K3 intensity: explicit per-agent effort → top-level reasoning_effort
  // (kind 'effort' in the catalog; K2-line and 'off' never reach here — the
  // K2 gate above wins and 'off' is not offered on mandatory models).
  const effort = config.reasoningEffort;
  const k3Effort =
    !isReasoning &&
    entry?.capabilities.reasoningControl?.kind === 'effort' &&
    effort &&
    effort !== 'off'
      ? effort
      : undefined;

  const provider = createOpenAICompatible({
    name: 'moonshot',
    baseURL,
    apiKey: config.apiKey,
    fetch: createMoonshotFetch({ injectThinking: isReasoning, reasoningEffort: k3Effort }),
  });

  return provider(config.model);
}
