// Built-in: query_memory
// Read entity-scoped memories. With `query` set, runs a ranked keyword search;
// without it, lists the most relevant memories by the chosen sort.
// Entity-scoped, not agent-scoped: agents within the same entity share knowledge.

import { z } from 'zod';
import { agentMemory, eq, and, desc } from '@nodal-agents/db';
import { keywordSearchMemories } from '@nodal-agents/memory';
import type { ToolDefinition } from '../types';

export const QueryMemoryInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional free-text search. When set, memories are ranked by keyword match. ' +
        'Omit to list recent/important memories instead.',
    ),
  skill_tags: z
    .array(z.string().max(60))
    .optional()
    .describe(
      'Optional skill slugs to filter memories by. Returns all non-archived memories ' +
        'for this entity if omitted.',
    ),
  sort: z
    .enum(['importance', 'recent'])
    .optional()
    .describe("Result ordering: 'importance' (default) or 'recent'."),
  limit: z.number().int().min(1).max(200).optional().describe('Max rows to return. Default 50.'),
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
    'saved by other agents in this same workspace. Pass `query` to search by keywords, or ' +
    'filter by skill_tags for narrower lookups.',
  inputSchema: QueryMemoryInputSchema,
  riskLevel: 'write', // write because it updates last_accessed_at on matched rows
  card: 'text',
  execute: async (input, ctx) => {
    const sort = input.sort ?? 'importance';
    const limit = input.limit ?? 50;

    // ── Ranked keyword search path ────────────────────────────────────────────
    if (input.query) {
      const memories = await keywordSearchMemories(ctx.db, {
        query: input.query,
        entityId: ctx.entityId,
        skillTags: input.skill_tags,
        limit,
        sort,
      });
      return memories.map((m) => ({
        id: m.id,
        fact: m.fact,
        category: m.category,
        importance: m.importance,
        skill_tags: m.skill_tags,
        created_at: m.created_at ? new Date(m.created_at) : null,
      }));
    }

    // ── List path — entity-scoped, no free-text query ─────────────────────────
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
      .orderBy(sort === 'recent' ? desc(agentMemory.createdAt) : desc(agentMemory.importance))
      .limit(limit);

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
