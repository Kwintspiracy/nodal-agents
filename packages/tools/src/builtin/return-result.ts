// Built-in: return_result
// Agent reports its final result. Required for any agent — the exit door.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const ReturnResultInputSchema = z.object({
  status: z.enum(['success', 'blocked']),
  summary: z.string().min(1),
  data: z.unknown().optional(),
});

export type ReturnResultInput = z.infer<typeof ReturnResultInputSchema>;

export const returnResultTool: ToolDefinition<typeof ReturnResultInputSchema, ReturnResultInput> = {
  name: 'return_result',
  description:
    'Report the final result of your task. Use `return_result` when the task is complete or when ' +
    "you are blocked and cannot proceed. Use status='success' when the task succeeded, " +
    "status='blocked' when data is not found or you cannot proceed after 2 attempts.",
  inputSchema: ReturnResultInputSchema,
  riskLevel: 'write',
  execute: async (input, _ctx) => {
    // return_result is structural — execution is a pass-through.
    // The runner reads the output to update job status.
    return input;
  },
};
