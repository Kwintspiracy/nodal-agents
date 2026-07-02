// packages/memory/src/curator.ts — Tier-2 MEMORY curator repo helpers.
//
// The memory analog of the skill-curator helpers (packages/db repos/skills.ts):
//   - transitionMemoryLifecycle: deterministic, usage-driven archival (Phase 1).
//   - archiveAgentMemory / updateAgentMemoryFact: provenance-guarded mutations
//     the LLM curation pass (Phase 2, runMemoryCuration) calls.
//
// Conservative BY CONSTRUCTION:
//   - NEVER touches source='manual' (facts the user entered by hand).
//   - Archiving sets archived=true (reversible); there is no hard delete here.

import { agentMemory, and, eq, sql, type AnyDrizzleDb } from '@nodal-agents/db';
import { computeFactHash } from './hash';

export interface MemoryLifecycleResult {
  archived: number;
}

/**
 * Phase 1 — deterministic, no LLM. Archive agent-authored memories that have
 * EMPIRICALLY proven useless: low importance, NEVER accessed (access_count = 0),
 * and old (created before now − staleDays). This is the usage-driven "keep only
 * what's actually been used" signal — sounder than a one-shot importance guess.
 * Reversible (archived=true). Only source IN ('agent','reflection') is eligible;
 * user-entered facts are never archived by the curator.
 */
export async function transitionMemoryLifecycle(
  db: AnyDrizzleDb,
  opts: { staleDays: number; importanceMax: number },
): Promise<MemoryLifecycleResult> {
  const cutoff = new Date(Date.now() - opts.staleDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .update(agentMemory)
    .set({ archived: true, updatedAt: new Date() })
    .where(
      and(
        eq(agentMemory.archived, false),
        sql`${agentMemory.source} IN ('agent','reflection')`,
        sql`${agentMemory.importance} <= ${opts.importanceMax}`,
        sql`coalesce(${agentMemory.accessCount}, 0) = 0`,
        sql`${agentMemory.createdAt} < ${cutoff}`,
      ),
    )
    .returning({ id: agentMemory.id });
  return { archived: rows.length };
}

export type MemoryCuratorError = 'not_found' | 'not_agent_memory';

/** Read a memory's provenance within an entity (the guard input). */
async function loadSource(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ source: agentMemory.source })
    .from(agentMemory)
    .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)))
    .limit(1);
  return row ? row.source : undefined;
}

/** Read a memory's provenance + user-lock state (the set_importance guard input). */
async function loadSourceAndLock(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
): Promise<{ source: string | null; importanceLocked: boolean } | undefined> {
  const [row] = await db
    .select({ source: agentMemory.source, importanceLocked: agentMemory.importanceLocked })
    .from(agentMemory)
    .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)))
    .limit(1);
  return row ? { source: row.source, importanceLocked: row.importanceLocked } : undefined;
}

/**
 * Provenance-guarded archive (reversible). Refuses source='manual' so the
 * curator can never bin a fact the user entered. Mirrors archiveAgentSkill.
 */
export async function archiveAgentMemory(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
): Promise<{ ok: true } | { error: MemoryCuratorError }> {
  const source = await loadSource(db, entityId, memoryId);
  if (source === undefined) return { error: 'not_found' };
  if (source === 'manual') return { error: 'not_agent_memory' };
  await db
    .update(agentMemory)
    .set({ archived: true, updatedAt: new Date() })
    .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)));
  return { ok: true };
}

/**
 * Provenance-guarded fact edit — distill an oversized fact down to its key
 * statement, or write the merged text of a consolidation. Refuses
 * source='manual'. Recomputes fact_hash so future exact-dedup stays correct.
 */
export async function updateAgentMemoryFact(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
  fact: string,
): Promise<{ ok: true } | { error: MemoryCuratorError }> {
  const source = await loadSource(db, entityId, memoryId);
  if (source === undefined) return { error: 'not_found' };
  if (source === 'manual') return { error: 'not_agent_memory' };
  const trimmed = fact.trim();
  await db
    .update(agentMemory)
    .set({ fact: trimmed, factHash: computeFactHash(trimmed), updatedAt: new Date() })
    .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)));
  return { ok: true };
}

/**
 * Provenance-guarded importance re-score — the curator's usage-driven
 * correction to an agent's one-shot importance guess (see the module comment
 * above: usage, proven by access_count, is a sounder signal than a first
 * estimate). Refuses source='manual' like the other curator mutations, and
 * refuses ANY fact the user has pinned (importance_locked=true) — a
 * user-set importance is the top of the authority chain: agent → curator →
 * user, and the user always wins.
 */
export async function updateAgentMemoryImportance(
  db: AnyDrizzleDb,
  entityId: string,
  memoryId: string,
  importance: number,
): Promise<{ ok: true } | { error: MemoryCuratorError | 'invalid_importance' | 'importance_locked' }> {
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    return { error: 'invalid_importance' };
  }
  const row = await loadSourceAndLock(db, entityId, memoryId);
  if (row === undefined) return { error: 'not_found' };
  if (row.source === 'manual') return { error: 'not_agent_memory' };
  if (row.importanceLocked) return { error: 'importance_locked' };
  await db
    .update(agentMemory)
    .set({ importance, updatedAt: new Date() })
    .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.entityId, entityId)));
  return { ok: true };
}
