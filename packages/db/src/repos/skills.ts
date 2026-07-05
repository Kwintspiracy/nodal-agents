// packages/db/src/repos/skills.ts
// Pure DB repository functions for skill creation and assignment.
// Takes a db instance + entityId + already-validated input; returns a
// discriminated result or throws on unexpected errors.

import { eq, and, or, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { agentSkills, agentSkillAssignments } from '../schema/skills.ts';

// ─── createSkillRepo ──────────────────────────────────────────────────────────

export interface CreateSkillInput {
  slug: string;
  name: string;
  content: string;
  description: string | null | undefined;
  /**
   * Provenance of this skill (learning-loop). Maps to agent_skills.created_by.
   * Omitted ⇒ the column default ('user'). The Tier-1 reflection pass passes
   * 'agent' so agent-authored skills are distinguishable from user/system ones.
   */
  createdBy?: 'user' | 'system' | 'agent';
  /**
   * The agent that authored this skill during a reflection pass.
   * Populated by the Tier-1 reflection pass when creating agent-authored skills.
   * Omitted / null ⇒ column stays NULL (user/system/curator skills).
   */
  createdByAgentId?: string | null;
}

export type CreateSkillResult = { id: string } | { error: 'slug_taken' };

/**
 * Insert a new skill within an entity.
 * Returns `{ error: 'slug_taken' }` on unique-constraint violation.
 */
export async function createSkillRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: CreateSkillInput,
): Promise<CreateSkillResult> {
  try {
    const [row] = await db
      .insert(agentSkills)
      .values({
        entityId,
        slug: input.slug,
        name: input.name,
        content: input.content,
        defaultContent: input.content,
        description: input.description ?? null,
        active: true,
        // Omit when undefined so the column default ('user') applies.
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        // Omit when undefined/null — curator umbrella skills leave this NULL explicitly.
        ...(input.createdByAgentId !== undefined && input.createdByAgentId !== null
          ? { createdByAgentId: input.createdByAgentId }
          : {}),
      })
      .returning({ id: agentSkills.id });
    if (!row) throw new Error('Insert returned no row');
    return { id: row.id };
  } catch (err: unknown) {
    // Check both err.message and err.cause.message: drizzle-orm's pglite adapter
    // wraps the Postgres error in a "Failed query: ..." outer error and places
    // the actual constraint violation in err.cause.message.
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    if (
      msg.includes('unique') ||
      msg.includes('23505') ||
      causeMsg.includes('unique') ||
      causeMsg.includes('23505')
    ) {
      return { error: 'slug_taken' };
    }
    throw err;
  }
}

// ─── updateSkillRepo ──────────────────────────────────────────────────────────

export interface UpdateSkillPatch {
  name?: string;
  description?: string | null;
  content?: string;
  active?: boolean;
  /**
   * Provenance of this patch (learning-loop). When set to 'agent' (the Tier-1
   * reflection pass), the row's created_by is updated to 'agent' AND patch_count
   * is incremented atomically — so an agent-patched skill is distinguishable
   * and its accumulated self-patches are countable. Omitted ⇒ neither column is
   * touched (a normal user/dashboard edit leaves provenance + patch_count as-is).
   */
  createdBy?: 'user' | 'system' | 'agent';
}

export type UpdateSkillResult = { ok: true } | { error: 'not_found' };

/**
 * Update an existing entity-owned skill. `slug` is immutable (it's the
 * identifier used by assignments). Sets `contentOverridden = true` when the
 * content changes so a future "reset to default" can tell user-edited skills
 * apart. Returns `{ error: 'not_found' }` if the skill isn't in this entity.
 */
export async function updateSkillRepo(
  db: AnyDrizzleDb,
  entityId: string,
  skillId: string,
  patch: UpdateSkillPatch,
): Promise<UpdateSkillResult> {
  const [existing] = await db
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, entityId)));
  if (!existing) return { error: 'not_found' };

  // Each column may take either a literal value or a SQL expression (used for the
  // atomic patch_count increment below) — match drizzle's update-set shape.
  const set: {
    [K in keyof typeof agentSkills.$inferInsert]?: (typeof agentSkills.$inferInsert)[K] | SQL;
  } = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.content !== undefined) {
    set.content = patch.content;
    set.contentOverridden = true;
  }
  // Agent-authored patch (reflection): stamp provenance + bump the self-patch
  // counter atomically. Only on createdBy:'agent' — a plain user edit must not
  // silently reclassify a user/system skill or inflate patch_count.
  if (patch.createdBy === 'agent') {
    set.createdBy = 'agent';
    set.patchCount = sql`${agentSkills.patchCount} + 1`;
  }

  await db.update(agentSkills).set(set).where(eq(agentSkills.id, skillId));
  return { ok: true };
}

// ─── assignSkillRepo ──────────────────────────────────────────────────────────

export interface AssignSkillInput {
  skillId: string;
  agentId: string;
}

