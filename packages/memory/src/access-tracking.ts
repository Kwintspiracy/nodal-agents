// @nodal-agents/memory — access tracking (bump last_accessed_at + access_count)

import { eq, and, sql } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';

/**
 * Bump last_accessed_at to now() and increment access_count by 1.
 * Silent no-op if the memory doesn't exist (avoids crashes in search result
 * processing when a race condition removes a memory between query and touch).
 */
export async function touchMemory(db: AnyDrizzleDb, id: string, entityId: string): Promise<void> {
  await db
    .update(agentMemory)
    .set({
      lastAccessedAt: sql`now()`,
      accessCount: sql`${agentMemory.accessCount} + 1`,
    })
    .where(and(eq(agentMemory.id, id), eq(agentMemory.entityId, entityId)));
}

/**
 * Batch version — touches multiple memories in parallel.
 * Failures are swallowed individually so one bad ID doesn't abort the batch.
 */
export async function touchMemories(
  db: AnyDrizzleDb,
  ids: string[],
  entityId: string,
): Promise<void> {
  if (ids.length === 0) return;

  await Promise.allSettled(ids.map((id) => touchMemory(db, id, entityId)));
}
