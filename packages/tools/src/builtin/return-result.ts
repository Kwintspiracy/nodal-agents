// Built-in: return_result
// Agent reports its final result. Required for any agent — the exit door.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const ReturnResultInputSchema = z.object({
  status: z.enum(['success', 'blocked']),
  text: z
    .string()
    .min(1)
    .describe(
      'The complete final answer the user should receive. Put the FULL response text here — not a summary, not a TL;DR, not a label. This is the only field that lands in the user-facing result. There is no separate "data" or "details" channel.',
    ),
});

export type ReturnResultInput = z.infer<typeof ReturnResultInputSchema>;

export const returnResultTool: ToolDefinition<typeof ReturnResultInputSchema, ReturnResultInput> = {
  name: 'return_result',
  description:
    'Report the final result of your task. Use `return_result` when the task is complete or when ' +
    'you are blocked and cannot proceed. The `text` field MUST contain the COMPLETE answer the user ' +
    'will receive — not a summary, not a label, not a header. Whatever you write in `text` is what ' +
    "the user sees. Use status='success' when the task succeeded, status='blocked' when data is not " +
    'found or you cannot proceed after 2 attempts.',
  inputSchema: ReturnResultInputSchema,
  riskLevel: 'write',
  execute: async (input, _ctx) => {
    // return_result is structural — execution is a pass-through.
    // The runner reads the output to update job status.
    return input;
  },
};
