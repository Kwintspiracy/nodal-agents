'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  eq,
  and,
  or,
  desc,
  sql,
  inArray,
  agentSkills,
  agentSkillAssignments,
  agents,
  entities,
  archiveAgentSkill,
  assignSkillRepo,
} from '@nodal-agents/db';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LearnedSkillRow = {
  id: string;
  name: string;
  slug: string;
  content: string;
  description: string | null;
  state: string;
  patchCount: number;
  lastUsedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  assignedAgentNames: string[];
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

// ─── setReflectionEnabledAction ──────────────────────────────────────────────

export async function setReflectionEnabledAction(enabled: boolean): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = z.boolean().safeParse(enabled);
    if (!parsed.success) return fail('validation_failed', 'enabled must be a boolean');

    const db = getDb();
    await db
      .update(entities)
      .set({ reflectionEnabled: parsed.data, updatedAt: new Date() })
      .where(eq(entities.id, session.entityId));

    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[setReflectionEnabledAction]', err);
    return fail('db_error', 'Failed to update reflection setting');
  }
}

// ─── getReflectionEnabledAction ──────────────────────────────────────────────

export async function getReflectionEnabledAction(): Promise<ActionResult<boolean>> {
  try {
    const session = await getSession();
    const db = getDb();
    const [row] = await db
      .select({ reflectionEnabled: entities.reflectionEnabled })
      .from(entities)
      .where(eq(entities.id, session.entityId))
      .limit(1);
    if (!row) return fail('not_found', 'Entity not found');
    return ok(row.reflectionEnabled ?? false);
  } catch (err) {
    console.error('[getReflectionEnabledAction]', err);
    return fail('db_error', 'Failed to load reflection setting');
  }
}

// ─── listLearnedSkillsAction ──────────────────────────────────────────────────

export async function listLearnedSkillsAction(): Promise<ActionResult<LearnedSkillRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const rows = await db
      .select({
        id: agentSkills.id,
        name: agentSkills.name,
        slug: agentSkills.slug,
        content: agentSkills.content,
        description: agentSkills.description,
        state: agentSkills.state,
        patchCount: agentSkills.patchCount,
        lastUsedAt: agentSkills.lastUsedAt,
        archivedAt: agentSkills.archivedAt,
        createdAt: agentSkills.createdAt,
        updatedAt: agentSkills.updatedAt,
        createdByAgentId: agentSkills.createdByAgentId,
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.entityId, session.entityId),
          or(eq(agentSkills.createdBy, 'agent'), sql`${agentSkills.patchCount} > 0`),
        ),
      )
      .orderBy(sql`${agentSkills.lastUsedAt} DESC NULLS LAST`, desc(agentSkills.createdAt));

    // Fetch assigned agent names for all returned skills
    const skillIds = rows.map((r) => r.id);
    const assignedAgentNamesMap = new Map<string, string[]>();
    if (skillIds.length > 0) {
      const assignments = await db
        .select({ skillId: agentSkillAssignments.skillId, agentName: agents.name })
        .from(agentSkillAssignments)
        .innerJoin(agents, eq(agents.id, agentSkillAssignments.agentId))
        .where(
          and(
            eq(agentSkillAssignments.entityId, session.entityId),
            inArray(agentSkillAssignments.skillId, skillIds),
          ),
        );
      for (const a of assignments) {
        const existing = assignedAgentNamesMap.get(a.skillId) ?? [];
        existing.push(a.agentName);
        assignedAgentNamesMap.set(a.skillId, existing);
      }
    }

    // Fetch createdByAgentName for skills with a non-null createdByAgentId
    const createdByAgentIds = [
      ...new Set(rows.map((r) => r.createdByAgentId).filter((id): id is string => id !== null)),
    ];
    const createdByAgentNameMap = new Map<string, string>();
    if (createdByAgentIds.length > 0) {
      const createdByAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.entityId, session.entityId), inArray(agents.id, createdByAgentIds)));
      for (const a of createdByAgents) {
        createdByAgentNameMap.set(a.id, a.name);
      }
    }

    return ok(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        content: r.content,
        description: r.description,
        state: r.state,
        patchCount: r.patchCount,
        lastUsedAt: r.lastUsedAt,
        archivedAt: r.archivedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        createdByAgentId: r.createdByAgentId,
        assignedAgentNames: assignedAgentNamesMap.get(r.id) ?? [],
        createdByAgentName: r.createdByAgentId
          ? (createdByAgentNameMap.get(r.createdByAgentId) ?? null)
          : null,
      })),
    );
  } catch (err) {
    console.error('[listLearnedSkillsAction]', err);
    return fail('db_error', 'Failed to load learned skills');
  }
}

// ─── archiveLearnedSkillAction ────────────────────────────────────────────────

export async function archiveLearnedSkillAction(skillId: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(skillId).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();

    const result = await archiveAgentSkill(db, session.entityId, skillId);
    if ('error' in result) {
      if (result.error === 'not_found') return fail('not_found', 'Skill not found');
      if (result.error === 'not_agent_skill') {
        return fail('forbidden', 'Only agent-authored skills can be managed here');
      }
    }

    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[archiveLearnedSkillAction]', err);
    return fail('db_error', 'Failed to archive skill');
  }
}

