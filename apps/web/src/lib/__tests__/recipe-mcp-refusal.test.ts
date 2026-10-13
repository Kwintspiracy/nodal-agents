// recipe-mcp-refusal.test.ts — when the attach rule refuses a server a profile
// recommends, the user is told why (#661, review pass 1).
//
// The refusal cannot arise from real rows today: a profile recommends distinct
// canonical catalog slugs, and the agent is brand new. The path must still
// carry the rule's own words to the user instead of a generic "Failed to
// create agent" (invariant #4), so the one attach function is made to refuse
// here, and the rest — the action, the profile, the rows — is real.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentMcpServers, agentSkills, mcpServers } from '@nodal-agents/db';

let testDb: TestDb;
let session: { userId: string; entityId: string };

const REFUSAL =
  'The MCP servers "Old" (mcp-playwright) and "New" (mcp-playwright) would lend tools under the same names.';

vi.mock('@nodal-agents/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/db')>();
  return {
    ...actual,
    attachMcpServerToAgent: async () => ({
      ok: false as const,
      reason: 'namespace_overlap' as const,
      message: REFUSAL,
      held: { id: 'x', slug: 'mcp-playwright', name: 'Old' },
    }),
  };
});
vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
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
      get: (t, k) => (k === 'AUTH_MODE' ? 'local-trust' : Reflect.get(t, k)),
    }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  const s = await seedMinimal(testDb);
  session = { userId: s.userId, entityId: s.entityId };
  await testDb.insert(agentSkills).values(
    ['dev', 'request-review', 'code-review'].map((slug) => ({
      entityId: s.entityId,
      slug,
      name: slug,
      description: slug,
      content: '# x',
      createdBy: 'system' as const,
    })),
  );
  await testDb.insert(mcpServers).values({
    entityId: s.entityId,
    name: 'New',
    slug: 'mcp-playwright',
    transport: 'stdio',
    command: 'npx',
    active: true,
  });
});

describe('a profile whose recommended server the attach rule refuses @cap:connecter-un-service/moteur', () => {
  it('creates the agent, attaches nothing, and hands the rule’s own words to the user', async () => {
    const { createAgentAction } = await import('../actions.ts');
    const res = await createAgentAction({
      slug: `rev-refused-${Date.now()}`,
      name: 'Reviewer',
      personality: 'x',
      model: 'm',
      role: 'worker',
      subAgentIds: [],
      recipeSlug: 'code-reviewer',
    });

    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    expect(res.data.recipe?.connectorsAttached).toEqual([]);
    expect(res.data.recipe?.connectorsNotAttached).toEqual([
      { slug: 'mcp-playwright', reason: REFUSAL },
    ]);
    const links = await testDb
      .select()
      .from(agentMcpServers)
      .where(eq(agentMcpServers.agentId, res.data.id));
    expect(links).toHaveLength(0);
  });
});
