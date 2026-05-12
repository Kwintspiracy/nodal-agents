// tool-call-middleware.ts — Native tool-call middleware for agentic LLMs
//
// DeepSeek V3/V4, Kimi K2, Qwen3-Coder and GLM-4 are trained to emit tool
// calls in their own textual markup (DeepSeek fullwidth unicode tokens,
// Kimi pipe-bracket tokens, Qwen/GLM JSON-in-XML tags). When the response
// doesn't match the OpenAI tool-call JSON schema, `@ai-sdk/openai-compatible`
// throws `APICallError: "Invalid JSON response"` and the job fails loud.
//
// This middleware follows the per-model-parser pattern:
//   - NO prompt modification — `tools=` is passed through to the provider
//     untouched, the LLM uses its trained native format
//   - `wrapGenerate` post-processes the response: if the provider extracted
//     tool calls into the content array, trust them; otherwise scan the raw
//     text content with the model-family-specific parser
//   - On `APICallError: "Invalid JSON response"`, catch the error, extract
//     the raw response body, and recover via the same parser — this restores
//     the job that would have failed otherwise

import {
  APICallError,
  UnsupportedFunctionalityError,
  type LanguageModelV3Middleware,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Content,
  type LanguageModelV3ToolCall,
} from '@ai-sdk/provider';

export type NativeToolCallParseResult = {
  /** Cleaned text (tool-call markup stripped). Empty string if all was markup. */
  text: string;
  /** Tool calls recovered from the raw text. Empty array if no markup found. */
  toolCalls: LanguageModelV3ToolCall[];
};

/**
 * Parses an LLM's raw assistant message text for native tool-call markup.
 * Implementations MUST NOT throw — malformed blocks should be skipped silently
 * so the surrounding text stays available for the operator/user.
 */
export type NativeToolCallParser = (text: string) => NativeToolCallParseResult;

export function createNativeToolCallMiddleware(
  parser: NativeToolCallParser,
): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',

    // No transformParams — we respect the model's training. The provider sends
    // `tools=` in its native OpenAI-format request; the LLM emits its native
    // markup; we adapt at the parse step. Zero prompt modification.

    wrapGenerate: async ({ doGenerate }) => {
      let result: LanguageModelV3GenerateResult;
      try {
        result = await doGenerate();
      } catch (err) {
        // The openai-compatible provider throws this exact error when it
        // can't parse the response body as OpenAI JSON. The body still has
        // the raw assistant text — we recover from it.
        if (
          err instanceof APICallError &&
          err.message === 'Invalid JSON response' &&
          typeof err.responseBody === 'string' &&
          err.responseBody.length > 0
        ) {
          const recovered = recoverFromResponseBody(err.responseBody, parser);
          if (recovered) return recovered;
        }
        // Anything else: re-throw — invariant #4, no silent fallback.
        throw err;
      }

      // If the provider already extracted tool calls into content, trust it.
      const hasToolCalls = result.content.some((c) => c.type === 'tool-call');
      if (hasToolCalls) return result;

      // Concatenate any text parts and feed them to the family parser.
      const rawText = result.content
        .filter((c): c is Extract<LanguageModelV3Content, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (rawText.length === 0) return result;

      const parsed = parser(rawText);
      if (parsed.toolCalls.length === 0) return result;

      // Replace the raw text content with cleaned text + recovered tool calls.
      // Non-text parts (reasoning, files, sources) are preserved.
      const nonText = result.content.filter((c) => c.type !== 'text');
      const newContent: LanguageModelV3Content[] = [];
      if (parsed.text.length > 0) newContent.push({ type: 'text', text: parsed.text });
      newContent.push(...parsed.toolCalls);
      newContent.push(...nonText);

      const wrapped: LanguageModelV3GenerateResult = {
        ...result,
        content: newContent,
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      };
      return wrapped;
    },

    // Streaming with text-based tool-call parsing requires buffering the full
    // response before regex extraction can run, which defeats streaming. Fail
    // loud rather than silently degrade. The NodalAI runner uses generateText
    // for jobs, so no caller hits this today; future callers see a clear error.
    wrapStream: async () => {
      throw new UnsupportedFunctionalityError({
        functionality: 'streamText with text-based tool-call parsing middleware',
      });
    },
  };
}

// ─── Recovery from APICallError("Invalid JSON response") ──────────────────────

function recoverFromResponseBody(
  responseBody: string,
  parser: NativeToolCallParser,
): LanguageModelV3GenerateResult | null {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {
    return null; // Body isn't even JSON — can't recover.
  }

  const content = extractAssistantContent(parsedBody);
  if (!content) return null;

  const { text, toolCalls } = parser(content);
  if (toolCalls.length === 0) return null;

  const newContent: LanguageModelV3Content[] = [];
  if (text.length > 0) newContent.push({ type: 'text', text });
  newContent.push(...toolCalls);

  const result: LanguageModelV3GenerateResult = {
    content: newContent,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: extractUsage(parsedBody),
    warnings: [
      {
        type: 'other',
        message:
          'Recovered tool calls from native model format after provider returned non-OpenAI-compatible JSON',
      },
    ],
  };
  return result;
}

function extractAssistantContent(body: unknown): string | null {
  // OpenAI / OpenRouter response shape: { choices: [{ message: { content: "..." }}] }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const choices = b['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}

function extractUsage(body: unknown): LanguageModelV3GenerateResult['usage'] {
  const fallback: LanguageModelV3GenerateResult['usage'] = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  if (typeof body !== 'object' || body === null) return fallback;
  const usage = (body as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null) return fallback;
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : undefined;
  const completionTokens =
    typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : undefined;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens,
      reasoning: undefined,
    },
  };
}
