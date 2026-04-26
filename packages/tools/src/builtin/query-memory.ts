// Built-in: query_memory
// Read agent's memories with optional skill filter.

import { z } from 'zod';
import { agentMemory, eq, and } from '@nodalai/db';
import type { ToolDefinition } from '../types.js';

export const QueryMemoryInputSchema = z.object({
  skill_tags: z
    .array(z.string().max(60))
    .optional()
    .describe(
      'Optional skill slugs to filter memories by. Returns all non-archived memories ' +
        'for this agent if omitted.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Max rows to return. Default 50.'),
});

export type QueryMemoryInput = z.infer<typeof QueryMemoryInputSchema>;

export interface MemoryRecord {
  id: string;
  fact: string;
  category: string | null;
  importance: number | null;
  skill_tags: string[] | null;
  created_at: Date | null;
}

export const queryMemoryTool: ToolDefinition<typeof QueryMemoryInputSchema, MemoryRecord[]> = {
  name: 'query_memory',
  description:
    'Read your persistent memories. Use before starting a task to recall relevant context, ' +
    'preferences, and learned rules. Filter by skill_tags to retrieve skill-specific memories.',
  inputSchema: QueryMemoryInputSchema,
  riskLevel: 'write', // write because it updates last_accessed_at — consistent with legacy
  execute: async (input, ctx) => {
    const conditions = [eq(agentMemory.agentId, ctx.agentId), eq(agentMemory.archived, false)];

    const rows = await ctx.db
      .select({
        id: agentMemory.id,
        fact: agentMemory.fact,
        category: agentMemory.category,
        importance: agentMemory.importance,
        skill_tags: agentMemory.skillTags,
        created_at: agentMemory.createdAt,
      })
      .from(agentMemory)
      .where(and(...conditions))
      .limit(input.limit ?? 50);

    // Filter by skill_tags in-process (array overlap — pglite doesn't support
    // the @> operator natively without custom SQL; keep it simple for now).
    if (input.skill_tags && input.skill_tags.length > 0) {
      const tagSet = new Set(input.skill_tags);
      return rows.filter((r) => {
        const tags = r.skill_tags ?? [];
        return tags.some((t) => tagSet.has(t));
      });
    }

    return rows;
  },
};
