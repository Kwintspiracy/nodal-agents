// apply-agent-recipe-action.test.ts — creating an agent from a profile,
// against real rows. One entry point: createAgentAction with `recipeSlug`.
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
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  mcpServers,
  agentMcpServers,
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

const payload = (slug: string, recipeSlug: string) => ({
  slug,
  name: slug,
  personality: 'x',
  model: 'm',
  role: 'worker',
  subAgentIds: [],
  recipeSlug,
});

describe('the profile is applied through createAgentAction', () => {
  it('attaches the system skills to an agent in a workspace that does NOT own their rows', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');

    const res = await createAgentAction(payload(`dev-${Date.now()}`, 'developer'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recipe?.skillsMissing).toEqual([]);
    expect([...(res.data.recipe?.skillsAttached ?? [])].sort()).toEqual(['dev', 'request-review']);

    const rows = await testDb
      .select({ slug: agentSkills.slug })
      .from(agentSkillAssignments)
      .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
      .where(eq(agentSkillAssignments.agentId, res.data.id));
    expect(rows.map((r) => r.slug).sort()).toEqual(['dev', 'request-review']);
  });

  it('applies the read-only preset for the workspace OWNER', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');

    const res = await createAgentAction(payload(`rev-${Date.now()}`, 'code-reviewer'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recipe?.readOnlyApplied).toBe(true);
    const rules = await testDb
      .select({ toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(eq(approvalRules.agentId, res.data.id));
    expect(rules.map((r) => r.toolName).sort()).toEqual([
      'file_edit',
      'file_write',
      'run_command',
      'run_skill_script',
      'skill_file_write',
    ]);
    expect(rules.every((r) => r.action === 'block')).toBe(true);
  });

  it('lets a non-owner create from a profile with NO preset — skills are not owner-gated', async () => {
    const [member] = await testDb
      .insert(users)
      .values({ email: `member2-${Date.now()}@example.com` })
      .returning();
    session = { userId: member!.id, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');

    const res = await createAgentAction(payload(`dev2-${Date.now()}`, 'developer'));

    expect(res.ok).toBe(true);
  });
});

describe('recommended connectors', () => {
  it('are reported as "to set up" when the workspace has no instance — the agent is still created', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');

    const res = await createAgentAction(payload(`rev-nc-${Date.now()}`, 'code-reviewer'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recipe?.connectorsToSetUp).toEqual(['mcp-playwright']);
    expect(res.data.recipe?.connectorsAttached).toEqual([]);
    const links = await testDb
      .select({ id: agentMcpServers.id })
      .from(agentMcpServers)
      .where(eq(agentMcpServers.agentId, res.data.id));
    expect(links).toHaveLength(0);
  });

  it('are attached when the workspace already has the instance', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const [server] = await testDb
      .insert(mcpServers)
      .values({
        entityId: other.entityId,
        name: 'Playwright',
        slug: 'mcp-playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp'],
        active: true,
      })
      .returning({ id: mcpServers.id });
    // A same-slug instance in ANOTHER workspace must not be the one attached.
    await testDb.insert(mcpServers).values({
      entityId: seedEntity.entityId,
      name: 'Playwright (seed)',
      slug: 'mcp-playwright',
      transport: 'stdio',
      command: 'npx',
      args: [],
      active: true,
    });
    try {
      const { createAgentAction } = await import('../actions.ts');
      const res = await createAgentAction(payload(`rev-wc-${Date.now()}`, 'code-reviewer'));

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.recipe?.connectorsAttached).toEqual(['mcp-playwright']);
      expect(res.data.recipe?.connectorsToSetUp).toEqual([]);
      const links = await testDb
        .select({ mcpServerId: agentMcpServers.mcpServerId, entityId: agentMcpServers.entityId })
        .from(agentMcpServers)
        .where(eq(agentMcpServers.agentId, res.data.id));
      expect(links).toEqual([{ mcpServerId: server!.id, entityId: other.entityId }]);
    } finally {
      await testDb
        .delete(mcpServers)
        .where(and(eq(mcpServers.slug, 'mcp-playwright'), eq(mcpServers.transport, 'stdio')));
    }
  });
});

