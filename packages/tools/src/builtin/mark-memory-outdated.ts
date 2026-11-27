// Built-in: mark_memory_outdated
// The agent saw a memory in its Persistent memory block AND knows it's stale or
// contradicted by newer information (user said "I moved to Lyon" but memory still
// says "user lives in Paris"). Retires the memory (archived, valid_to=now()) so
// auto-injection drops it immediately, through mutateMemory: the state before
// is kept with the agent and the reason, and the owner can put it back.

import { z } from 'zod';
import { findMemoriesByFactSubstring, mutateMemory, MemoryError } from '@nodal-agents/memory';
import type { ToolDefinition } from '../types';

export const MarkMemoryOutdatedInputSchema = z.object({
  fact_substring: z
    .string()
    .min(3)
    .describe(
      'A unique substring of the outdated memory fact. Quote distinctive words from ' +
        'the Persistent memory block. Min 3 chars.',
    ),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Brief justification for marking outdated — surfaces in the dashboard for the user.'),
});

export type MarkMemoryOutdatedInput = z.infer<typeof MarkMemoryOutdatedInputSchema>;
export type MarkMemoryOutdatedOutput =
  | { archived: true; id: string }
  | { archived: false; reason: string };

export const markMemoryOutdatedTool: ToolDefinition<
  typeof MarkMemoryOutdatedInputSchema,
  MarkMemoryOutdatedOutput
> = {
  name: 'mark_memory_outdated',
  label: 'Mark a memory outdated',
  summary: 'Archive a memory that newer information has replaced.',
  description:
    'Mark a fact from your Persistent memory block as outdated when newer information ' +
    'in the current job contradicts or supersedes it. The memory is archived (not deleted) ' +
    'and dropped from your future auto-injection blocks. Identify the memory by quoting a ' +
    'unique substring from the fact text. Pair with save_memory(new fact) if a replacement ' +
    'is appropriate.',
  inputSchema: MarkMemoryOutdatedInputSchema,
  riskLevel: 'write',
  egress: 'none',
  loading: 'eager',
  card: 'text',
  execute: async (input, ctx) => {
    try {
      const matches = await findMemoriesByFactSubstring(ctx.db, ctx.entityId, input.fact_substring);
      if (matches.length === 0) {
        return {
          archived: false,
          reason: `No memory matches "${input.fact_substring}". Check the Persistent memory block.`,
        };
      }
      if (matches.length > 1) {
        const preview = matches
          .slice(0, 3)
          .map((m) => `"${m.fact.slice(0, 60)}…"`)
          .join(', ');
        return {
          archived: false,
          reason: `Ambiguous: ${matches.length} memories match "${input.fact_substring}" (${preview}). Use a more specific substring.`,
        };
      }
      const target = matches[0]!;
      // The owner's marks (a fact the owner wrote, a pinned fact), the version
      // this tool read, and the previous state kept: all in mutateMemory, the
      // one function every path changes a fact through (#1144). An agent never
      // changes an owner-marked fact, even when the owner asks in the
      // conversation: it tells the owner, who changes it from the Memory page.
      const res = await mutateMemory(ctx.db, {
        entityId: ctx.entityId,
        memoryId: target.id,
        readVersion: target.version,
        actor: { kind: 'agent', agentId: ctx.agentId },
        change: { kind: 'retire' },
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      if (!res.ok) {
        return {
          archived: false,
          reason:
            res.reason === 'owner_protected'
              ? 'This memory was set by the user (written or pinned by them, importance-locked): only the user changes it, from the Memory page. Tell the user what should change; do not retry.'
              : res.detail,
        };
      }
      return { archived: true, id: target.id };
    } catch (err) {
      if (err instanceof MemoryError && err.code === 'INVALID_INPUT') {
        return { archived: false, reason: err.message };
      }
      throw err;
    }
  },
};
