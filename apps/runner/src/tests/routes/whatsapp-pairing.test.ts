// whatsapp-pairing.test.ts — GET/POST /api/whatsapp/pairing: auth gate
// (requireRunnerAuth, shared with /api/agent et al.), entity scoping for an
// untrusted bearer-token caller, unknown-agent 404, qr masking outside
// qr_pending, and the manager-unavailable 503.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { users, entities, agents } from '@nodal-agents/db';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import type {
  WhatsAppManagerHandle,
  WhatsAppPairingState,
} from '../../channels/whatsapp/manager.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

/** A fake manager — configurable per test, no real Baileys/DB polling involved. */
function makeFakeManager(overrides: Partial<WhatsAppManagerHandle> = {}): WhatsAppManagerHandle {
  return {
    stop: async () => {},
    refreshNow: async () => {},
    activeCount: () => 0,
    getPairingState: () => null,
    ensurePairingStarted: async () => 'no_binding',
    ...overrides,
  };
}

function makeDeps(db: TestDb): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'k' }),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('GET /api/whatsapp/pairing — auth gate', () => {
  it('local-auth mode, no bearer → 401 (manager never consulted)', async () => {
    const app = createApp(makeDeps(db), { ...testEnv, AUTH_MODE: 'local-auth' }, makeFakeManager());
    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/whatsapp/pairing — local-trust mode', () => {
  it('503 when no manager is running', async () => {
    const app = createApp(makeDeps(db), testEnv, null);
    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`),
    );
    expect(res.status).toBe(503);
  });

  it('400 on a malformed agentId', async () => {
    const app = createApp(makeDeps(db), testEnv, makeFakeManager());
    const res = await app.fetch(
      new Request('http://localhost/api/whatsapp/pairing?agentId=not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('404 for an agent that does not exist', async () => {
    const app = createApp(makeDeps(db), testEnv, makeFakeManager());
    const res = await app.fetch(
      new Request(
        'http://localhost/api/whatsapp/pairing?agentId=00000000-0000-0000-0000-000000000000',
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('agent_not_found');
  });

  it('404 (no_whatsapp_binding) when the manager tracks nothing for this agent', async () => {
    const app = createApp(makeDeps(db), testEnv, makeFakeManager({ getPairingState: () => null }));
    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_whatsapp_binding');
  });

  it('returns {status, qr} while qr_pending', async () => {
    const state: WhatsAppPairingState = { status: 'qr_pending', qr: 'QR_TEST_PAYLOAD' };
    const app = createApp(makeDeps(db), testEnv, makeFakeManager({ getPairingState: () => state }));
    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; qr: string | null };
    expect(body).toEqual({ status: 'qr_pending', qr: 'QR_TEST_PAYLOAD' });
  });

  it('masks qr to null when status is not qr_pending, even if the manager still holds a stale value', async () => {
    // Defense in depth: the route itself must never leak a QR payload once
    // the socket has moved past qr_pending, regardless of what the manager
    // internally retains.
    const state: WhatsAppPairingState = { status: 'open', qr: 'STALE_SHOULD_NEVER_LEAK' };
    const app = createApp(makeDeps(db), testEnv, makeFakeManager({ getPairingState: () => state }));
    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; qr: string | null };
    expect(body).toEqual({ status: 'open', qr: null });
  });
});

describe('GET /api/whatsapp/pairing — bearer-token mode (entity scoping)', () => {
  it('404s an agent belonging to a DIFFERENT entity than the caller session', async () => {
    const [foreignUser] = await db
      .insert(users)
      .values({ email: `wa-pairing-foreign-${Date.now()}@example.com` })
      .returning();
    const [foreignEntity] = await db
      .insert(entities)
      .values({
        userId: foreignUser!.id,
        name: 'WA Pairing Foreign Entity',
        slug: `wa-pairing-foreign-entity-${Date.now()}`,
      })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        entityId: foreignEntity!.id,
        name: 'Foreign WA Agent',
        slug: `wa-pairing-foreign-agent-${Date.now()}`,
        personality: 'test',
      })
      .returning();

    const deps = makeDeps(db);
    deps.authProvider = {
      getSession: async () => ({ userId: 'caller-user', entityId: seed.entityId }),
    };
    const app = createApp(
      deps,
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
      makeFakeManager({ getPairingState: () => ({ status: 'open', qr: null }) }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${foreignAgent!.id}`, {
        headers: { Authorization: 'Bearer token' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('allows a caller to read its own entity agent pairing state', async () => {
    const deps = makeDeps(db);
    deps.authProvider = {
      getSession: async () => ({ userId: 'caller-user', entityId: seed.entityId }),
    };
    const app = createApp(
      deps,
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
      makeFakeManager({ getPairingState: () => ({ status: 'open', qr: null }) }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/api/whatsapp/pairing?agentId=${seed.agentId}`, {
        headers: { Authorization: 'Bearer token' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /api/whatsapp/pairing — start pairing', () => {
  it('202 ok:true when the manager reports "started"', async () => {
    const app = createApp(
      makeDeps(db),
      testEnv,
      makeFakeManager({ ensurePairingStarted: async () => 'started' }),
    );
    const res = await app.fetch(
      new Request('http://localhost/api/whatsapp/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: seed.agentId }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('404 (no_whatsapp_binding) when the manager reports "no_binding"', async () => {
    const app = createApp(
      makeDeps(db),
      testEnv,
      makeFakeManager({ ensurePairingStarted: async () => 'no_binding' }),
    );
    const res = await app.fetch(
      new Request('http://localhost/api/whatsapp/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: seed.agentId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('404 for an agent that does not exist', async () => {
    const app = createApp(makeDeps(db), testEnv, makeFakeManager());
    const res = await app.fetch(
      new Request('http://localhost/api/whatsapp/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: '00000000-0000-0000-0000-000000000000' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('401 with no auth in local-auth mode', async () => {
    const app = createApp(makeDeps(db), { ...testEnv, AUTH_MODE: 'local-auth' }, makeFakeManager());
    const res = await app.fetch(
      new Request('http://localhost/api/whatsapp/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: seed.agentId }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
