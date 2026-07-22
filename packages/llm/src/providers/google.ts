// @nodal-agents/llm — Google Generative AI (native, generativelanguage.googleapis.com)
//
// providerOptions is a CALL-level knob on the AI SDK (see deepseek.ts's doc
// comment for the same constraint on that provider) — this builder only sees
// the model id at CONSTRUCTION time, so a per-turn providerOptions can't be
// threaded through the generic runner. Mirrors deepseek.ts/minimax.ts/
// moonshot.ts: a host-gated fetch shim rewrites the outgoing request body
// directly instead.
//
// Thinking mode injection
// ------------------------
// @ai-sdk/google reads `providerOptions.google.thinkingConfig` and maps it
// verbatim onto `generationConfig.thinkingConfig` in the wire body (verified
// against @ai-sdk/google@3.0.72's dist/index.mjs doGenerate/getArgs:
// `generationConfig.thinkingConfig = googleOptions?.thinkingConfig`, body sent
// to `.../models/{model}:generateContent`). Since providerOptions can't be set
// per-call here, the shim writes `generationConfig.thinkingConfig` directly on
// the outgoing JSON body for catalog-flagged reasoning models (gemini-3.5-flash,
// gemini-3.1-pro-preview) — `{ includeThoughts: true }`, so the API returns the
// chain-of-thought parts (and the functionCall `thoughtSignature`) the
// reasoning round-trip in apps/runner/src/job/execute.ts depends on.
// Non-reasoning/custom models are left untouched.
//
// Not composed with createTolerantFetch: that shim only rewrites
// `/chat/completions`-shaped bodies (OpenAI-compatible protocol). Gemini's
// native REST endpoint (`:generateContent` / `:streamGenerateContent`) never
// matches that gate, so composing it here would be a guaranteed no-op.

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { ProviderConfig } from '../types';

const GOOGLE_HOSTS = new Set(['generativelanguage.googleapis.com']);

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
 * Inject `generationConfig.thinkingConfig = { includeThoughts: true }` into an
 * outgoing Gemini request body, unless the body already carries a
 * thinkingConfig (idempotent — never overwrite an explicit caller setting).
 *
 * Pure function — exported for unit testing.
 */
export function injectGoogleThinking(body: unknown, thinkingLevel?: string): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  const generationConfig =
    typeof b['generationConfig'] === 'object' && b['generationConfig'] !== null
      ? (b['generationConfig'] as Record<string, unknown>)
      : {};
  if (generationConfig['thinkingConfig'] === undefined) {
    generationConfig['thinkingConfig'] = {
      includeThoughts: true,
      // Gemini 3.x intensity knob. Absent (Auto) ⇒ model default, pre-feature
      // behavior. Levels come from the catalog's reasoningControl.
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }
  b['generationConfig'] = generationConfig;
  return body;
}

/**
 * Create a fetch wrapper that:
 * 1. Is HOST-GATED — only rewrites requests to generativelanguage.googleapis.com
 * 2. Injects `generationConfig.thinkingConfig` for reasoning-catalogued models
 */
function createGoogleFetch(
  opts: { injectThinking: boolean; thinkingLevel?: string },
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const host = requestHost(input);
    if (!opts.injectThinking || !host || !GOOGLE_HOSTS.has(host) || !init?.body) {
      return baseFetch(input, init);
    }

    let patchedInit = init;
    try {
      const rawBody =
        typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const patched = injectGoogleThinking(JSON.parse(rawBody), opts.thinkingLevel);
      patchedInit = { ...init, body: JSON.stringify(patched) };
    } catch {
      // Malformed/streamed body — pass through unchanged rather than break the call.
    }

    return baseFetch(input, patchedInit);
  };
}

export function buildGoogleModel(config: ProviderConfig): LanguageModel {
  // Gate thinking injection on the catalog reasoning flag — a custom/uncatalogued
  // model id defaults to false (no thinking injected), mirrors buildDeepSeekModel.
  const entry = findModelCatalogEntry('google', config.model);
  const isReasoning = entry?.capabilities.reasoning === true;

  // Gemini 3.x cannot disable thinking (catalog mandatory:true) — 'off' is
  // never offered by the UI; a level maps to thinkingConfig.thinkingLevel,
  // 'max' defensively clamps to 'high' (not a Gemini level). Auto ⇒ no level.
  const effort = config.reasoningEffort;
  const thinkingLevel =
    effort && effort !== 'off' ? (effort === 'max' ? 'high' : effort) : undefined;

  const provider = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    fetch: createGoogleFetch({ injectThinking: isReasoning, thinkingLevel }),
  });

  return provider(config.model);
}
