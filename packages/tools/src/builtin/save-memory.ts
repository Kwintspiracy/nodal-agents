// Built-in: save_memory
// Write a durable fact to agent_memory via the canonical createMemory() entry
// point — which applies sanitation (anti-injection) and deduplication.

import { z } from 'zod';
import { createMemory, MemorySanitationError, MemoryDuplicateError } from '@nodal-agents/memory';
import { MEMORY_CATEGORIES } from '@nodal-agents/shared';
import type { ToolDefinition } from '../types';

export const SaveMemoryInputSchema = z.object({
  fact: z
    .string()
    .min(1)
    .describe('The durable fact to remember, stated as an assertion not a narrative.'),
  category: z.enum(MEMORY_CATEGORIES),
  importance: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('1-5. Use 4-5 only for facts that affect how future agents operate.'),
  skill_tags: z
    .array(z.string().max(60))
    .max(20)
    .optional()
    .describe('Optional skill slugs this memory is associated with.'),
});

export type SaveMemoryInput = z.infer<typeof SaveMemoryInputSchema>;

/**
 * Result of a save_memory call. `saved: false` is NOT an error — the tool ran
 * correctly, it just declined to persist a row (content blocked, or the fact is
 * already known). The LLM reads `reason` and moves on; the job is unaffected.
 */
export type SaveMemoryOutput = { saved: true; id: string } | { saved: false; reason: string };

export const saveMemoryTool: ToolDefinition<typeof SaveMemoryInputSchema, SaveMemoryOutput> = {
  name: 'save_memory',
  description:
    'Save a durable fact to long-term memory. Use the `save_memory` tool whenever (a) the user ' +
    'explicitly asks you to remember, save, or store something, OR (b) you learn a ' +
    'stable preference, rule, or context that will improve future unrelated tasks. ' +
    'Invoke `save_memory` once per fact — multiple invocations if the user gives multiple ' +
    "facts. Skip ephemeral details (today's weather, transient calculation results).",
  inputSchema: SaveMemoryInputSchema,
  riskLevel: 'write',
  card: 'text',
  execute: async (input, ctx) => {
    try {
      const memory = await createMemory(
        ctx.db,
        {
          entity_id: ctx.entityId,
          agent_id: ctx.agentId,
          fact: input.fact,
          category: input.category,
          importance: input.importance ?? 3,
          source: 'agent',
          skill_tags: input.skill_tags ?? [],
        },
        ctx.embeddingClient,
      );
      return { saved: true, id: memory.id };
    } catch (err) {
      if (err instanceof MemorySanitationError) {
        return { saved: false, reason: `Blocked: ${err.detail}` };
      }
      if (err instanceof MemoryDuplicateError) {
        return {
          saved: false,
          reason: `Already known (memory ${err.existingId}) — no new entry created.`,
        };
      }
      throw err;
    }
  },
};
