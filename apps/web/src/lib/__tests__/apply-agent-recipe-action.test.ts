// apply-agent-recipe-action.test.ts — applying a profile to a freshly created
// agent, against real rows.
//
// Two defects codex found on PR #45, both of the kind that only shows on an
// install with more than one workspace — which every LAN install is:
//
//  1. The system skills live in the FIRST entity's rows (seedDefaultSkills
//     stamps them once, createdBy='system'). A recipe applied to an agent in
//     any OTHER entity looked up skills by entity id only, found none, and
//     reported every skill missing — the agent was created incomplete while
//     the toast blamed the catalogue. assignSkillRepo already resolves this
//     cross-entity case; the action must resolve the same way.
//
//  2. The read-only preset is owner-only outside local-trust (the editor's
//     setReviewerReadOnlyPresetAction gates it). Applying a recipe wrote the
//     same rules with no gate, so any member could lock down any agent in the
//     workspace through this action.
//
// Assertions are on agent_skill_assignments and approval_rules rows.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentSkills,
  agentSkillAssignments,
  approvalRules,
  entities,
  users,
} from '@nodal-agents/db';

let testDb: TestDb;
// The entity whose rows hold the system skills (the "seed" install).
let seedEntity: { entityId: string; userId: string };
// A SECOND workspace, owned by a different user — the LAN-signup shape.
let other: { entityId: string; userId: string };
// Whose session the action runs under; set per test.
let session: { userId: string; entityId: string };
let authMode: 'local-trust' | 'local-auth' = 'local-auth';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-auth' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (s: { userId: string; entityId?: string }) => ({
    ...s,
    entityId: session.entityId,
  }),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: session.userId, entityId: session.entityId }),
  };
});
vi.mock('@/lib/env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env.ts')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) => (k === 'AUTH_MODE' ? authMode : Reflect.get(t, k)),
    }),
  };
});

async function makeAgent(entityId: string, slug: string): Promise<string> {
  const [row] = await testDb
    .insert(agents)
    .values({ entityId, slug, name: slug, personality: 'x', model: 'm', role: 'agent' })
    .returning({ id: agents.id });
  return row!.id;
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  const s = await seedMinimal(testDb);
  seedEntity = { entityId: s.entityId, userId: s.userId };

  // System skills, stamped the way seedDefaultSkills does — on the seed
  // entity only, createdBy='system'.
  await testDb.insert(agentSkills).values(
    ['dev', 'request-review', 'code-review'].map((slug) => ({
      entityId: seedEntity.entityId,
      slug,
      name: slug,
      description: slug,
      content: '# x',
      createdBy: 'system' as const,
    })),
  );

  const [u] = await testDb
    .insert(users)
    .values({ email: `other-${Date.now()}@example.com` })
    .returning();
  const [e] = await testDb
    .insert(entities)
    .values({ userId: u!.id, name: 'Other', slug: `other-${Date.now()}` })
    .returning();
  other = { entityId: e!.id, userId: u!.id };
});

beforeEach(() => {
  authMode = 'local-auth';
});

describe('applyAgentRecipeAction', () => {
  it('attaches the system skills to an agent in a workspace that does NOT own their rows', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const agentId = await makeAgent(other.entityId, `dev-${Date.now()}`);
    const { applyAgentRecipeAction } = await import('../actions.ts');

    const res = await applyAgentRecipeAction({ agentId, recipeSlug: 'developer' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skillsMissing).toEqual([]);
    expect(res.data.skillsAttached.sort()).toEqual(['dev', 'request-review']);

    const rows = await testDb
      .select({ slug: agentSkills.slug })
      .from(agentSkillAssignments)
      .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
      .where(eq(agentSkillAssignments.agentId, agentId));
    expect(rows.map((r) => r.slug).sort()).toEqual(['dev', 'request-review']);
  });

  it('applies the read-only preset for the workspace OWNER', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const agentId = await makeAgent(other.entityId, `rev-${Date.now()}`);
    const { applyAgentRecipeAction } = await import('../actions.ts');

    const res = await applyAgentRecipeAction({ agentId, recipeSlug: 'code-reviewer' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.readOnlyApplied).toBe(true);
    const rules = await testDb
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(eq(approvalRules.agentId, agentId));
    expect(rules.map((r) => r.toolName).sort()).toEqual([
      'file_edit',
      'file_write',
      'run_command',
      'run_skill_script',
      'skill_file_write',
    ]);
    expect(rules.every((r) => r.action === 'block')).toBe(true);
  });

  it('refuses the read-only preset to a NON-owner member outside local-trust', async () => {
    // A member of `other` who is not its owner.
    const [member] = await testDb
      .insert(users)
      .values({ email: `member-${Date.now()}@example.com` })
      .returning();
    session = { userId: member!.id, entityId: other.entityId };
    const agentId = await makeAgent(other.entityId, `rev2-${Date.now()}`);
    const { applyAgentRecipeAction } = await import('../actions.ts');

    const res = await applyAgentRecipeAction({ agentId, recipeSlug: 'code-reviewer' });

    // Same boundary as setReviewerReadOnlyPresetAction: forbidden, and NO rule
    // written — an agent half-locked by a member would be worse than none.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('forbidden');
    const rules = await testDb
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.action, 'block')));
    expect(rules).toHaveLength(0);
  });

  it('lets a non-owner apply a recipe with NO preset — skills are not owner-gated', async () => {
    const [member] = await testDb
      .insert(users)
      .values({ email: `member2-${Date.now()}@example.com` })
      .returning();
    session = { userId: member!.id, entityId: other.entityId };
    const agentId = await makeAgent(other.entityId, `dev2-${Date.now()}`);
    const { applyAgentRecipeAction } = await import('../actions.ts');

    const res = await applyAgentRecipeAction({ agentId, recipeSlug: 'developer' });

    expect(res.ok).toBe(true);
  });
});