describe('createAgentAction with a profile — one gesture, nothing half-done', () => {
  // Codex, PR #45 second pass: with the profile applied in a SECOND action, a
  // non-owner picking Code reviewer got a created agent, then a refused
  // preset — and kept an ordinary write-capable agent named after one that
  // had promised never to write. Assertions on the agents table itself.
  it('refuses a NON-owner the read-only profile BEFORE any agent exists', async () => {
    const [member] = await testDb
      .insert(users)
      .values({ email: `member3-${Date.now()}@example.com` })
      .returning();
    session = { userId: member!.id, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');
    const slug = `rev3-${Date.now()}`;

    const res = await createAgentAction(payload(slug, 'code-reviewer'));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('forbidden');
    const rows = await testDb.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug));
    expect(rows).toHaveLength(0);
  });

  it('creates the agent AND applies the profile for the owner, in one call', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');
    const slug = `rev4-${Date.now()}`;

    const res = await createAgentAction(payload(slug, 'code-reviewer'));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.recipe?.readOnlyApplied).toBe(true);
    expect(res.data.recipe?.skillsAttached).toEqual(['code-review']);
    const rules = await testDb
      .select({ toolName: approvalRules.toolName })
      .from(approvalRules)
      .where(eq(approvalRules.agentId, res.data.id));
    expect(rules).toHaveLength(5);
  });

  it('rolls the agent back when a promised skill is missing from the install', async () => {
    // A THIRD workspace where the system skills were never seeded — and whose
    // owner is not the seed entity's, so the cross-entity lookup finds nothing.
    const [u] = await testDb
      .insert(users)
      .values({ email: `bare-${Date.now()}@example.com` })
      .returning();
    const [bare] = await testDb
      .insert(entities)
      .values({ userId: u!.id, name: 'Bare', slug: `bare-${Date.now()}` })
      .returning();
    // Remove the system rows for this test only, then put them back.
    const sys = await testDb
      .delete(agentSkills)
      .where(eq(agentSkills.createdBy, 'system'))
      .returning();
    try {
      session = { userId: u!.id, entityId: bare!.id };
      const { createAgentAction } = await import('../actions.ts');
      const slug = `dev5-${Date.now()}`;

      const res = await createAgentAction(payload(slug, 'developer'));

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('dev');
      const rows = await testDb.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug));
      expect(rows).toHaveLength(0);
    } finally {
      await testDb.insert(agentSkills).values(sys.map((r) => ({ ...r, id: undefined })));
    }
  });

  it('a failed Team lead — the FIRST orchestrator — leaves the workspace root untouched (id AND grants)', async () => {
    // createAgentRepo makes the workspace's first orchestrator its root: it
    // writes entities.rootAgentId AND rootGrants. Codex read the Drizzle
    // schema (no FK declared) and concluded a delete-only rollback left a
    // dangling root id — the ACTUAL column is `REFERENCES agents(id) ON DELETE
    // SET NULL` (migration 0021), so the id was never the problem. rootGrants
    // was: a delete-only rollback leaves the workspace's grants rewritten by
    // an agent that no longer exists. One transaction undoes both.
    const [u] = await testDb
      .insert(users)
      .values({ email: `lead-${Date.now()}@example.com` })
      .returning();
    const [ws] = await testDb
      .insert(entities)
      .values({ userId: u!.id, name: 'Lead', slug: `lead-${Date.now()}` })
      .returning();
    // task-planning is NOT among the system rows this file seeds → missing.
    session = { userId: u!.id, entityId: ws!.id };
    const { createAgentAction } = await import('../actions.ts');
    const slug = `lead-${Date.now()}`;

    const res = await createAgentAction({ ...payload(slug, 'team-lead'), role: 'router' });

    expect(res.ok).toBe(false);
    const [ent] = await testDb
      .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
      .from(entities)
      .where(eq(entities.id, ws!.id));
    expect(ent?.rootAgentId).toBeNull();
    expect(ent?.rootGrants).toEqual({});
    const rows = await testDb.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug));
    expect(rows).toHaveLength(0);

    // And the workspace is still usable: a plain orchestrator can be created.
    const again = await createAgentAction({
      ...payload(`${slug}-b`, ''),
      recipeSlug: undefined,
      role: 'router',
    });
    expect(again.ok).toBe(true);
  });

  it('rejects an unknown profile without creating anything', async () => {
    session = { userId: other.userId, entityId: other.entityId };
    const { createAgentAction } = await import('../actions.ts');
    const slug = `nope-${Date.now()}`;

    const res = await createAgentAction(payload(slug, 'no-such-profile'));

    expect(res.ok).toBe(false);
    const rows = await testDb.select({ id: agents.id }).from(agents).where(eq(agents.slug, slug));
    expect(rows).toHaveLength(0);
  });
});