export type AssignSkillResult =
  | { ok: true }
  | { error: 'skill_not_found' | 'agent_not_found' | 'already_assigned' };

/**
 * Assign a skill to an agent within an entity.
 *
 * - Allows assigning a system skill (slug in systemSkillSlugs) even if it
 *   belongs to a different entity (pass the slug list from the caller to
 *   keep packages/db free of a catalog import).
 * - Idempotent: returns `{ error: 'already_assigned' }` when the assignment
 *   already exists (caller maps this to ok() with no change).
 */
export async function assignSkillRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: AssignSkillInput,
  systemSkillSlugs: string[],
): Promise<AssignSkillResult> {
  // Confirm the skill exists and is accessible to this entity.
  const [skill] = await db
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.id, input.skillId),
        or(
          eq(agentSkills.entityId, entityId),
          systemSkillSlugs.length > 0 ? inArray(agentSkills.slug, systemSkillSlugs) : undefined,
        ),
      ),
    );
  if (!skill) return { error: 'skill_not_found' };

  // Confirm the agent exists in this entity.
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  if (!agent) return { error: 'agent_not_found' };

  // Idempotent: skip if already assigned. The SELECT-then-INSERT still has a
  // race window (two concurrent calls can both miss it), so the INSERT itself
  // also carries `onConflictDoNothing` on the (agent_id, skill_id) unique
  // constraint (DB-2, audit #2) — belt-and-suspenders dedup at the DB layer,
  // not just the app layer.
  const [existing] = await db
    .select({ id: agentSkillAssignments.id })
    .from(agentSkillAssignments)
    .where(
      and(
        eq(agentSkillAssignments.skillId, input.skillId),
        eq(agentSkillAssignments.agentId, input.agentId),
      ),
    );
  if (existing) return { error: 'already_assigned' };

  await db
    .insert(agentSkillAssignments)
    .values({
      entityId,
      skillId: input.skillId,
      agentId: input.agentId,
    })
    .onConflictDoNothing({
      target: [agentSkillAssignments.agentId, agentSkillAssignments.skillId],
    });

  return { ok: true };
}

// ─── setSkillScriptsAuthorized ────────────────────────────────────────────────

export type SetScriptsAuthorizedResult = { ok: true } | { error: 'not_assigned' };

/**
 * Flip the per-skill × per-agent script-execution authorization (owner opt-in).
 *
 * When `authorized` is true, the runner registers `run_skill_script` for this
 * agent and lets it execute the skill's bundled scripts. Default is false — a
 * community skill's scripts NEVER run until the owner explicitly authorizes them
 * for a specific agent × skill. Returns `not_assigned` if the agent does not
 * hold the skill (you can only authorize scripts for an assigned skill).
 *
 * Scoped to (agentId, skillId) within the entity; the caller (web action) MUST
 * verify ownership of the entity before calling — this is an owner-only control.
 */
export async function setSkillScriptsAuthorized(
  db: AnyDrizzleDb,
  agentId: string,
  skillId: string,
  authorized: boolean,
): Promise<SetScriptsAuthorizedResult> {
  const updated = await db
    .update(agentSkillAssignments)
    .set({ scriptsAuthorized: authorized })
    .where(
      and(eq(agentSkillAssignments.agentId, agentId), eq(agentSkillAssignments.skillId, skillId)),
    )
    .returning({ id: agentSkillAssignments.id });
  if (updated.length === 0) return { error: 'not_assigned' };
  return { ok: true };
}

// ─── setSkillFilesWritable ────────────────────────────────────────────────────

export type SetFilesWritableResult = { ok: true } | { error: 'not_assigned' };

/**
 * Flip the per-skill × per-agent file-write authorization (owner opt-in).
 *
 * When `writable` is true, the runner registers `skill_file_write` for this
 * agent and lets it modify the skill's bundled files (drop a workflow, update a
 * reference). Default is false — an agent can always READ its assigned skills'
 * files, but it can only WRITE them once the owner explicitly authorizes it for
 * a specific agent × skill. Returns `not_assigned` if the agent does not hold
 * the skill (you can only authorize writes for an assigned skill).
 *
 * Scoped to (agentId, skillId) within the entity; the caller (web action) MUST
 * verify ownership of the entity before calling — this is an owner-only control.
 */
export async function setSkillFilesWritable(
  db: AnyDrizzleDb,
  agentId: string,
  skillId: string,
  writable: boolean,
): Promise<SetFilesWritableResult> {
  const updated = await db
    .update(agentSkillAssignments)
    .set({ filesWritable: writable })
    .where(
      and(eq(agentSkillAssignments.agentId, agentId), eq(agentSkillAssignments.skillId, skillId)),
    )
    .returning({ id: agentSkillAssignments.id });
  if (updated.length === 0) return { error: 'not_assigned' };
  return { ok: true };
}

// ─── touchSkillsLastUsed ──────────────────────────────────────────────────────

