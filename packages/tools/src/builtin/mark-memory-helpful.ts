// Built-in: mark_memory_helpful
// The agent saw a memory in its Persistent memory block AND used it productively.
// Bumps the memory's `importance` so it's more likely to stay in the budgeted
// auto-injection window. Self-tuning: useful facts get sticky, weak facts age
// out of the top-N over time.

import { z } from 'zod';
import { and, eq } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import { findMemoriesByFactSubstring, MemoryError } from '@nodal-agents/memory';
import type { ToolDefinition } from '../types';

export const MarkMemoryHelpfulInputSchema = z.object({
  fact_substring: z
    .string()
    .min(3)
    .describe(
      'A unique substring of the memory fact to mark helpful. Quote a few distinctive ' +
        'words from the fact text shown in the Persistent memory block. Min 3 chars.',
    ),
});

export type MarkMemoryHelpfulInput = z.infer<typeof MarkMemoryHelpfulInputSchema>;
export type MarkMemoryHelpfulOutput =
  | { marked: true; id: string; newImportance: number }
  | { marked: false; reason: string };

export const markMemoryHelpfulTool: ToolDefinition<
  typeof MarkMemoryHelpfulInputSchema,
  MarkMemoryHelpfulOutput
> = {
  name: 'mark_memory_helpful',
  description:
    'Mark a fact from your Persistent memory block as having been helpful in this job. ' +
    'Bumps its importance (capped at 5★) so the memory stays in your auto-injection ' +
    'window over time. Use sparingly — only for facts that materially shaped your answer. ' +
    'Identify the memory by quoting a unique substring from the fact text.',
  inputSchema: MarkMemoryHelpfulInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, ctx) => {
    try {
      const matches = await findMemoriesByFactSubstring(ctx.db, ctx.entityId, input.fact_substring);
      if (matches.length === 0) {
        return {
          marked: false,
          reason: `No memory matches "${input.fact_substring}". Check the Persistent memory block.`,
        };
      }
      if (matches.length > 1) {
        const preview = matches
          .slice(0, 3)
          .map((m) => `"${m.fact.slice(0, 60)}…"`)
          .join(', ');
        return {
          marked: false,
          reason: `Ambiguous: ${matches.length} memories match "${input.fact_substring}" (${preview}). Use a more specific substring.`,
        };
      }
      const target = matches[0]!;
      // F-9 (audit #2): a user-authored (source='manual') or importance-locked
      // memory is the user's own call, not the agent's to overturn — same
      // authority chain the curator respects (agent → curator → user, user
      // always wins). Refuse instead of silently re-weighting it.
      if (target.source === 'manual' || target.importance_locked) {
        return {
          marked: false,
          reason:
            'This memory was set by the user (manual or importance-locked) — the agent cannot adjust its importance.',
        };
      }
      const newImportance = Math.min(5, target.importance + 1);
      if (newImportance === target.importance) {
        // Already at the cap — no-op write, still return success so the LLM moves on.
        return { marked: true, id: target.id, newImportance };
      }
      await ctx.db
        .update(agentMemory)
        .set({ importance: newImportance, updatedAt: new Date() })
        .where(and(eq(agentMemory.id, target.id), eq(agentMemory.entityId, ctx.entityId)));
      return { marked: true, id: target.id, newImportance };
    } catch (err) {
      if (err instanceof MemoryError && err.code === 'INVALID_INPUT') {
        return { marked: false, reason: err.message };
      }
      throw err;
    }
  },
};
