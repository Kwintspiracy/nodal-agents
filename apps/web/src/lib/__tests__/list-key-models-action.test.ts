// list-key-models-action.test.ts — unit tests for listKeyModelsAction
// Asserts on real behaviour: ownership check, probe error handling, model parsing.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys, entities, users } from '@nodal-agents/db';

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
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

vi.mock('@nodal-agents/secrets', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isEncrypted: () => false,
  last4: (v: string) => v.slice(-4),
}));

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listKeyModelsAction', () => {
  it('returns ok([]) for a non-200 probe response', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');

    const [llmKey] = await testDb
      .insert(entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider: 'openai',
        apiKey: 'test-key-enc',
        baseUrl: null,
        isActive: true,
      })
      .returning();
    if (!llmKey) throw new Error('failed to seed llm key');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );

    const result = await listKeyModelsAction(llmKey.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('returns ok([]) on fetch network error', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');

    const [llmKey] = await testDb
      .insert(entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider: 'openai',
        apiKey: 'test-key-enc',
        baseUrl: null,
        isActive: true,
      })
      .returning();
    if (!llmKey) throw new Error('failed to seed llm key');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const result = await listKeyModelsAction(llmKey.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('returns parsed model ids on 200 response', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');

    const [llmKey] = await testDb
      .insert(entityLlmKeys)
      .values({
        entityId: seed.entityId,
        provider: 'openai',
        apiKey: 'test-key-enc',
        baseUrl: null,
        isActive: true,
      })
      .returning();
    if (!llmKey) throw new Error('failed to seed llm key');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }] }),
      ),
    );

    const result = await listKeyModelsAction(llmKey.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(['gpt-4o', 'gpt-3.5-turbo']);
  });

  it('rejects a keyId belonging to a different entity', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');

    // Create a second user + entity so the FK constraint is satisfied.
    const [otherUser] = await testDb
      .insert(users)
      .values({ email: `other-${Date.now()}@example.com` })
      .returning();
    if (!otherUser) throw new Error('failed to seed other user');

    const [otherEntity] = await testDb
      .insert(entities)
      .values({
        userId: otherUser.id,
        name: 'Other Entity',
        slug: `other-${Date.now()}`,
      })
      .returning();
    if (!otherEntity) throw new Error('failed to seed entity');

    const [otherKey] = await testDb
      .insert(entityLlmKeys)
      .values({
        entityId: otherEntity.id,
        provider: 'openai',
        apiKey: 'other-key',
        baseUrl: null,
        isActive: true,
      })
      .returning();
    if (!otherKey) throw new Error('failed to seed other key');

    const result = await listKeyModelsAction(otherKey.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('rejects a non-UUID keyId', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');

    const result = await listKeyModelsAction('not-a-uuid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });
});
