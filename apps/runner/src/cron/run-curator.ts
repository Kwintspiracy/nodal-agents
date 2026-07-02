// cron/run-curator.ts — Tier-2 CURATOR cron phase.
//
// Phase 1 (always): deterministic lifecycle transitions via transitionSkillLifecycle.
//   - active → stale: agent skills unused for CURATOR_STALE_DAYS
//   - stale → archived: agent skills unused for CURATOR_ARCHIVE_DAYS
//   - stale → active: reactivation when recently re-used
//   No LLM involved. Cheap SQL. Runs unconditionally every tick.
//
// Phase 2 (gated, per-pass): two independent LLM passes on the SAME cadence
// (shared entities.last_curator_run_at):
//   - Skill consolidation (runCuratorConsolidation): gated by the global
//     kill-switch (REFLECTION_ENABLED !== 'false') AND per-entity
//     reflection_enabled=true. Opt-in — ships off by default.
//   - Memory curation (runMemoryCuration): gated by the global kill-switch
//     (MEMORY_CURATION_ENABLED !== 'false') AND per-entity
//     memory_curation_enabled=true. Decoupled from reflection — ON by default,
//     so memory curation runs even for entities that never opted into the
//     skill-learning loop.
//   Per-entity, per-pass: runs only when the entity clears that pass's
//   candidate threshold (CURATOR_MIN_SKILLS / CURATOR_MEMORY_MIN) AND the
//   shared consolidation cadence allows it:
//     - last_curator_run_at IS NULL → first-run-deferred: stamp now(), skip LLM
//     - last_curator_run_at < now - CURATOR_INTERVAL_DAYS → run applicable pass(es)
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
  // Conservative fallback for environments without DATABASE_URL (test envs) —
  // mirrors REFLECTION_ENABLED's safe default. The REAL production default
  // (per-entity decides, ON since entities.memory_curation_enabled defaults
  // true) comes from the zod schema in env.ts, not from this fallback.
  MEMORY_CURATION_ENABLED: 'false',
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
  | 'MEMORY_CURATION_ENABLED'
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
      MEMORY_CURATION_ENABLED: globalEnv.MEMORY_CURATION_ENABLED,
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

  // ── Phase 2: LLM consolidation (gated, per-pass) ──────────────────────────
  // Skill consolidation and memory curation are gated INDEPENDENTLY: reflection
  // is still opt-in (entities.reflection_enabled defaults false), while memory
  // curation runs by default (entities.memory_curation_enabled defaults true).
  // Each global kill-switch, when 'false', empties its Set entirely so that
  // pass never runs for any entity this tick — regardless of per-entity flags.
  const intervalMs = e.CURATOR_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  const intervalCutoff = new Date(Date.now() - intervalMs);
  const now = new Date();

  const skillSet = new Set<string>();
  if (e.REFLECTION_ENABLED !== 'false') {
    // Candidates: >= CURATOR_MIN_SKILLS agent-created ACTIVE skills, entity opted in.
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
    for (const c of skillCandidates) if (c.entityId) skillSet.add(c.entityId);
  }

  const memorySet = new Set<string>();
  if (e.MEMORY_CURATION_ENABLED !== 'false') {
    // Candidates: >= CURATOR_MEMORY_MIN non-archived facts, entity opted in
    // (memory_curation_enabled, ON by default — decoupled from reflection).
    const memoryCandidates = await db
      .select({ entityId: agentMemory.entityId })
      .from(agentMemory)
      .innerJoin(entities, eq(entities.id, agentMemory.entityId))
      .where(and(eq(agentMemory.archived, false), eq(entities.memoryCurationEnabled, true)))
      .groupBy(agentMemory.entityId)
      .having(sql`count(${agentMemory.id}) >= ${e.CURATOR_MEMORY_MIN}`);
    for (const c of memoryCandidates) if (c.entityId) memorySet.add(c.entityId);
  }

  if (skillSet.size === 0 && memorySet.size === 0) {
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
