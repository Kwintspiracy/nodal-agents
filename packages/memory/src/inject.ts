// @nodal-agents/memory — memory selection for system-prompt injection (Sprint 2)
//
// Goal: the agent sees relevant memories WITHOUT having to call `query_memory`
// every turn. The orchestrator picks top-N memories, fits them under a char
// budget, and the system-prompt assembler injects them as a frozen block.
//
// Two functions, separated by purity:
//   - selectMemoriesUnderBudget(): pure. Sort + greedy-pack under maxChars.
//     Trivially testable, reusable by web/dashboard preview.
//   - selectMemoriesForInjection(): DB-bound. Query candidates, optionally
//     filter by skill_tags intersect with agent's assigned skills, then pack.

import { and, desc, eq, sql } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import type { AgentMemory } from '@nodal-agents/shared';
import { rowToMemory } from './crud';
import type { MemoryRow } from './crud';

// ─── selectMemoriesUnderBudget ────────────────────────────────────────────────

/**
 * Rough char-cost of rendering ONE memory entry as a system-prompt bullet.
 * Includes the leading `- (cat, X★) ` prefix that buildPersistentMemoryBlock
 * adds. Used to budget render space (not just raw fact length).
 *
 * Layout: `- (preference, 5★) <fact>\n` → ~16 chars overhead per entry.
 */
const RENDER_OVERHEAD_PER_ENTRY = 20;

/**
 * Pure selector: sort the given memories by importance DESC, then recency
 * (last_accessed_at DESC, created_at DESC), and greedy-accumulate until the
 * char budget is reached. Returns the subset that fits, in sorted order.
 *
 * - `maxChars <= 0` returns `[]` (memory injection disabled for this agent).
 * - A single memory whose render cost exceeds the budget is skipped — never
 *   inject a partial fact (could change the meaning).
 * - Stable for the same input: ties broken by `id` as last resort.
 *
 * Char accounting matches `buildPersistentMemoryBlock` in
 * `packages/orchestration/src/system-prompt.ts`. If that rendering changes,
 * update RENDER_OVERHEAD_PER_ENTRY here too.
 */
export function selectMemoriesUnderBudget(
  memories: ReadonlyArray<AgentMemory>,
  maxChars: number,
): AgentMemory[] {
  if (maxChars <= 0) return [];

  const sorted = [...memories].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    const aTouched = a.last_accessed_at ?? a.created_at;
    const bTouched = b.last_accessed_at ?? b.created_at;
    if (aTouched !== bTouched) return bTouched.localeCompare(aTouched);
    return a.id.localeCompare(b.id);
  });

  const picked: AgentMemory[] = [];
  let used = 0;
  for (const m of sorted) {
    const cost = m.fact.length + RENDER_OVERHEAD_PER_ENTRY;
    if (used + cost > maxChars) continue;
    picked.push(m);
    used += cost;
  }
  return picked;
}

// ─── selectMemoriesForInjection ───────────────────────────────────────────────

const MAX_CANDIDATES = 50;

/**
 * Fetch the top candidate memories for an agent's system-prompt block, then
 * apply the char budget.
 *
 * Filter pipeline:
 *   1. Entity-scoped (multi-tenant invariant).
 *   2. archived = false. Never inject obsolete facts.
 *   3. valid_to IS NULL OR > now(). Never inject expired facts.
 *   4. Order by importance DESC, last_accessed_at DESC. Take top MAX_CANDIDATES.
 *   5. selectMemoriesUnderBudget(maxChars).
 *
 * Memory is entity-scoped, not agent-scoped — every agent in the entity sees
 * the same pool. This matches how `query_memory` already works (the existing
 * tool comment is explicit: "knowledge follows the user across agents"). If we
 * later add semantic skill-tag filtering, layer it ON TOP of this baseline.
 *
 * Returns an empty array when no memories exist or the budget is 0 — caller
 * can skip the block render.
 *
 * @param db        Drizzle handle
 * @param opts.entityId  Multi-tenant scope.
 * @param opts.maxChars  Char budget from `agents.memoryTokenBudget`.
 */
export async function selectMemoriesForInjection(
  db: AnyDrizzleDb,
  opts: { entityId: string; maxChars: number },
): Promise<AgentMemory[]> {
  if (opts.maxChars <= 0) return [];

  const candidates = await db
    .select()
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.entityId, opts.entityId),
        eq(agentMemory.archived, false),
        sql`(${agentMemory.validTo} IS NULL OR ${agentMemory.validTo} > now())`,
      ),
    )
    .orderBy(desc(agentMemory.importance), desc(agentMemory.lastAccessedAt))
    .limit(MAX_CANDIDATES);

  const memories = candidates.map((row) => rowToMemory(row as MemoryRow));
  return selectMemoriesUnderBudget(memories, opts.maxChars);
}
