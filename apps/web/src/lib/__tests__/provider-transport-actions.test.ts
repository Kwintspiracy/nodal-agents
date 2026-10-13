// provider-transport-actions.test.ts — the dashboard's provider calls take the
// provider transport and release what they do not read (#608)
//
// Testing a key and listing its models are calls to a model provider, like a
// chat turn. They go through `providerFetch` (own HTTP/1.1 connections, the
// environment's proxy), and a refusal's body is cancelled, never left open.
// The transport is replaced by a recorder here: a call that reached the
// global fetch instead would not be seen.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys } from '@nodal-agents/db';

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

const transport = vi.hoisted(() => {
  const state = { sent: [] as string[], released: 0 };
  /** A refusal whose body never ends on its own: only a cancel releases it. */
  const endlessRefusal = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
        },
        cancel() {
          state.released += 1;
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  return { state, endlessRefusal };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nodal-agents/llm')>()),
  providerFetch: async (input: RequestInfo | URL) => {
    transport.state.sent.push(String(input));
    return transport.endlessRefusal();
  },
}));

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider calls of the dashboard (#608) @cap:choisir-modele/moteur', () => {
  it('testing a key goes through the provider transport, and the refusal is released', async () => {
    const { testLlmKeyAction } = await import('../actions.ts');
    transport.state.sent = [];
    transport.state.released = 0;

    const result = await testLlmKeyAction({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.50:8080/v1',
      apiKey: 'sk-test',
    });

    expect(result.ok).toBe(false);
    expect(transport.state.sent).toEqual(['http://192.168.1.50:8080/v1/models']);
    expect(transport.state.released).toBe(1);
  });

  it('listing the models of a key goes through the provider transport, and the refusal is released', async () => {
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
    transport.state.sent = [];
    transport.state.released = 0;

    const result = await listKeyModelsAction(llmKey.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
    expect(transport.state.sent).toEqual(['https://api.openai.com/v1/models']);
    expect(transport.state.released).toBe(1);
  });
});
