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
  const set: { [K in keyof typeof agentSkills.$inferInsert]?: (typeof agentSkills.$inferInsert)[K] | SQL } =
    { updatedAt: new Date() };
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

  // Idempotent: skip if already assigned.
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

  await db.insert(agentSkillAssignments).values({
    entityId,
    skillId: input.skillId,
    agentId: input.agentId,
  });

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
export async function touchSkillsLastUsed(
  db: AnyDrizzleDb,
  skillIds: string[],
): Promise<void> {
  if (skillIds.length === 0) return;
  await db
    .update(agentSkills)
    .set({ lastUsedAt: sql`now()` })
    .where(inArray(agentSkills.id, skillIds));
}
