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
  agentSkills,
  entities,
  archiveAgentSkill,
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
      })
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.entityId, session.entityId),
          or(eq(agentSkills.createdBy, 'agent'), sql`${agentSkills.patchCount} > 0`),
        ),
      )
      .orderBy(
        sql`${agentSkills.lastUsedAt} DESC NULLS LAST`,
        desc(agentSkills.createdAt),
      );

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
