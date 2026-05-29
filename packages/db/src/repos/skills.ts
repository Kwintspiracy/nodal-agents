// packages/db/src/repos/skills.ts
// Pure DB repository functions for skill creation and assignment.
// Takes a db instance + entityId + already-validated input; returns a
// discriminated result or throws on unexpected errors.

import { eq, and, or, inArray } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { agentSkills, agentSkillAssignments } from '../schema/skills.ts';

// ─── createSkillRepo ──────────────────────────────────────────────────────────

export interface CreateSkillInput {
  slug: string;
  name: string;
  content: string;
  description: string | null | undefined;
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
      })
      .returning({ id: agentSkills.id });
    if (!row) throw new Error('Insert returned no row');
    return { id: row.id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('23505')) {
      return { error: 'slug_taken' };
    }
    throw err;
  }
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
