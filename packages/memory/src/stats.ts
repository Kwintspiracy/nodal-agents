// @nodalai/memory — stats aggregation

import { eq, and, sql, desc, avg, max } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { agentMemory } from '@nodalai/db';
import type { MemoryCategory } from '@nodalai/shared';
import { MEMORY_CATEGORIES } from '@nodalai/shared';
import type { MemoryStats } from './types.js';

export async function getMemoryStats(
  db: AnyDrizzleDb,
  scope: { entityId: string; agentId?: string },
): Promise<MemoryStats> {
  const { entityId, agentId } = scope;

  const baseWhere = agentId
    ? and(
        eq(agentMemory.entityId, entityId),
        eq(agentMemory.agentId, agentId),
        eq(agentMemory.archived, false),
      )
    : and(eq(agentMemory.entityId, entityId), eq(agentMemory.archived, false));

  // ── Total count, average importance, last access ──────────────────────────
  const aggRows = await db
    .select({
      total: sql<string>`count(*)`,
      avgImportance: avg(agentMemory.importance),
      lastAccess: max(agentMemory.lastAccessedAt),
    })
    .from(agentMemory)
    .where(baseWhere);

  const agg = aggRows[0];
  const totalCount = Number(agg?.total ?? 0);
  const averageImportance =
    agg?.avgImportance !== null && agg?.avgImportance !== undefined ? Number(agg.avgImportance) : 0;
  const lastAccessAt = agg?.lastAccess
    ? agg.lastAccess instanceof Date
      ? agg.lastAccess.toISOString()
      : String(agg.lastAccess)
    : null;

  // ── Count by category ─────────────────────────────────────────────────────
  const catRows = await db
    .select({
      category: agentMemory.category,
      cnt: sql<string>`count(*)`,
    })
    .from(agentMemory)
    .where(baseWhere)
    .groupBy(agentMemory.category);

  const countByCategory = Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, 0])) as Record<
    MemoryCategory,
    number
  >;

  for (const row of catRows) {
    const cat = row.category as MemoryCategory | null;
    if (cat && cat in countByCategory) {
      countByCategory[cat] = Number(row.cnt);
    }
  }

  // ── Count by tag ──────────────────────────────────────────────────────────
  // Unnest skill_tags array, count occurrences, sort descending
  const tagRows = await db
    .select({
      tag: sql<string>`unnested_tag`,
      cnt: sql<string>`count(*)`,
    })
    .from(
      sql`(
        SELECT unnest(${agentMemory.skillTags}) AS unnested_tag
        FROM ${agentMemory}
        WHERE ${baseWhere}
      ) AS tags`,
    )
    .groupBy(sql`unnested_tag`)
    .orderBy(desc(sql`count(*)`));

  const countByTag = (tagRows as Array<{ tag: string; cnt: string }>).map((r) => ({
    tag: r.tag,
    count: Number(r.cnt),
  }));

  return {
    totalCount,
    countByCategory,
    countByTag,
    lastAccessAt,
    averageImportance,
  };
}
