// learned-skills-actions.test.ts — unit tests for Phase D server actions
// Asserts on real DB state (not call counts — CLAUDE.md invariant 5).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentSkills, entities } from '@nodal-agents/db';

// Mock the server.ts module to inject our test DB
let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

// Mock next/headers so headers() doesn't throw outside request scope
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: () => {},
    get: () => null,
    delete: () => {},
  }),
}));

// Mock next/cache to avoid RSC-context dependency
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

// Mock @nodal-agents/auth
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('setReflectionEnabledAction', () => {
  it('flips reflection_enabled to true on the entity', async () => {
    const { setReflectionEnabledAction } = await import('../learned-skills-actions.ts');

    const result = await setReflectionEnabledAction(true);
    expect(result.ok).toBe(true);

    const [row] = await testDb
      .select({ reflectionEnabled: entities.reflectionEnabled })
      .from(entities)
      .where(eq(entities.id, seed.entityId));
    expect(row!.reflectionEnabled).toBe(true);
  });

  it('flips reflection_enabled to false on the entity', async () => {
    const { setReflectionEnabledAction } = await import('../learned-skills-actions.ts');

    const result = await setReflectionEnabledAction(false);
    expect(result.ok).toBe(true);

    const [row] = await testDb
      .select({ reflectionEnabled: entities.reflectionEnabled })
      .from(entities)
      .where(eq(entities.id, seed.entityId));
    expect(row!.reflectionEnabled).toBe(false);
  });
});

describe('archiveLearnedSkillAction — created_by guard', () => {
  it('refuses to archive a user-authored skill (created_by=user)', async () => {
    const { archiveLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-user-skill-${Date.now()}`,
        name: `Test User Skill ${Date.now()}`,
        content: 'user content',
        createdBy: 'user',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await archiveLearnedSkillAction(skill.id);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('forbidden');

    // Row UNCHANGED
    const [row] = await testDb
      .select({ state: agentSkills.state, archivedAt: agentSkills.archivedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(row!.state).toBe('active');
    expect(row!.archivedAt).toBeNull();
  });

  it('archives an agent-authored skill (created_by=agent)', async () => {
    const { archiveLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-agent-skill-archive-${Date.now()}`,
        name: `Test Agent Skill ${Date.now()}`,
        content: 'agent content',
        createdBy: 'agent',
        state: 'active',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await archiveLearnedSkillAction(skill.id);
    expect(result.ok).toBe(true);

    const [row] = await testDb
      .select({ state: agentSkills.state, archivedAt: agentSkills.archivedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(row!.state).toBe('archived');
    expect(row!.archivedAt).not.toBeNull();
  });
});

describe('restoreLearnedSkillAction — created_by guard', () => {
  it('refuses to restore a user-authored skill', async () => {
    const { restoreLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-user-restore-${Date.now()}`,
        name: `Test User Restore ${Date.now()}`,
        content: 'user content',
        createdBy: 'user',
        state: 'archived',
        archivedAt: new Date(),
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await restoreLearnedSkillAction(skill.id);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('forbidden');
  });

  it('restores an agent-authored archived skill to active', async () => {
    const { restoreLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-agent-restore-${Date.now()}`,
        name: `Test Agent Restore ${Date.now()}`,
        content: 'agent content',
        createdBy: 'agent',
        state: 'archived',
        archivedAt: new Date(),
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await restoreLearnedSkillAction(skill.id);
    expect(result.ok).toBe(true);

    const [row] = await testDb
      .select({ state: agentSkills.state, archivedAt: agentSkills.archivedAt })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(row!.state).toBe('active');
    expect(row!.archivedAt).toBeNull();
  });
});

describe('deleteLearnedSkillAction — created_by guard', () => {
  it('refuses to delete a user-authored skill', async () => {
    const { deleteLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-user-delete-${Date.now()}`,
        name: `Test User Delete ${Date.now()}`,
        content: 'user content',
        createdBy: 'user',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await deleteLearnedSkillAction(skill.id);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe('forbidden');

    // Row still exists
    const rows = await testDb
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(rows).toHaveLength(1);
  });

  it('hard-deletes an agent-authored skill', async () => {
    const { deleteLearnedSkillAction } = await import('../learned-skills-actions.ts');

    const [skill] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        slug: `test-agent-delete-${Date.now()}`,
        name: `Test Agent Delete ${Date.now()}`,
        content: 'agent content',
        createdBy: 'agent',
      })
      .returning();
    if (!skill) throw new Error('failed to seed skill');

    const result = await deleteLearnedSkillAction(skill.id);
    expect(result.ok).toBe(true);

    const rows = await testDb
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(rows).toHaveLength(0);
  });
});
