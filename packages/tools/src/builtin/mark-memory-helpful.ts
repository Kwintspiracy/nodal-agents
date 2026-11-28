// Built-in: mark_memory_helpful
// The agent saw a memory in its Persistent memory block AND used it productively.
// Bumps the memory's `importance` so it's more likely to stay in the budgeted
// auto-injection window. Self-tuning: useful facts get sticky, weak facts age
// out of the top-N over time.

import { z } from 'zod';
import { findMemoriesByFactSubstring, mutateMemory, MemoryError } from '@nodal-agents/memory';
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
  label: 'Mark a memory useful',
  summary: 'Give a memory more priority when it materially helped with a job.',
  description:
    'Mark a fact from your Persistent memory block as having been helpful in this job. ' +
    'Bumps its importance (capped at 5★) so the memory stays in your auto-injection ' +
    'window over time. Use sparingly — only for facts that materially shaped your answer. ' +
    'Identify the memory by quoting a unique substring from the fact text.',
  inputSchema: MarkMemoryHelpfulInputSchema,
  riskLevel: 'write',
  egress: 'none',
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
      // The owner's marks (a fact the owner wrote, a pinned fact), the version
      // this tool read, and the previous state kept: all in mutateMemory, the
      // one function every path changes a fact through (#1144). An agent never
      // changes an owner-marked fact, even when the owner asks in the
      // conversation: it tells the owner, who changes it from the Memory page.
      const newImportance = Math.min(5, target.importance + 1);
      const res =
        newImportance === target.importance
          ? null // Already at the cap: nothing to change, still a success so the LLM moves on.
          : await mutateMemory(ctx.db, {
              entityId: ctx.entityId,
              memoryId: target.id,
              readVersion: target.version,
              actor: { kind: 'agent', agentId: ctx.agentId },
              change: { kind: 'rescore', importance: newImportance },
              reason: 'marked helpful',
            });
      if (res && !res.ok) {
        return {
          marked: false,
          reason:
            res.reason === 'owner_protected'
              ? 'This memory was set by the user (written or pinned by them, importance-locked): only the user changes it, from the Memory page. Tell the user what should change; do not retry.'
              : res.detail,
        };
      }
      return { marked: true, id: target.id, newImportance };
    } catch (err) {
      if (err instanceof MemoryError && err.code === 'INVALID_INPUT') {
        return { marked: false, reason: err.message };
      }
      throw err;
    }
  },
};