/**
 * Fire-and-forget: bump `last_used_at = now()` on the given skill IDs.
 *
 * Called after skills are injected into a job's system prompt (learning-loop
 * Phase A). The caller MUST NOT await this — it is intentionally non-blocking
 * so skill injection never adds latency to job start.
 *
 * Only `packages/db` may import drizzle-orm — this function is the DB boundary.
 * Callers in `packages/orchestration` import and call this via the re-export
 * from `@nodal-agents/db`.
 */
export async function touchSkillsLastUsed(db: AnyDrizzleDb, skillIds: string[]): Promise<void> {
  if (skillIds.length === 0) return;
  await db
    .update(agentSkills)
    .set({ lastUsedAt: sql`now()` })
    .where(inArray(agentSkills.id, skillIds));
}

// ─── transitionSkillLifecycle ─────────────────────────────────────────────────

export interface LifecycleThresholds {
  /** Days of inactivity before active → stale. Default 30. */
  staleDays: number;
  /** Days of inactivity (from stale) before stale → archived. Default 90. */
  archiveDays: number;
}

export interface LifecycleResult {
  staled: number;
  archived: number;
  reactivated: number;
}

/**
 * Bulk deterministic lifecycle transitions — ONLY for agent-authored skills.
 * User/system skills are NEVER touched (no lifecycle path for them).
 *
 * active → stale:      state='active'  AND coalesce(last_used_at, created_at) < now - staleDays
 * stale  → archived:   state='stale'   AND coalesce(last_used_at, created_at) < now - archiveDays
 * stale  → active:     state='stale'   AND last_used_at >= now - staleDays  (reactivation)
 *
 * Returns counts of each transition applied.
 */
export async function transitionSkillLifecycle(
  db: AnyDrizzleDb,
  thresholds: LifecycleThresholds,
): Promise<LifecycleResult> {
  const now = new Date();
  // ISO strings, NOT raw Date objects: these are interpolated into raw `sql`
  // template fragments below (not typed column writes), and the postgres.js
  // driver cannot serialize a bare Date passed as an untyped query param — it
  // throws ERR_INVALID_ARG_TYPE. As an ISO string it binds cleanly and postgres
  // implicitly casts it for the timestamptz comparison.
  const staleAt = new Date(
    now.getTime() - thresholds.staleDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const archiveAt = new Date(
    now.getTime() - thresholds.archiveDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // active → stale
  const staledRows = await db
    .update(agentSkills)
    .set({ state: 'stale', updatedAt: now })
    .where(
      and(
        eq(agentSkills.createdBy, 'agent'),
        eq(agentSkills.state, 'active'),
        sql`coalesce(${agentSkills.lastUsedAt}, ${agentSkills.createdAt}) < ${staleAt}`,
      ),
    )
    .returning({ id: agentSkills.id });

  // stale → archived
  const archivedRows = await db
    .update(agentSkills)
    .set({ state: 'archived', archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentSkills.createdBy, 'agent'),
        eq(agentSkills.state, 'stale'),
        sql`coalesce(${agentSkills.lastUsedAt}, ${agentSkills.createdAt}) < ${archiveAt}`,
      ),
    )
    .returning({ id: agentSkills.id });

  // stale → active (reactivation: recently used)
  const reactivatedRows = await db
    .update(agentSkills)
    .set({ state: 'active', updatedAt: now })
    .where(
      and(
        eq(agentSkills.createdBy, 'agent'),
        eq(agentSkills.state, 'stale'),
        sql`${agentSkills.lastUsedAt} >= ${staleAt}`,
      ),
    )
    .returning({ id: agentSkills.id });

  return {
    staled: staledRows.length,
    archived: archivedRows.length,
    reactivated: reactivatedRows.length,
  };
}

// ─── archiveAgentSkill ────────────────────────────────────────────────────────

export type ArchiveAgentSkillResult = { ok: true } | { error: 'not_agent_skill' | 'not_found' };

/**
 * Soft-archive a single agent-authored skill. Refuses to archive user/system
 * skills (created_by != 'agent') — returns { error: 'not_agent_skill' }.
 * Returns { error: 'not_found' } if the skill doesn't exist or belongs to a
 * different entity. Idempotent: archiving an already-archived skill is ok.
 */
export async function archiveAgentSkill(
  db: AnyDrizzleDb,
  entityId: string,
  skillId: string,
): Promise<ArchiveAgentSkillResult> {
  // Fetch first to check provenance
  const [row] = await db
    .select({ id: agentSkills.id, createdBy: agentSkills.createdBy })
    .from(agentSkills)
    .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, entityId)))
    .limit(1);

  if (!row) return { error: 'not_found' };
  if (row.createdBy !== 'agent') return { error: 'not_agent_skill' };

  await db
    .update(agentSkills)
    .set({ state: 'archived', archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, entityId)));

  return { ok: true };
}
