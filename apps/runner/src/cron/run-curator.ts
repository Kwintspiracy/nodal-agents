// cron/run-curator.ts — Tier-2 CURATOR cron phase.
//
// Phase 1 (always): deterministic lifecycle transitions via transitionSkillLifecycle.
//   - active → stale: agent skills unused for CURATOR_STALE_DAYS
//   - stale → archived: agent skills unused for CURATOR_ARCHIVE_DAYS
//   - stale → active: reactivation when recently re-used
//   No LLM involved. Cheap SQL. Runs unconditionally every tick.
//
// Phase 2 (gated): LLM consolidation pass via runCuratorConsolidation.
//   Gated by the global kill-switch (REFLECTION_ENABLED !== 'false') AND the
//   per-entity reflection_enabled=true (enforced by the candidate query join).
//   Per-entity: runs only when the entity has >= CURATOR_MIN_SKILLS agent-created
//   ACTIVE skills AND the consolidation cadence allows it:
//     - last_curator_run_at IS NULL → first-run-deferred: stamp now(), skip LLM
//     - last_curator_run_at < now - CURATOR_INTERVAL_DAYS → run consolidation
//   Stamps entities.last_curator_run_at = now() after each pass (or deferral).

import {
  eq,
  and,
  sql,
  entities,
  agentSkills,
  agentMemory,
  transitionSkillLifecycle,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { transitionMemoryLifecycle } from '@nodal-agents/memory';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { env as globalEnv } from '../env.ts';
import { runCuratorConsolidation } from '../reflection/run-curator.ts';
import { runMemoryCuration } from '../reflection/run-memory-curator.ts';

const CURATOR_TRACE = '[curator]';

export interface CuratorTickResult {
  /** Skills transitioned active→stale */
  staled: number;
  /** Skills transitioned stale→archived */
  archived: number;
  /** Skills reactivated stale→active */
  reactivated: number;
  /** Entities where LLM consolidation was deferred (first-run) */
  consolidationDeferred: number;
  /** Entities where LLM consolidation ran */
  consolidationRan: number;
  /** Memories archived by the deterministic usage-based Phase 1 (Brick 4) */
  memoryArchived: number;
  /** Entities where the LLM memory-curation pass ran */
  memoryCurationRan: number;
}

/** Minimal curator defaults used when env can't be resolved (e.g. test environments). */
const SAFE_LIFECYCLE_DEFAULTS = {
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  REFLECTION_ENABLED: 'false',
  REFLECTION_MODEL: undefined,
} as const;

type CuratorEnvSlice = Pick<
  RunnerEnv,
  | 'CURATOR_STALE_DAYS'
  | 'CURATOR_ARCHIVE_DAYS'
  | 'CURATOR_MIN_SKILLS'
  | 'CURATOR_INTERVAL_DAYS'
  | 'CURATOR_MAX_TURNS'
  | 'CURATOR_MEMORY_STALE_DAYS'
  | 'CURATOR_MEMORY_IMPORTANCE_MAX'
  | 'CURATOR_MEMORY_MIN'
  | 'REFLECTION_ENABLED'
  | 'REFLECTION_MODEL'
>;

/**
 * Resolve the curator env slice. The module-level globalEnv proxy triggers
 * parseEnv() on every property access and throws when DATABASE_URL is absent
 * (test environments that don't set process.env). We probe it once inside a
 * try/catch and fall back to SAFE_LIFECYCLE_DEFAULTS so Phase 1 (lifecycle SQL)
 * always runs even when the proxy is unavailable.
 */
function resolveCuratorEnv(runnerEnv?: RunnerEnv): CuratorEnvSlice {
  if (runnerEnv) return runnerEnv;
  try {
    // Accessing CURATOR_STALE_DAYS triggers parseEnv() via the Proxy getter.
    // If it throws (missing DATABASE_URL), we fall back to safe defaults.
    const staleDays = globalEnv.CURATOR_STALE_DAYS;
    return {
      CURATOR_STALE_DAYS: staleDays,
      CURATOR_ARCHIVE_DAYS: globalEnv.CURATOR_ARCHIVE_DAYS,
      CURATOR_MIN_SKILLS: globalEnv.CURATOR_MIN_SKILLS,
      CURATOR_INTERVAL_DAYS: globalEnv.CURATOR_INTERVAL_DAYS,
      CURATOR_MAX_TURNS: globalEnv.CURATOR_MAX_TURNS,
      CURATOR_MEMORY_STALE_DAYS: globalEnv.CURATOR_MEMORY_STALE_DAYS,
      CURATOR_MEMORY_IMPORTANCE_MAX: globalEnv.CURATOR_MEMORY_IMPORTANCE_MAX,
      CURATOR_MEMORY_MIN: globalEnv.CURATOR_MEMORY_MIN,
      REFLECTION_ENABLED: globalEnv.REFLECTION_ENABLED,
      REFLECTION_MODEL: globalEnv.REFLECTION_MODEL,
    };
  } catch {
    return SAFE_LIFECYCLE_DEFAULTS;
  }
}

/**
 * Run the curator cron phase.
 *
 * @param db   Database client
 * @param deps RunnerDeps (used implicitly via resolveAgentLlmClient inside consolidation)
 * @param runnerEnv  Validated env (optional — falls back to module-level proxy, then safe defaults)
 */
export async function runCuratorTick(
  db: AnyDrizzleDb,
  _deps: RunnerDeps,
  runnerEnv?: RunnerEnv,
): Promise<CuratorTickResult> {
  const e = resolveCuratorEnv(runnerEnv);

  // ── Phase 1: deterministic lifecycle (always, no LLM) ─────────────────────
  const lifecycle = await transitionSkillLifecycle(db, {
    staleDays: e.CURATOR_STALE_DAYS,
    archiveDays: e.CURATOR_ARCHIVE_DAYS,
  });
  // Memory Phase 1 — usage-based archival of agent-authored, NEVER-accessed,
  // low-importance, old facts (Brick 4). Deterministic, reversible, no LLM.
  const memLifecycle = await transitionMemoryLifecycle(db, {
    staleDays: e.CURATOR_MEMORY_STALE_DAYS,
    importanceMax: e.CURATOR_MEMORY_IMPORTANCE_MAX,
  });

  // ── Phase 2: LLM consolidation (gated) ────────────────────────────────────
  // Global kill-switch: explicit 'false' disables LLM consolidation entirely.
  // Empty string (unset) or 'true' both allow per-entity flag to decide.
  if (e.REFLECTION_ENABLED === 'false') {
    return {
      staled: lifecycle.staled,
      archived: lifecycle.archived,
      reactivated: lifecycle.reactivated,
      consolidationDeferred: 0,
      consolidationRan: 0,
      memoryArchived: memLifecycle.archived,
      memoryCurationRan: 0,
    };
  }

  const intervalMs = e.CURATOR_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const intervalCutoff = new Date(Date.now() - intervalMs);
  const now = new Date();

  // Candidate entities (reflection_enabled) for the two LLM passes, on the SAME
  // cadence (shared entities.last_curator_run_at):
  //   - skills:  >= CURATOR_MIN_SKILLS agent-created ACTIVE skills.
  //   - memory:  >= CURATOR_MEMORY_MIN non-archived facts.
  const skillCandidates = await db
    .select({ entityId: agentSkills.entityId })
    .from(agentSkills)
    .innerJoin(entities, eq(entities.id, agentSkills.entityId))
    .where(
      and(
        eq(agentSkills.createdBy, 'agent'),
        eq(agentSkills.state, 'active'),
        eq(entities.reflectionEnabled, true),
      ),
    )
    .groupBy(agentSkills.entityId)
    .having(sql`count(${agentSkills.id}) >= ${e.CURATOR_MIN_SKILLS}`);

  const memoryCandidates = await db
    .select({ entityId: agentMemory.entityId })
    .from(agentMemory)
    .innerJoin(entities, eq(entities.id, agentMemory.entityId))
    .where(and(eq(agentMemory.archived, false), eq(entities.reflectionEnabled, true)))
    .groupBy(agentMemory.entityId)
    .having(sql`count(${agentMemory.id}) >= ${e.CURATOR_MEMORY_MIN}`);

  const skillSet = new Set<string>();
  for (const c of skillCandidates) if (c.entityId) skillSet.add(c.entityId);
  const memorySet = new Set<string>();
  for (const c of memoryCandidates) if (c.entityId) memorySet.add(c.entityId);

  let consolidationDeferred = 0;
  let consolidationRan = 0;
  let memoryCurationRan = 0;

  for (const entityId of new Set<string>([...skillSet, ...memorySet])) {
    const [entityRow] = await db
      .select({ lastCuratorRunAt: entities.lastCuratorRunAt })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (!entityRow) continue;

    const lastRun = entityRow.lastCuratorRunAt;

    // First-run-deferred: stamp now, skip the LLM passes this time.
    if (lastRun === null) {
      await db
        .update(entities)
        .set({ lastCuratorRunAt: now, updatedAt: now })
        .where(eq(entities.id, entityId));
      consolidationDeferred += 1;
      continue;
    }
    // Not yet due.
    if (lastRun >= intervalCutoff) continue;

    // Due — run the applicable LLM passes (each fail-isolated).
    if (skillSet.has(entityId)) {
      try {
        await runCuratorConsolidation(db, entityId, e.CURATOR_MAX_TURNS, e.REFLECTION_MODEL);
      } catch (err) {
        console.warn(`${CURATOR_TRACE} skill consolidation failed for entity ${entityId}`, err);
      }
      consolidationRan += 1;
    }
    if (memorySet.has(entityId)) {
      try {
        await runMemoryCuration(db, entityId, e.CURATOR_MAX_TURNS, e.REFLECTION_MODEL);
      } catch (err) {
        console.warn(`${CURATOR_TRACE} memory curation failed for entity ${entityId}`, err);
      }
      memoryCurationRan += 1;
    }

    // Stamp last_curator_run_at once, regardless of success/failure.
    await db
      .update(entities)
      .set({ lastCuratorRunAt: now, updatedAt: now })
      .where(eq(entities.id, entityId));
  }

  return {
    staled: lifecycle.staled,
    archived: lifecycle.archived,
    reactivated: lifecycle.reactivated,
    consolidationDeferred,
    consolidationRan,
    memoryArchived: memLifecycle.archived,
    memoryCurationRan,
  };
}
