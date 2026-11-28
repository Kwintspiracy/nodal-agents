// packages/memory/src/curator.ts — Tier-2 MEMORY curator, Phase 1.
//
// transitionMemoryLifecycle: deterministic, usage-driven archival. It changes
// facts through `mutateMemory` (mutate.ts), like every other path: the
// version it read, the owner's marks in the WHERE, the previous state kept.
// The LLM pass (Phase 2, apps/runner/src/reflection/run-memory-curator.ts)
// calls `mutateMemory` directly.
//
// Archiving sets archived=true (reversible); there is no hard delete here.

import { agentMemory, and, eq, isNotNull, lt, sql, type AnyDrizzleDb } from '@nodal-agents/db';
import { mutateMemory } from './mutate';

export interface MemoryLifecycleResult {
  archived: number;
  /** Eligible facts the owner wrote or pinned: left as they are. */
  ownerProtected: number;
}

/**
 * Phase 1 — deterministic, no LLM. Archive memories that have EMPIRICALLY
 * proven useless: low importance, NEVER accessed (access_count = 0), and old
 * (created before now − staleDays). Reversible (archived=true), and the state
 * before is kept as a version naming the archiver.
 *
 * Who may be archived is NOT decided here: the owner's marks (a fact the owner
 * wrote, a pinned fact) are honoured by `mutateMemory` in the WHERE of its
 * UPDATE, the same rule for every path. Such a fact is counted in
 * `ownerProtected` and left untouched.
 */
export async function transitionMemoryLifecycle(
  db: AnyDrizzleDb,
  opts: { staleDays: number; importanceMax: number },
): Promise<MemoryLifecycleResult> {
  const cutoff = new Date(Date.now() - opts.staleDays * 24 * 60 * 60 * 1000);
  const eligible = await db
    .select({ id: agentMemory.id, entityId: agentMemory.entityId, version: agentMemory.version })
    .from(agentMemory)
    .where(
      and(
        // A change is made within a workspace (mutateMemory is scoped by it).
        isNotNull(agentMemory.entityId),
        eq(agentMemory.archived, false),
        sql`${agentMemory.importance} <= ${opts.importanceMax}`,
        sql`coalesce(${agentMemory.accessCount}, 0) = 0`,
        lt(agentMemory.createdAt, cutoff),
      ),
    );

  let archived = 0;
  let ownerProtected = 0;
  for (const row of eligible) {
    const r = await mutateMemory(db, {
      entityId: row.entityId!,
      memoryId: row.id,
      readVersion: row.version,
      actor: { kind: 'lifecycle' },
      change: { kind: 'archive' },
      reason: `never used, importance <= ${opts.importanceMax}, older than ${opts.staleDays} days`,
    });
    if (r.ok) archived += 1;
    else if (r.reason === 'owner_protected') ownerProtected += 1;
    // `stale` / `not_found`: the row changed or went away since the select;
    // the next tick reads it again.
  }
  return { archived, ownerProtected };
}
