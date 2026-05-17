// tolerant-fetch.ts — fetch wrapper that normalises OpenAI-compatible chat
// responses before AI SDK's Zod schema sees them.
//
// Problem
// -------
// `@ai-sdk/openai-compatible` validates chat responses with a strict-ish Zod
// schema that requires `choices[i].message.tool_calls[i].function.arguments`
// to be a string. OpenRouter-hosted OSS models (DeepSeek V4 Pro in particular,
// but also some Qwen/GLM responses) occasionally return `arguments` as an
// already-parsed object — the spec says it MUST be a string, but providers
// drift. When that happens AI SDK throws `APICallError("Invalid JSON response")`
// and the job dies with `Retry exhausted` regardless of how many retries we add.
//
// Approach
// --------
// One intervention at the transport boundary: intercept the response *body*
// (not the schema, not the middleware, not a recovery hook), re-shape the
// known mismatch in-place, return a fresh Response with cleaned JSON. AI SDK's
// Zod parser then accepts it normally and the rest of the pipeline behaves as
// if the provider had been spec-compliant.
//
// This replaces three layers of model-specific patching:
//   1. The per-family native parser middlewares (deepseek/kimi/nodal)
//      only fire if the LLM genuinely emits its own markup — which DeepSeek V4
//      Pro doesn't, it emits standard OpenAI `tool_calls` with object args.
//   2. The `recoverFromResponseBody` hack in `tool-call-middleware.ts` is
//      now dead code for the common case (kept for legacy native-markup paths).
//   3. The `extractOpenAIToolCalls` helper is no longer needed in recovery.
//
// Scope: applied only to chat-completions endpoints (`/chat/completions` in the
// URL). Streaming, embeddings, other endpoints pass through unchanged.

// Matches `FetchFunction` from `@ai-sdk/provider-utils` (= `typeof globalThis.fetch`).
// We type it locally to avoid pulling a direct dep just for the alias.
type FetchLike = typeof globalThis.fetch;

/** Wraps fetch to normalise OpenAI-compatible chat responses. */
export function createTolerantFetch(baseFetch: FetchLike = globalThis.fetch): FetchLike {
  return async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const response = await baseFetch(input, init);

    if (!isChatCompletionsRequest(input) || !isJsonResponse(response)) {
      return response;
    }

    // Only touch non-streaming JSON responses. Streaming uses SSE chunks which
    // have their own parser path in AI SDK and a different schema.
    const text = await response.text();
    const normalised = normaliseChatResponseBody(text);
    if (normalised === text) {
      // Hot path: no rewrite needed. Rebuild Response from the body we already
      // consumed so the caller can still read it.
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return new Response(normalised, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Rewrite a raw chat-completions response body so it matches what AI SDK's
 * Zod schema expects. Returns the input unchanged if no rewrite is needed or
 * the body isn't JSON we recognise.
 */
export function normaliseChatResponseBody(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof body !== 'object' || body === null) return text;

  const choices = (body as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return text;

  let mutated = false;
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = (choice as Record<string, unknown>)['message'];
    if (typeof message !== 'object' || message === null) continue;
    const toolCalls = (message as Record<string, unknown>)['tool_calls'];
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue;
      const fn = (call as Record<string, unknown>)['function'];
      if (typeof fn !== 'object' || fn === null) continue;
      const args = (fn as Record<string, unknown>)['arguments'];
      // The schema requires arguments to be a string. Providers that return
      // an object or null cause "Invalid JSON response" — coerce them.
      if (args === null || args === undefined) {
        (fn as Record<string, unknown>)['arguments'] = '{}';
        mutated = true;
      } else if (typeof args === 'object') {
        (fn as Record<string, unknown>)['arguments'] = JSON.stringify(args);
        mutated = true;
      } else if (typeof args !== 'string') {
        // Numbers/booleans aren't valid args either; coerce to a string.
        (fn as Record<string, unknown>)['arguments'] = String(args);
        mutated = true;
      }
    }
  }

  return mutated ? JSON.stringify(body) : text;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isChatCompletionsRequest(input: Parameters<FetchLike>[0]): boolean {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else {
    url = (input as Request).url;
  }
  return url.includes('/chat/completions');
}

function isJsonResponse(response: Response): boolean {
  if (!response.ok) return false;
  const contentType = response.headers.get('content-type') ?? '';
  // Skip event streams (SSE / streaming) and anything that's not JSON.
  if (contentType.includes('text/event-stream')) return false;
  return contentType.includes('application/json');
}
