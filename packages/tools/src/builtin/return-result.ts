// Built-in: return_result
// Pure state-machine signal: tells the runner the task is complete or blocked.
// It carries no content: the answer is the agent's written reply, or a send
// tool's message when the job's reply goes to a chat (#649) — never return_result.

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
  // The FILES this run delivers, named by the agent (issue #509). Each one is
  // checked before the run can end as a success: a missing or broken file is
  // reported, never accepted. The runner reads this field; the tool's own
  // execute does nothing with it (see `execute`).
  deliverables: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'The files this run delivers, one path each, resolved like the file tools resolve ' +
        'theirs (workspace label, relative to your single folder, or absolute inside an ' +
        'attached folder). List EVERY file you deliver, whatever tool or command produced ' +
        'it: a render, a build output, an export, a file you wrote. Nodal checks each one ' +
        'before the run can end as a success; a missing or broken file is reported, never ' +
        'accepted. When present, the list is COMPLETE: it replaces any list you gave earlier in ' +
        'this run, so a file you no longer deliver is simply left out. Omit the field to keep ' +
        'your earlier list, or when the task delivers no file.',
    ),
});

export type ReturnResultInput = z.infer<typeof ReturnResultInputSchema>;

export const returnResultTool: ToolDefinition<typeof ReturnResultInputSchema, ReturnResultInput> = {
  name: 'return_result',
  label: 'Finish a task',
  summary:
    'Report that a task succeeded or is blocked. It sends no answer by itself: the agent delivers its answer in the same step, through the right channel.',
  description:
    'Signal that the task is complete (status="success") or blocked (status="blocked"). ' +
    'return_result carries no content: your answer is your written reply, unless the ' +
    '`delivery:` line of your Job context says a send tool is the only way your replies reach ' +
    'the user. On a DELEGATED sub-task you have no delivery tool: your written reply is the delivery, so ' +
    'write your deliverable as your reply text in the same turn. Signalling success with no ' +
    'reply and no delivery hands back an empty result and the run is failed, not accepted. ' +
    'When a send tool carries your reply (the `delivery:` line says so), emit it and ' +
    '`return_result` **in the same assistant turn** (parallel tool calls). The runner handles delivery ' +
    'failures automatically (defers finalization if a sibling tool errors), so there is no need ' +
    'to wait for tool results before signaling completion — splitting into separate turns ' +
    'doubles input token cost (the full conversation replays) for no benefit. ' +
    'When the task delivers FILES, list every one of them in `deliverables` with status="success", ' +
    'whatever tool or command produced it (a file you wrote, a render, a build output, an ' +
    'export). Nodal checks each listed file before the run can end as a success: a missing ' +
    'or broken file is reported, never accepted, and the run does not end as a success. ' +
    'status="success" means you did everything that was yours to do. When a TOOL RETURNED a ' +
    'state waiting on a person in its output (a pending confirmation, an approval request, a ' +
    'card to click, whatever it is called), the result is DELIVERED, not blocked: write in ' +
    'your reply what waits, who decides and where (on a delegated task, that reply is what ' +
    'your orchestrator reads). Only the approval gate Nodal itself puts BEFORE calling a tool ' +
    'suspends the run on its own: do not declare that one. ' +
    'status="blocked" means YOUR part could not be done after 2 attempts: the requested ' +
    'action itself failed or could not be called (even if you prepared something in its ' +
    'place), or an input or an access is missing. When you set status="blocked" ' +
    'you MUST also set `reason` to a clear, user-facing explanation: name the SPECIFIC thing that ' +
    'blocked YOU on THIS task — the exact tool, credential, or input that failed and its actual ' +
    'error — and the concrete next step the user can take. Write it from scratch for this ' +
    'situation; never copy a generic example. The user sees this reason verbatim.',
  inputSchema: ReturnResultInputSchema,
  riskLevel: 'write',
  loading: 'eager',
  card: 'text',
  execute: async (input, _ctx) => {
    // return_result is structural — execution is a pass-through.
    // The runner reads the output to update job status.
    return input;
  },
};
