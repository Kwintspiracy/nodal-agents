// @nodal-agents/llm — which providers ALWAYS report the output tokens of a reply
//
// A turn whose output count is not reported cannot be judged against the cap
// it stated (#563). Refusing it is right only where that absence is abnormal:
// where the provider reports the count on every reply of that path. Elsewhere
// an absent count is the provider's normal behaviour, and refusing would turn
// every tool turn of that provider red (Nodal review of #571, 2026-09-28). The
// turn then goes on, and its unknown count stays null up to the llm_calls row
// and the job row (`reportedUsage`), never 0.
//
// One row per provider of `CAPABILITY_MATRIX`, one column per path the client
// takes for a turn: `oneShot` (generateText) and `streamed` (streamText under
// the turn clocks). `true` only with a source, read on 2026-10-13:
//   - SCHEMA: the SDK's own response schema requires the output count on that
//     path (`z.number()`, not `.nullish()`), so a reply without it is refused
//     by the SDK itself. What can still reach the client is the 0 a stream
//     starts from when the event carrying the count never came: a truncated
//     stream, abnormal by construction. It holds for the provider the SDK is
//     written for, not for another server the same SDK is pointed at;
//   - DOC: the provider's official documentation says the count is returned
//     on every reply of that path.
// `false` where neither holds: the SDK tolerates an absent count and no
// official page says it is always sent. A row moves to `true` only with its
// source written next to it.

import type { ProviderName } from '../types';

export interface OutputUsageReporting {
  /** One-shot reply (generateText). */
  oneShot: boolean;
  /** Streamed reply (streamText). */
  streamed: boolean;
}

export const REPORTS_OUTPUT_USAGE: Record<ProviderName, OutputUsageReporting> = {
  // SCHEMA, @ai-sdk/anthropic 3.0.76 dist/index.mjs: the message's
  // `usage.output_tokens: z.number()`, and the stream's `message_delta`
  // `usage.output_tokens: z.number()` (the stream starts from 0 until it).
  anthropic: { oneShot: true, streamed: true },
  // The Anthropic SDK on MiniMax's Anthropic-compatible endpoint. The SDK's
  // schema says what it accepts, not what MiniMax's server sends, and
  // platform.minimax.io/docs/api-reference/text-anthropic-api (read 2026-10-13)
  // does not document `usage` on either path (Nodal review of #571, pass 1).
  minimax: { oneShot: false, streamed: false },
  // DOC, openrouter.ai/docs/use-cases/usage-accounting: usage "is always
  // returned", "in the last SSE message for streaming responses, or in the
  // complete response for non-streaming requests"; no parameter needed.
  openrouter: { oneShot: true, streamed: true },
  // streamed: SCHEMA, @ai-sdk/openai 3.0.63 (Responses API): the
  // `response.completed` / `response.incomplete` event's
  // `usage.output_tokens: z.number()`. oneShot: the response schema has
  // `usage: ….optional()`, and no official page was read that says it is
  // always present.
  openai: { oneShot: false, streamed: true },
  // streamed: DOC, api-docs.deepseek.com/api/create-chat-completion: "the
  // final chunk before data: [DONE] carries the full-request statistics" (and
  // @ai-sdk/deepseek 2.0.38 sends `stream_options.include_usage`). oneShot:
  // the same page does not mark `usage` as required, and the SDK schema is
  // `.nullish()`.
  deepseek: { oneShot: false, streamed: true },
  // oneShot: SCHEMA, @ai-sdk/mistral 3.0.36: `usage: mistralUsageSchema`, with
  // `completion_tokens: z.number()`. streamed: the chunk's usage is
  // `.nullish()` and docs.mistral.ai does not say the last chunk carries it.
  mistral: { oneShot: true, streamed: false },
  // @ai-sdk/groq 3.0.39: `completion_tokens` is `.nullish()` on both paths
  // (stream: `x_groq.usage`), and console.groq.com/docs/api-reference does not
  // say usage is always returned.
  groq: { oneShot: false, streamed: false },
  // @ai-sdk/google 3.0.72: `usageMetadata` and `candidatesTokenCount` are
  // `.nullish()` (a missing count becomes 0); no page read says always.
  google: { oneShot: false, streamed: false },
  // ollama-ai-provider-v2 3.5.0 turns a missing `eval_count` into 0.
  ollama: { oneShot: false, streamed: false },
  // Any server speaking the OpenAI wire (LM Studio, vLLM, llama.cpp, Jan…):
  // nothing is guaranteed of a server we do not know.
  'openai-compatible': { oneShot: false, streamed: false },
  // @ai-sdk/openai-compatible 2.0.47 (usage `.nullish()`); no page read on
  // platform.moonshot.ai says always.
  moonshot: { oneShot: false, streamed: false },
};
