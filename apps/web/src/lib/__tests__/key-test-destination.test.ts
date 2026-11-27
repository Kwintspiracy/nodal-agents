// key-test-destination.test.ts — the dashboard's connection test reaches the
// address a real model call reaches, for the same saved row.
//
// Both resolve their address with `resolveProviderEndpoint`: the stored base
// URL, else the provider's official address, never one read from the process
// environment. The transport of @nodal-agents/llm is replaced by a recorder
// (the dashboard's test and every SDK client go through it), so the
// assertions compare the URLs of the requests actually sent.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys } from '@nodal-agents/db';
import { MODEL_PROVIDER_NAMES, providerDestination } from '@nodal-agents/shared';
import type { ModelProviderName } from '@nodal-agents/shared';

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
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

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

const transport = vi.hoisted(() => ({ sent: [] as string[] }));

// The ONE transport of every provider call (the dashboard's probes and every
// SDK client of @nodal-agents/llm). Nothing leaves the machine.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: async (input: RequestInfo | URL): Promise<Response> => {
    transport.sent.push(String(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const ENV_CHOSEN_URL = 'http://env-chosen.invalid/v1';
const AMBIENT = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};

const MODEL: Record<ModelProviderName, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  ollama: 'llama3',
  'openai-compatible': 'local-model',
  google: 'gemini-3-flash',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'z-ai/glm-5.3',
  deepseek: 'deepseek-chat',
  minimax: 'MiniMax-M3',
  moonshot: 'kimi-k2.7',
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

beforeEach(() => {
  transport.sent = [];
  for (const k of AMBIENT) {
    saved[k] = process.env[k];
    process.env[k] = ENV_CHOSEN_URL;
  }
});

afterEach(() => {
  for (const k of AMBIENT) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

async function saveRow(provider: ModelProviderName, baseUrl: string | null): Promise<string> {
  await testDb.delete(entityLlmKeys);
  const [row] = await testDb
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider,
      apiKey: `stored-${provider}`,
      baseUrl,
      isActive: true,
    })
    .returning();
  if (!row) throw new Error('failed to seed llm key');
  return row.id;
}

/** The URL the dashboard's "Test connection" sends for a saved row. */
async function probeUrl(provider: ModelProviderName, keyId: string, baseUrl: string | null) {
  const { testLlmKeyAction } = await import('../actions.ts');
  transport.sent = [];
  const result = await testLlmKeyAction({ provider, keyId, baseUrl: baseUrl ?? undefined });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(transport.sent).toHaveLength(1);
  return transport.sent[0]!;
}

/** The URL a real model call built from the same row sends. */
async function realCallUrl(provider: ModelProviderName, baseUrl: string | null) {
  const { createLlmClient } = await import('@nodal-agents/llm');
  transport.sent = [];
  const client = createLlmClient({
    provider,
    model: MODEL[provider],
    apiKey: `stored-${provider}`,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });
  await client.generateText({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
  expect(transport.sent.length).toBeGreaterThan(0);
  return transport.sent[0]!;
}

const CASES: Array<{ provider: ModelProviderName; baseUrl: string | null }> = [
  ...MODEL_PROVIDER_NAMES.filter((p) => providerDestination(p, null) !== null).map((p) => ({
    provider: p,
    baseUrl: null,
  })),
  // A stored address, on a hosted provider and on a server the person runs.
  { provider: 'anthropic', baseUrl: 'http://127.0.0.1:9/gateway/v1' },
  { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' },
];

describe('connection test and real call share one destination @cap:choisir-modele/moteur', () => {
  it.each(CASES)(
    '$provider (stored address: $baseUrl): the test reaches the address a real call reaches',
    async ({ provider, baseUrl }) => {
      const keyId = await saveRow(provider, baseUrl);
      const destination = providerDestination(provider, baseUrl)!;

      const probe = await probeUrl(provider, keyId, baseUrl);
      const real = await realCallUrl(provider, baseUrl);

      expect({
        probe: probe.startsWith(`${destination}/`),
        real: real.startsWith(`${destination}/`),
        sameOrigin: new URL(probe).origin === new URL(real).origin,
      }).toEqual({ probe: true, real: true, sameOrigin: true });
    },
  );

  it('listing the models of a saved row reaches the same address as its real calls', async () => {
    const { listKeyModelsAction } = await import('../actions.ts');
    await saveRow('openai', null);
    const [row] = await testDb.select().from(entityLlmKeys);
    transport.sent = [];
    await listKeyModelsAction(row!.id);
    const listed = transport.sent[0]!;
    const real = await realCallUrl('openai', null);

    expect(new URL(listed).origin).toBe(new URL(real).origin);
    expect(listed).toBe('https://api.openai.com/v1/models');
  });
});
