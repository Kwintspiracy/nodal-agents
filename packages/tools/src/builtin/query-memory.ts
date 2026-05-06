// Built-in: query_memory
// Read entity-scoped memories with optional skill filter.
// Entity-scoped, not agent-scoped: agents within the same entity share knowledge.

import { z } from 'zod';
import { agentMemory, eq, and } from '@nodalai/db';
import type { ToolDefinition } from '../types';

export const QueryMemoryInputSchema = z.object({
  skill_tags: z
    .array(z.string().max(60))
    .optional()
    .describe(
      'Optional skill slugs to filter memories by. Returns all non-archived memories ' +
        'for this entity if omitted.',
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
    'Read persistent memories shared across all agents in your entity. Use before starting a ' +
    'task to recall relevant context, user preferences, and learned rules — including memories ' +
    'saved by other agents in this same workspace. Filter by skill_tags for narrower lookups.',
  inputSchema: QueryMemoryInputSchema,
  riskLevel: 'write', // write because it updates last_accessed_at — consistent with legacy
  execute: async (input, ctx) => {
    // Entity-scoped read: any agent in the same entity sees the same memories.
    // Memories ARE still tagged with the agentId that wrote them (audit trail
    // via save_memory) but reads are entity-wide so knowledge follows the user
    // across agents.
    const conditions = [eq(agentMemory.entityId, ctx.entityId), eq(agentMemory.archived, false)];

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
