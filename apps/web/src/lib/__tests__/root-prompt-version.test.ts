// root-prompt-version.test.ts — the screen that shows the ROOT's real prompt
// shows the version the runner states (#454, Codex review pass 2, P1).
//
// getRootSystemPromptAction built its own deployment context without a
// version, so the screen said "This runner does not know which Nodal-Agents
// version it is" while the runner knew it. Both now read the same source:
// NODAL_VERSION, passed by the launcher to the web and to the runner alike.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, entities, entityMembers } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const previous = process.env['NODAL_VERSION'];

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
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
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  const existing = await testDb
    .select()
    .from(entityMembers)
    .where(and(eq(entityMembers.entityId, seed.entityId), eq(entityMembers.userId, seed.userId)));
  if (existing.length === 0) {
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
  }
  await testDb
    .update(entities)
    .set({ rootAgentId: seed.agentId })
    .where(eq(entities.id, seed.entityId));
});

afterEach(() => {
  if (previous === undefined) delete process.env['NODAL_VERSION'];
  else process.env['NODAL_VERSION'] = previous;
});

describe('the ROOT prompt screen states the running version (#454)', () => {
  for (const version of ['0.9.4', '2.0.0-beta.3']) {
    it(`shows version ${version}, the one the launcher passed`, async () => {
      process.env['NODAL_VERSION'] = version;
      const { getRootSystemPromptAction } = await import('@/lib/actions');
      const res = await getRootSystemPromptAction();
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (res.ok) expect(res.data).toContain(`You run Nodal-Agents version ${version}`);
    });
  }

  it('says the runner does not know it when the launcher passed none', async () => {
    delete process.env['NODAL_VERSION'];
    const { getRootSystemPromptAction } = await import('@/lib/actions');
    const res = await getRootSystemPromptAction();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toContain('does not know which Nodal-Agents version it is');
  });
});
