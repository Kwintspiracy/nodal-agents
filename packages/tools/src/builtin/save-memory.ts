// Built-in: save_memory
// Write a durable fact to agent_memory table.

import { z } from 'zod';
import { agentMemory } from '@nodalai/db';
import { MEMORY_CATEGORIES } from '@nodalai/shared';
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

export const saveMemoryTool: ToolDefinition<typeof SaveMemoryInputSchema, { id: string }> = {
  name: 'save_memory',
  description:
    'Save a durable fact to long-term memory. Use the `save_memory` tool whenever (a) the user ' +
    'explicitly asks you to remember, save, or store something, OR (b) you learn a ' +
    'stable preference, rule, or context that will improve future unrelated tasks. ' +
    'Invoke `save_memory` once per fact — multiple invocations if the user gives multiple ' +
    "facts. Skip ephemeral details (today's weather, transient calculation results).",
  inputSchema: SaveMemoryInputSchema,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .insert(agentMemory)
      .values({
        entityId: ctx.entityId,
        agentId: ctx.agentId,
        fact: input.fact,
        category: input.category,
        importance: input.importance ?? 3,
        source: 'agent',
        skillTags: input.skill_tags ?? [],
      })
      .returning({ id: agentMemory.id });

    if (!row) {
      throw new Error('save_memory_insert_failed');
    }

    return { id: row.id };
  },
};
