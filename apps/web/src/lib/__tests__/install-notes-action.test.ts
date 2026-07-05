// install-notes-action.test.ts — unit tests for M-2 (audit #2): install notes
// must be scoped per entity, not injected globally into every workspace's
// agents, and only settable by the workspace owner.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { users, entities, entityMembers } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let activeUserId: string;
let activeEntityId: string;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: activeEntityId,
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    set: () => {},
    get: () => null,
    delete: () => {},
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: activeUserId,
      entityId: activeEntityId,
    }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  activeUserId = seed.userId;
  activeEntityId = seed.entityId;

  // seedMinimal doesn't create an entity_members row — the owner-gate on
  // setInstallNotesAction reads entity_members directly, so seed it here.
  await testDb
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('install notes — entity scoping (M-2)', () => {
  it('setInstallNotesAction persists notes visible via getInstallNotesAction for the same entity', async () => {
    const { setInstallNotesAction, getInstallNotesAction } = await import('../actions.ts');
    const writeResult = await setInstallNotesAction('ComfyUI runs on :8188');
    expect(writeResult.ok).toBe(true);

    const readResult = await getInstallNotesAction();
    expect(readResult.ok).toBe(true);
    if (readResult.ok) expect(readResult.data).toBe('ComfyUI runs on :8188');
  });

  it('notes written by entity A are NOT visible to entity B', async () => {
    const { setInstallNotesAction, getInstallNotesAction } = await import('../actions.ts');

    // Write as entity A (the seeded/active entity).
    await setInstallNotesAction('entity-A-secret-path');

    // Create a second user + entity + owner membership, then switch "active".
    const [otherUser] = await testDb
      .insert(users)
      .values({ email: `other-${Date.now()}@example.com` })
      .returning();
    if (!otherUser) throw new Error('failed to seed other user');
    const [otherEntity] = await testDb
      .insert(entities)
      .values({ userId: otherUser.id, name: 'Other Entity', slug: `other-${Date.now()}` })
      .returning();
    if (!otherEntity) throw new Error('failed to seed other entity');
    await testDb
      .insert(entityMembers)
      .values({ entityId: otherEntity.id, userId: otherUser.id, role: 'owner' });

    activeUserId = otherUser.id;
    activeEntityId = otherEntity.id;

    const readResult = await getInstallNotesAction();
    expect(readResult.ok).toBe(true);
    // Entity B has never set notes — must read '', never entity A's value.
    if (readResult.ok) expect(readResult.data).toBe('');
  });

  it('setInstallNotesAction is refused for a non-owner member', async () => {
    const { setInstallNotesAction } = await import('../actions.ts');

    const [memberUser] = await testDb
      .insert(users)
      .values({ email: `member-${Date.now()}@example.com` })
      .returning();
    if (!memberUser) throw new Error('failed to seed member user');
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: memberUser.id, role: 'member' });

    activeUserId = memberUser.id;
    activeEntityId = seed.entityId;

    const result = await setInstallNotesAction('should not be allowed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });
});
