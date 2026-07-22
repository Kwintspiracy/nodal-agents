// @nodal-agents/llm — OpenRouter provider (OpenAI-compatible, different baseURL)
//
// For agentic OSS model families (Kimi K2, Qwen3-Coder, GLM-4) we wrap the
// language model with a model-family-specific native tool-call middleware.
// Each family emits its own textual markup for tool calls (Kimi pipe-bracket
// tokens, Qwen/GLM XML+JSON), so we dispatch to the right parser by model id
// prefix. The middlewares follow a per-model-parser pattern: zero prompt
// modification, parse the native format from the raw response. See
// `tool-call-middleware.ts`.
//
// DeepSeek V3/V4 was historically wired through here on the assumption it
// emitted fullwidth Unicode markup. Live observation (2026-05) proved that
// DeepSeek V4 Pro emits standard OpenAI tool_calls — the only spec violation
// is `function.arguments` returned as an object instead of a JSON string, and
// that is now normalised upstream by `tolerant-fetch.ts` at the fetch
// boundary. No middleware needed for DeepSeek anymore.

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import { findModelCatalogEntry, type ReasoningEffort } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';
import { kimiToolCallMiddleware, nodalToolCallMiddleware } from './parsers';
import { createTolerantFetch } from './tolerant-fetch';
import { isMoonshotModel, sanitizeMoonshotTools } from './moonshot-schema';

type ModelFamily = 'kimi' | 'nodal-format' | null;

/**
 * Detects the agentic-LLM family of a model id so the right native parser
 * middleware can be applied. Returns `null` for models that use OpenAI tool
 * calling natively (Claude/GPT/Gemini/gemma/DeepSeek/etc.) — those need no
 * middleware.
 *
 * Exported for unit testing the dispatch matrix.
 */
export function detectAgenticFamily(modelId: string): ModelFamily {
  if (modelId.startsWith('moonshotai/kimi-k2')) {
    // Kimi K2.7+ emits NATIVE OpenAI tool_calls (verified live via OpenRouter,
    // 2026-06-21: kimi-k2.7-code returned finish_reason=tool_calls with a real
    // tool_calls array, content just " "). Only the older K2.0–K2.6 line emits
    // the pipe-bracket textual markup the parser middleware was built for.
    // Applying that middleware to a native model would drop its tool calls.
    const minor = Number(/kimi-k2\.(\d+)/.exec(modelId)?.[1] ?? '0');
    if (minor >= 7) return null;
    return 'kimi';
  }
  if (
    modelId.startsWith('qwen/qwen3-coder') ||
    // Z.ai's real OpenRouter namespace is hyphenated (`z-ai/`) — the catalog's
    // z-ai/glm-5.2 entry uses it. The old `zai/` (no hyphen) prefix is kept
    // too for zero-cost back-compat with any config still using it.
    modelId.startsWith('zai/glm-4.5') ||
    modelId.startsWith('zai/glm-4.7') ||
    modelId.startsWith('z-ai/glm-4.5') ||
    modelId.startsWith('z-ai/glm-4.7')
  ) {
    return 'nodal-format';
  }
  return null;
}

function middlewareForFamily(family: ModelFamily): LanguageModelMiddleware | null {
  switch (family) {
    case 'kimi':
      return kimiToolCallMiddleware;
    case 'nodal-format':
      return nodalToolCallMiddleware;
    case null:
      return null;
  }
}

/**
 * Build the extraBody for an OpenRouter model request. Pure function — no
 * side effects, exported for unit testing.
 *
 * @internal
 */
export function buildOpenRouterExtraBody(
  modelId: string,
  reasoningEffort?: ReasoningEffort,
): Record<string, unknown> {
  const entry = findModelCatalogEntry('openrouter', modelId);
  const isReasoning = entry?.capabilities.reasoning;
  const control = entry?.capabilities.reasoningControl;
  const providerOrder = entry?.providerOrder;

  // Reasoning block precedence:
  //   1. Explicit per-agent effort, when the catalog declares the model
  //      controllable ('max' → OpenRouter's 'xhigh'; 'off' → enabled:false,
  //      not offered by the UI when the control is `mandatory`). OpenRouter
  //      normalizes a requested effort to the nearest level the upstream
  //      really supports — the catalog levels are the UI contract.
  //   2. Auto (no effort): pre-feature behavior — reasoning:true models get
  //      the bounded 'medium' default. Without a cap OpenRouter lets a
  //      reasoning model think unboundedly, which on slower routes overruns
  //      the 300s LLM-call timeout (live incident: minimax/minimax-m3).
  //      The runner still round-trips the reasoning_details returned.
  let reasoning: Record<string, unknown> | undefined;
  if (reasoningEffort && control) {
    reasoning =
      reasoningEffort === 'off'
        ? { enabled: false }
        : { enabled: true, effort: reasoningEffort === 'max' ? 'xhigh' : reasoningEffort };
  } else if (isReasoning) {
    reasoning = { enabled: true, effort: 'medium' };
  }

  return {
    usage: { include: true },
    ...(reasoning ? { reasoning } : {}),
    ...(providerOrder ? { provider: { order: providerOrder, allow_fallbacks: true } } : {}),
  };
}

