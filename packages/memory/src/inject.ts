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

// Relevance boost: when a query (the current task) is provided, facts whose text
// overlaps the task float up so the limited budget is spent on what THIS job is
// about — not just the globally most-important facts. Kept deliberately small so
// importance still dominates: a fact gets at most RELEVANCE_MATCH_CAP keyword
// hits counted, each worth RELEVANCE_WEIGHT importance-points. So a fully-relevant
// fact (+4) can out-rank an irrelevant one up to 4 importance points higher, but
// a top-importance(5) fact stays competitive. No query → no boost → identical to
// the prior importance×recency behavior (backward compatible).
const RELEVANCE_WEIGHT = 2;
const RELEVANCE_MATCH_CAP = 2;

// Common EN + FR function words. Dropped from the query so a "the"/"les" doesn't
// match (and boost) every fact that happens to contain it — that noise would let
// an irrelevant high-importance fact win on a stopword hit. Content words only.
const STOPWORDS = new Set<string>([
  // English
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'but',
  'not',
  'you',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'into',
  'out',
  'can',
  'could',
  'will',
  'would',
  'should',
  'shall',
  'may',
  'might',
  'must',
  'has',
  'have',
  'had',
  'been',
  'being',
  'then',
  'than',
  'them',
  'they',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'how',
  'all',
  'any',
  'some',
  'such',
  'only',
  'too',
  'very',
  'just',
  'also',
  'per',
  'via',
  'about',
  // French
  'les',
  'des',
  'une',
  'est',
  'été',
  'pour',
  'avec',
  'dans',
  'par',
  'sur',
  'que',
  'qui',
  'quoi',
  'dont',
  'pas',
  'plus',
  'mais',
  'son',
  'ses',
  'mes',
  'tes',
  'nos',
  'vos',
  'leur',
  'leurs',
  'mon',
  'ton',
  'cette',
  'ces',
  'cet',
  'aux',
  'vers',
  'chez',
  'sans',
  'sous',
  'entre',
  'tout',
  'tous',
  'toute',
  'comme',
  'donc',
  'alors',
  'ainsi',
  'une',
  'deux',
  'ce',
  'la',
  'le',
]);

/**
 * Tokenize a free-text query (the job task / user message) into lowercased
 * content keywords: ≥3 chars, not a stopword, deduped, split on any
 * non-letter/digit (Unicode-aware, so French accents survive). Exported for
 * reuse + testing.
 */
export function tokenizeQuery(query: string | undefined | null): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length > 2 && !STOPWORDS.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/** Count distinct query keywords that appear (as substrings) in the fact. */
function relevanceScore(fact: string, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = fact.toLowerCase();
  let n = 0;
  for (const t of queryTokens) if (haystack.includes(t)) n++;
  return n;
}

/**
 * Pure selector: rank the given memories and greedy-accumulate until the char
 * budget is reached. Returns the subset that fits, in ranked order.
 *
 * Ranking = blended score DESC, then recency (last_accessed_at DESC, created_at
 * DESC), then `id` (stable). The score is `importance + min(relevanceHits,
 * RELEVANCE_MATCH_CAP) * RELEVANCE_WEIGHT` — so when `query` is given, facts
 * relevant to the current task are prioritized; when it's absent the score is
 * just `importance` (the prior behavior, unchanged).
 *
 * - `maxChars <= 0` returns `[]` (memory injection disabled for this agent).
 * - A single memory whose render cost exceeds the budget is skipped — never
 *   inject a partial fact (could change the meaning).
 *
 * Char accounting matches `buildPersistentMemoryBlock` in
 * `packages/orchestration/src/system-prompt.ts`. If that rendering changes,
 * update RENDER_OVERHEAD_PER_ENTRY here too.
 */
export function selectMemoriesUnderBudget(
  memories: ReadonlyArray<AgentMemory>,
  maxChars: number,
  query?: string | null,
): AgentMemory[] {
  if (maxChars <= 0) return [];

  const tokens = tokenizeQuery(query);
  const score = (m: AgentMemory): number =>
    m.importance + Math.min(relevanceScore(m.fact, tokens), RELEVANCE_MATCH_CAP) * RELEVANCE_WEIGHT;

  const sorted = [...memories].sort((a, b) => {
    const sb = score(b);
    const sa = score(a);
    if (sb !== sa) return sb - sa;
    const aTouched = a.last_accessed_at ?? a.created_at;
    const bTouched = b.last_accessed_at ?? b.created_at;
    if (aTouched !== bTouched) return bTouched.localeCompare(aTouched);
    return a.id.localeCompare(b.id);
  });

  return packUnderBudget(sorted, maxChars);
}