// ─── restoreLearnedSkillAction ────────────────────────────────────────────────

export async function restoreLearnedSkillAction(skillId: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(skillId).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();

    // Verify skill belongs to entity AND was created by agent
    const [row] = await db
      .select({ id: agentSkills.id, createdBy: agentSkills.createdBy })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, session.entityId)))
      .limit(1);

    if (!row) return fail('not_found', 'Skill not found');
    if (row.createdBy !== 'agent') {
      return fail('forbidden', 'Only agent-authored skills can be managed here');
    }

    await db
      .update(agentSkills)
      .set({ state: 'active', archivedAt: null, updatedAt: new Date() })
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, session.entityId)));

    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[restoreLearnedSkillAction]', err);
    return fail('db_error', 'Failed to restore skill');
  }
}

// ─── deleteLearnedSkillAction ─────────────────────────────────────────────────

export async function deleteLearnedSkillAction(skillId: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(skillId).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();

    // Verify skill belongs to entity AND was created by agent
    const [row] = await db
      .select({ id: agentSkills.id, createdBy: agentSkills.createdBy })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, session.entityId)))
      .limit(1);

    if (!row) return fail('not_found', 'Skill not found');
    if (row.createdBy !== 'agent') {
      return fail('forbidden', 'Only agent-authored skills can be managed here');
    }

    await db
      .delete(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, session.entityId)));

    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteLearnedSkillAction]', err);
    return fail('db_error', 'Failed to delete skill');
  }
}

// ─── getSkillAssignmentModeAction ─────────────────────────────────────────────

export async function getSkillAssignmentModeAction(): Promise<ActionResult<'auto' | 'approval'>> {
  try {
    const session = await getSession();
    const db = getDb();
    const [row] = await db
      .select({ skillAssignmentMode: entities.skillAssignmentMode })
      .from(entities)
      .where(eq(entities.id, session.entityId))
      .limit(1);
    if (!row) return fail('not_found', 'Entity not found');
    return ok((row.skillAssignmentMode ?? 'approval') as 'auto' | 'approval');
  } catch (err) {
    console.error('[getSkillAssignmentModeAction]', err);
    return fail('db_error', 'Failed to load assignment mode');
  }
}

// ─── setSkillAssignmentModeAction ─────────────────────────────────────────────

export async function setSkillAssignmentModeAction(mode: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = z.enum(['auto', 'approval']).safeParse(mode);
    if (!parsed.success) return fail('validation_failed', 'mode must be "auto" or "approval"');
    const db = getDb();
    await db
      .update(entities)
      .set({ skillAssignmentMode: parsed.data, updatedAt: new Date() })
      .where(eq(entities.id, session.entityId));
    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[setSkillAssignmentModeAction]', err);
    return fail('db_error', 'Failed to update assignment mode');
  }
}

// ─── listAssignableAgentsAction ───────────────────────────────────────────────

export async function listAssignableAgentsAction(): Promise<
  ActionResult<{ id: string; name: string; slug: string }[]>
> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select({ id: agents.id, name: agents.name, slug: agents.slug })
      .from(agents)
      .where(and(eq(agents.entityId, session.entityId), eq(agents.active, true)))
      .orderBy(agents.position, agents.name);
    return ok(rows);
  } catch (err) {
    console.error('[listAssignableAgentsAction]', err);
    return fail('db_error', 'Failed to load agents');
  }
}

// ─── assignLearnedSkillAction ─────────────────────────────────────────────────

export async function assignLearnedSkillAction(
  skillId: unknown,
  agentId: unknown,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsedSkill = z.string().uuid().safeParse(skillId);
    const parsedAgent = z.string().uuid().safeParse(agentId);
    if (!parsedSkill.success) return fail('validation_failed', 'Invalid skill id');
    if (!parsedAgent.success) return fail('validation_failed', 'Invalid agent id');

    const db = getDb();
    const [row] = await db
      .select({ id: agentSkills.id, createdBy: agentSkills.createdBy })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, parsedSkill.data), eq(agentSkills.entityId, session.entityId)))
      .limit(1);
    if (!row) return fail('not_found', 'Skill not found');
    if (row.createdBy !== 'agent')
      return fail('forbidden', 'Only agent-authored skills can be assigned here');

    const result = await assignSkillRepo(
      db,
      session.entityId,
      { skillId: parsedSkill.data, agentId: parsedAgent.data },
      [],
    );
    if ('error' in result) {
      if (result.error === 'already_assigned') {
        revalidatePath('/learned-skills');
        return ok(undefined); // idempotent
      }
      if (result.error === 'agent_not_found') return fail('not_found', 'Agent not found');
      if (result.error === 'skill_not_found') return fail('not_found', 'Skill not found');
    }
    revalidatePath('/learned-skills');
    return ok(undefined);
  } catch (err) {
    console.error('[assignLearnedSkillAction]', err);
    return fail('db_error', 'Failed to assign skill');
  }
}
