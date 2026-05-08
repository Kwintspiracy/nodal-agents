// Built-in: return_result
// Pure state-machine signal: tells the runner the task is complete or blocked.
// Content delivery is handled by dedicated delivery tools (dashboard_publish,
// telegram_send_message, etc.) — NOT by return_result.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const ReturnResultInputSchema = z.object({
  status: z.enum(['success', 'blocked']),
});

export type ReturnResultInput = z.infer<typeof ReturnResultInputSchema>;

export const returnResultTool: ToolDefinition<typeof ReturnResultInputSchema, ReturnResultInput> = {
  name: 'return_result',
  description:
    'Signal that the task is complete (status="success") or blocked (status="blocked"). ' +
    'This is a pure state-machine signal — it does NOT deliver content to the user. ' +
    'To deliver content, use a delivery tool: `telegram_send_message`, `dashboard_publish`, etc. ' +
    'The user-facing answer ALWAYS lives in delivery tool args, never in return_result. ' +
    'Use status="blocked" if you cannot proceed after 2 attempts.',
  inputSchema: ReturnResultInputSchema,
  riskLevel: 'write',
  execute: async (input, _ctx) => {
    // return_result is structural — execution is a pass-through.
    // The runner reads the output to update job status.
    return input;
  },
};
