// Built-in: mark_memory_outdated
// The agent saw a memory in its Persistent memory block AND knows it's stale or
// contradicted by newer information (user said "I moved to Lyon" but memory still
// says "user lives in Paris"). Archives the memory AND sets valid_to=now() so
// auto-injection drops it immediately. Original row is preserved (archived rows
// remain in the dashboard for audit).

import { z } from 'zod';
import { and, eq } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import { findMemoriesByFactSubstring, MemoryError } from '@nodal-agents/memory';
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
  description:
    'Mark a fact from your Persistent memory block as outdated when newer information ' +
    'in the current job contradicts or supersedes it. The memory is archived (not deleted) ' +
    'and dropped from your future auto-injection blocks. Identify the memory by quoting a ' +
    'unique substring from the fact text. Pair with save_memory(new fact) if a replacement ' +
    'is appropriate.',
  inputSchema: MarkMemoryOutdatedInputSchema,
  riskLevel: 'write',
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
      await ctx.db
        .update(agentMemory)
        .set({ archived: true, validTo: new Date(), updatedAt: new Date() })
        .where(and(eq(agentMemory.id, target.id), eq(agentMemory.entityId, ctx.entityId)));
      return { archived: true, id: target.id };
    } catch (err) {
      if (err instanceof MemoryError && err.code === 'INVALID_INPUT') {
        return { archived: false, reason: err.message };
      }
      throw err;
    }
  },
};
