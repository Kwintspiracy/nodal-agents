// @nodal-agents/memory — find-by-substring helper for feedback tools

import { and, eq, ilike, sql } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import type { AgentMemory } from '@nodal-agents/shared';
import { rowToMemory } from './crud';
import type { MemoryRow } from './crud';
import { MemoryError } from './errors';

/**
 * Find unarchived, unexpired memories for an entity whose `fact` matches the
 * given substring (case-insensitive). Used by feedback-loop tools where the
 * agent addresses a memory by quoting part of its visible text (the system-
 * prompt block doesn't surface IDs — substring matching mirrors Hermes' UX).
 *
 * Returns up to `limit` rows (default 5) for the caller to dispatch on:
 *   - 0 rows → fail loud ("no memory matches"). Bad substring or stale ref.
 *   - 1 row  → operate on it.
 *   - 2+ rows → fail loud ("ambiguous; refine the substring").
 *
 * Substring must be at least 3 chars — single-word fragments like "a" would
 * match every memory and produce noise.
 */
export async function findMemoriesByFactSubstring(
  db: AnyDrizzleDb,
  entityId: string,
  substring: string,
  limit = 5,
): Promise<AgentMemory[]> {
  if (substring.length < 3) {
    throw new MemoryError(
      'INVALID_INPUT',
      `fact_substring must be at least 3 characters (got ${substring.length}).`,
    );
  }
  const rows = await db
    .select()
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.entityId, entityId),
        eq(agentMemory.archived, false),
        sql`(${agentMemory.validTo} IS NULL OR ${agentMemory.validTo} > now())`,
        ilike(agentMemory.fact, `%${substring}%`),
      ),
    )
    .limit(limit);

  return rows.map((row) => rowToMemory(row as MemoryRow));
}
