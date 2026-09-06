// Built-in: return_result
// Pure state-machine signal: tells the runner the task is complete or blocked.
// Content delivery is handled by dedicated delivery tools (dashboard_publish,
// telegram_send_message, etc.) — NOT by return_result.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const ReturnResultInputSchema = z.object({
  status: z.enum(['success', 'blocked']),
  // When status='blocked', `reason` MUST explain WHY the agent is blocked and
  // what the user can do about it. Kept optional at the schema level so a
  // blocked call without a reason still parses and reaches the runner, which
  // nudges the agent for one (bounded) rather than failing the tool-parse
  // opaquely. The runner enforces non-empty on blocked and surfaces it to the
  // user — a blocked task must never leave the user without an explanation.
  reason: z.string().optional(),
});

export type ReturnResultInput = z.infer<typeof ReturnResultInputSchema>;

export const returnResultTool: ToolDefinition<typeof ReturnResultInputSchema, ReturnResultInput> = {
  name: 'return_result',
  description:
    'Signal that the task is complete (status="success") or blocked (status="blocked"). ' +
    'For content delivery to the user, use the appropriate delivery tool ' +
    '(`telegram_send_message`, `dashboard_publish`, etc.) — return_result carries no content. ' +
    'Whenever your task involves delivering an answer, emit `return_result` and the delivery ' +
    'tool(s) **in the same assistant turn** (parallel tool calls). The runner handles delivery ' +
    'failures automatically (defers finalization if a sibling tool errors), so there is no need ' +
    'to wait for tool results before signaling completion — splitting into separate turns ' +
    'doubles input token cost (the full conversation replays) for no benefit. ' +
    'Use status="blocked" if you cannot proceed after 2 attempts. When you set status="blocked" ' +
    'you MUST also set `reason` to a clear, user-facing explanation: name the SPECIFIC thing that ' +
    'blocked YOU on THIS task — the exact tool, credential, or input that failed and its actual ' +
    'error — and the concrete next step the user can take. Write it from scratch for this ' +
    'situation; never copy a generic example. The user sees this reason verbatim.',
  inputSchema: ReturnResultInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, _ctx) => {
    // return_result is structural — execution is a pass-through.
    // The runner reads the output to update job status.
    return input;
  },
};