/**
 * Greedy-accumulate PRE-ORDERED memories under a char budget. Does not sort —
 * the caller's ordering is authoritative (extracted out of
 * selectMemoriesUnderBudget so the FTS-ranked pool in
 * selectMemoriesForInjection can reuse the same budget/skip-oversized-fact
 * logic without being re-sorted by importance).
 *
 * - `maxChars <= 0` returns `[]`.
 * - A single memory whose render cost exceeds the budget is skipped — never
 *   inject a partial fact.
 */
function packUnderBudget(memories: ReadonlyArray<AgentMemory>, maxChars: number): AgentMemory[] {
  if (maxChars <= 0) return [];

  const picked: AgentMemory[] = [];
  let used = 0;
  for (const m of memories) {
    const cost = m.fact.length + RENDER_OVERHEAD_PER_ENTRY;
    if (used + cost > maxChars) continue;
    picked.push(m);
    used += cost;
  }
  return picked;
}

// ─── selectMemoriesForInjection ───────────────────────────────────────────────

// The DB pool we rank in-app. Ordered by importance so the most-important facts
// are always in the pool; widened from 50 so relevance ranking (Brick 1) can
// surface a task-relevant fact that isn't in the top tier by importance alone.
// Still bounded — the char budget injects only ~10-15 of these.
const MAX_CANDIDATES = 200;

/**
 * Fetch the top candidate memories for an agent's system-prompt block, then
 * apply the char budget.
 *
 * Filter pipeline:
 *   1. Entity-scoped (multi-tenant invariant).
 *   2. archived = false. Never inject obsolete facts.
 *   3. valid_to IS NULL OR > now(). Never inject expired facts.
 *   4a. With a tokenizable `query`: order candidates by `ts_rank(search_tsv,
 *       plainto_tsquery('english', query)) DESC` (importance/recency as
 *       tiebreak), so a fact relevant to THIS task surfaces even if it's
 *       outside the importance/recency top tier — then pack in that FTS
 *       order (authoritative; not re-sorted by importance).
 *   4b. Without one: order by importance DESC, last_accessed_at DESC, then
 *       selectMemoriesUnderBudget(maxChars) (unchanged prior behavior).
 *   Both paths take top MAX_CANDIDATES before packing.
 *
 * The FTS `@@` operator is deliberately NOT used as a WHERE filter: we want
 * non-matching facts to stay in the pool (rank 0) so the char budget still
 * gets filled when nothing matches well — ts_rank in ORDER BY is enough to
 * surface the relevant ones.
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
 * @param opts.query     Current job task — drives FTS relevance ranking.
 */
export async function selectMemoriesForInjection(
  db: AnyDrizzleDb,
  opts: { entityId: string; maxChars: number; query?: string | null },
): Promise<AgentMemory[]> {
  if (opts.maxChars <= 0) return [];

  const baseConditions = and(
    eq(agentMemory.entityId, opts.entityId),
    eq(agentMemory.archived, false),
    sql`(${agentMemory.validTo} IS NULL OR ${agentMemory.validTo} > now())`,
  );

  const rawQuery = opts.query ?? '';
  const tokens = tokenizeQuery(rawQuery);

  if (tokens.length > 0) {
    // search_tsv is a generated column, not expressible in the Drizzle schema
    // builder (migration 0051) — reference it via raw SQL, same as
    // agent_jobs.search_tsv in search-history.ts.
    const tsv = sql`"agent_memory"."search_tsv"`;
    const tsq = sql`plainto_tsquery('english', ${rawQuery})`;

    const candidates = await db
      .select()
      .from(agentMemory)
      .where(baseConditions)
      .orderBy(
        sql`ts_rank(${tsv}, ${tsq}) DESC`,
        desc(agentMemory.importance),
        desc(agentMemory.lastAccessedAt),
      )
      .limit(MAX_CANDIDATES);

    const memories = candidates.map((row) => rowToMemory(row as MemoryRow));
    // FTS order is authoritative — pack as-is, do not re-rank by importance.
    return packUnderBudget(memories, opts.maxChars);
  }

  const candidates = await db
    .select()
    .from(agentMemory)
    .where(baseConditions)
    .orderBy(desc(agentMemory.importance), desc(agentMemory.lastAccessedAt))
    .limit(MAX_CANDIDATES);

  const memories = candidates.map((row) => rowToMemory(row as MemoryRow));
  return selectMemoriesUnderBudget(memories, opts.maxChars, opts.query);
}
