// _mock-helpers.ts — shared helpers for V3 mock model setup
// AI SDK v6 changed LanguageModelV1 → V3 — usage/finishReason/content shapes
// were all reshaped. These helpers wrap the verbose new shapes so test fixtures
// stay readable.

import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';

export const mockUsage = (
  input: number,
  output: number,
): LanguageModelV3GenerateResult['usage'] => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

export const mockTextResult = (
  text: string,
  usage: { input: number; output: number } = { input: 1, output: 1 },
): LanguageModelV3GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: mockUsage(usage.input, usage.output),
  warnings: [],
});

export const mockToolCallResult = (
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
  usage: { input: number; output: number } = { input: 1, output: 1 },
): LanguageModelV3GenerateResult => ({
  content: toolCalls.map((tc) => ({ type: 'tool-call' as const, ...tc })),
  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
  usage: mockUsage(usage.input, usage.output),
  warnings: [],
});