/**
 * Rewrite an outgoing OpenRouter request body so a Kimi model's tool schemas
 * go through the Moonshot sanitizer (moonshot-schema.ts). Moonshot's flavored-
 * JSON-Schema rejection applies to its inference regardless of which
 * aggregator relays the request — a Kimi model routed through OpenRouter
 * (`moonshotai/kimi-*`, or a further-aggregated `nous/moonshotai/...` slug)
 * hits the same 400 a direct api.moonshot.ai call would. Detection is by
 * MODEL NAME (`isMoonshotModel`), not host — OpenRouter is a single shared
 * host for every model family. Non-Kimi models pass through untouched.
 * Pure function — exported for unit testing.
 */
export function patchOpenRouterRequestBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  const modelId = typeof b['model'] === 'string' ? (b['model'] as string) : undefined;
  if (isMoonshotModel(modelId) && Array.isArray(b['tools'])) {
    b['tools'] = sanitizeMoonshotTools(b['tools']);
  }
  return body;
}

function createOpenRouterFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const tolerant = createTolerantFetch(baseFetch);

  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (!init?.body) return tolerant(input, init);

    let patchedInit = init;
    try {
      const rawBody =
        typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const patched = patchOpenRouterRequestBody(JSON.parse(rawBody));
      patchedInit = { ...init, body: JSON.stringify(patched) };
    } catch {
      // Malformed/streamed body — pass through unchanged rather than break the call.
    }

    return tolerant(input, patchedInit);
  };
}

export function buildOpenRouterModel(config: ProviderConfig): LanguageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError('openrouter provider requires an apiKey');
  }

  const baseURL = config.baseURL ?? PROVIDER_PRESETS.openrouter.defaultBaseURL;

  // Official OpenRouter provider (not the generic openai-compatible adapter):
  // it understands OpenRouter's unified reasoning format and preserves each
  // model's `reasoning_details` in the assistant message's providerMetadata for
  // a perfect round-trip across tool-call turns — the generic adapter only
  // round-trips a flat reasoning string and drops the structured details +
  // signatures that reasoning models (MiniMax M3, Gemini 3) require.
  const provider = createOpenRouter({
    apiKey: config.apiKey,
    baseURL,
    // 'strict' is the documented mode for the first-party OpenRouter API
    // ('compatible' is for 3rd-party proxies). We hit openrouter.ai directly.
    compatibility: 'strict',
    // OpenRouter attribution — surfaces this app in its public rankings/
    // analytics dashboard. `appUrl`/`appName` are the first-party SDK's typed
    // fields for this (they set HTTP-Referer / X-OpenRouter-Title internally;
    // there's no generic `headers` option on OpenRouterProviderSettings).
    // Static product identity, not per-user, so hardcoding is correct here
    // (unlike a user-scoped value, which must never be hardcoded).
    appUrl: 'https://github.com/Kwintspiracy/nodal-agents',
    appName: 'Nodal-Agents',
    // Normalise non-spec responses (e.g. DeepSeek V4 returning function.arguments
    // as an object instead of a JSON string) before the SDK's Zod schema sees
    // them, AND sanitize outgoing tool schemas for any Kimi model (native or
    // aggregator-routed) before OpenRouter relays them to Moonshot's inference.
    fetch: createOpenRouterFetch(),
  });

  // For reasoning models, explicitly enable reasoning so OpenRouter returns the
  // `reasoning_details` (rather than excluding them). Non-reasoning models are
  // unaffected. The runner then echoes those details back each turn via the
  // assistant message it replays. `extraBody` sends the raw `reasoning` body
  // param (the typed `reasoning` setting would also require max_tokens/effort).
  //
  // `usage: { include: true }` opts into OpenRouter's per-call billing metadata.
  // Without this flag the response may omit `usage.cost`; with it, cost is
  // always present (even when 0) and lands in `providerMetadata.openrouter.usage`
  // on the AI SDK response — read in execute.ts as the real dollar cost of this
  // call. Generic: applies to every OpenRouter model; no model-specific logic.
  //
  // `provider.order` pins the preferred upstream provider(s) for routing. When
  // set in the catalog (`providerOrder`), we forward it to OpenRouter so it
  // tries those upstreams first. `allow_fallbacks: true` means OpenRouter can
  // still route elsewhere if the preferred upstream is unavailable — we never
  // hard-fail on a routing preference. Generic: reads only catalog data, no
  // model-name branch.
  const base = provider.chat(config.model, {
    extraBody: buildOpenRouterExtraBody(config.model, config.reasoningEffort),
  });

  const middleware = middlewareForFamily(detectAgenticFamily(config.model));
  if (middleware) {
    return wrapLanguageModel({ model: base, middleware });
  }

  return base;
}
