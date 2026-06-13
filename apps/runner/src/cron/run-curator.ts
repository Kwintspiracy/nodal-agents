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
  count,
  entities,
  agentSkills,
  transitionSkillLifecycle,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { env as globalEnv } from '../env.ts';
import { runCuratorConsolidation } from '../reflection/run-curator.ts';

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
}

/** Minimal curator defaults used when env can't be resolved (e.g. test environments). */
const SAFE_LIFECYCLE_DEFAULTS = {
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
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
    };
  }

  const intervalMs = e.CURATOR_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const intervalCutoff = new Date(Date.now() - intervalMs);
  const now = new Date();

  // Find entities with >= CURATOR_MIN_SKILLS agent-created ACTIVE skills
  // that are either (a) never run (NULL) or (b) overdue for consolidation.
  // Only entities with reflection_enabled=true are eligible for LLM consolidation.
  const candidateEntities = await db
    .select({
      entityId: agentSkills.entityId,
      activeSkillCount: count(agentSkills.id),
    })
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

  let consolidationDeferred = 0;
  let consolidationRan = 0;

  for (const candidate of candidateEntities) {
    if (!candidate.entityId) continue;

    // Check this entity's last_curator_run_at
    const [entityRow] = await db
      .select({ lastCuratorRunAt: entities.lastCuratorRunAt })
      .from(entities)
      .where(eq(entities.id, candidate.entityId))
      .limit(1);

    if (!entityRow) continue;

    const lastRun = entityRow.lastCuratorRunAt;

    // First-run-deferred: stamp now, skip LLM this time
    if (lastRun === null) {
      await db
        .update(entities)
        .set({ lastCuratorRunAt: now, updatedAt: now })
        .where(eq(entities.id, candidate.entityId));
      consolidationDeferred += 1;
      continue;
    }

    // Not yet due
    if (lastRun >= intervalCutoff) {
      continue;
    }

    // Due — run consolidation
    try {
      await runCuratorConsolidation(db, candidate.entityId, e.CURATOR_MAX_TURNS, e.REFLECTION_MODEL);
    } catch (err) {
      console.warn(`${CURATOR_TRACE} consolidation failed for entity ${candidate.entityId}`, err);
    }

    // Stamp last_curator_run_at regardless of success/failure
    await db
      .update(entities)
      .set({ lastCuratorRunAt: now, updatedAt: now })
      .where(eq(entities.id, candidate.entityId));
    consolidationRan += 1;
  }

  return {
    staled: lifecycle.staled,
    archived: lifecycle.archived,
    reactivated: lifecycle.reactivated,
    consolidationDeferred,
    consolidationRan,
  };
}
