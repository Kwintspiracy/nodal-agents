// @nodal-agents/llm — what a response REPORTS having used, and nothing else.
//
// Codex review of #571: an unknown usage never becomes a number. A count the
// provider did not give is `null`, whatever shape its absence takes:
//   - absent or not finite (`undefined`, `NaN`): the AI SDK passes through
//     what the provider sent;
//   - a 0 that cannot be true. Every request sends a prompt, so 0 input
//     tokens is a default, not a count; and a reply that wrote something
//     (text, reasoning, a tool call) cannot have written 0 tokens. Verified on
//     `ollama-ai-provider-v2`, which turns a missing `eval_count` into 0
//     (`dist/index.mjs`: `total: (_b = typedResponse.eval_count) != null ? _b : 0`).
//     The rule is about the response, not about one provider: any provider
//     whose missing count reaches us as 0 is read the same way.
//
// One rule, read by the client (the refusal of a turn whose completeness
// cannot be established, and the llm_calls observation) and by the runner
// (the job's totals), so that no caller turns an unknown into 0 on its own.

export interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function reportedUsage(result: {
  usage?: { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  text?: unknown;
  reasoningText?: unknown;
  toolCalls?: readonly unknown[] | undefined;
}): ReportedUsage {
  const input = finiteOrNull(result.usage?.inputTokens);
  const output = finiteOrNull(result.usage?.outputTokens);
  const wrote =
    (result.toolCalls?.length ?? 0) > 0 || nonEmpty(result.text) || nonEmpty(result.reasoningText);
  return {
    inputTokens: input === 0 ? null : input,
    outputTokens: output === 0 && wrote ? null : output,
  };
}
