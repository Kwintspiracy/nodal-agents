// server.test.ts — boot Hono, /health returns 200
// Minimal smoke test to verify server starts and responds.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { createApp } from '../server.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;

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
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;

  await seedMinimal(db);

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const llmClient = createLlmClient({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6-20260217',
    apiKey: 'test-key',
  });

  const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient,
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

afterAll(async () => {
  // cleanup is handled by pglite
});

describe('server boot', () => {
  it('GET /api/health returns 200', async () => {
    const res = await app.fetch(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
  });

  it('GET /unknown returns 404', async () => {
    const res = await app.fetch(new Request('http://localhost/unknown-route'));
    expect(res.status).toBe(404);
  });

  it('POST /api/cron returns tick result', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      orphanJobsReset: number;
      orphansReset: number;
      tasksUnblocked: number;
      tasksExecuted: number;
      rootsDelivered: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.orphanJobsReset).toBe('number');
    expect(typeof body.orphansReset).toBe('number');
    expect(typeof body.tasksUnblocked).toBe('number');
    expect(typeof body.tasksExecuted).toBe('number');
    expect(typeof body.rootsDelivered).toBe('number');
  });
});

// ─── requireRunnerAuth — local-auth mode ──────────────────────────────────────
//
// In local-auth mode every protected route must reject requests with no
// bearer or a wrong bearer, and pass through to the handler when the correct
// WORKER_SECRET is supplied.  We assert real HTTP status codes, not call counts.

describe('requireRunnerAuth — local-auth mode', () => {
  let localAuthApp: ReturnType<typeof createApp>;
  const localAuthEnv: RunnerEnv = { ...testEnv, AUTH_MODE: 'local-auth' };

  // Helper for a minimal valid POST to each route (body won't matter — the
  // middleware fires before body parsing on auth failure)
  const post = (app_: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app_.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'k' });
    const embeddingClient = createEmbeddingClient({ provider: 'keyword' });
    const deps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient,
      registry,
      // Null-session provider simulates local-auth (session cookie not shareable cross-process)
      authProvider: { getSession: async () => null },
      close: async () => {},
    };
    localAuthApp = createApp(deps, localAuthEnv);
  });

  // /api/chat — no auth → 401
  it('POST /api/chat with no auth → 401', async () => {
    const res = await post(localAuthApp, '/api/chat', {
      entityId: '00000000-0000-0000-0000-000000000001',
      agentId: '00000000-0000-0000-0000-000000000002',
      conversationId: '00000000-0000-0000-0000-000000000003',
      message: 'hello',
    });
    expect(res.status).toBe(401);
  });

  // /api/cron — no auth → 401
  it('POST /api/cron with no auth → 401', async () => {
    const res = await post(localAuthApp, '/api/cron', {});
    expect(res.status).toBe(401);
  });

  // /api/agent — no auth → 401
  it('POST /api/agent with no auth → 401', async () => {
    const res = await post(localAuthApp, '/api/agent', { task: 'do something' });
    expect(res.status).toBe(401);
  });

  // /api/approve — no auth → 401
  it('POST /api/approve with no auth → 401', async () => {
    const res = await post(localAuthApp, '/api/approve', {
      approvalRequestId: '00000000-0000-0000-0000-000000000099',
      decision: 'approve',
    });
    expect(res.status).toBe(401);
  });

  // Wrong bearer → 401 on all routes
  it('POST /api/chat with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/chat', { message: 'x' }, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('POST /api/cron with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/cron', {}, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('POST /api/agent with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/agent', { task: 'x' }, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('POST /api/approve with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/approve', {}, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  // Correct WORKER_SECRET → reaches the route handler (not 401)
  it('POST /api/cron with correct bearer → not 401 (reaches handler)', async () => {
    const res = await post(localAuthApp, '/api/cron', {}, { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` });
    // Handler returns 200 with cron tick result
    expect(res.status).not.toBe(401);
  });

  it('POST /api/agent with correct bearer → not 401 (reaches handler, gets 400 or 202)', async () => {
    const res = await post(localAuthApp, '/api/agent', { task: 'hello' }, { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` });
    // 202 (job created) or 400 (invalid body) — either proves we passed the auth gate
    expect(res.status).not.toBe(401);
  });

  it('POST /api/approve with correct bearer → not 401 (reaches handler, gets 404)', async () => {
    const res = await post(
      localAuthApp,
      '/api/approve',
      { approvalRequestId: '00000000-0000-0000-0000-000000000099', decision: 'approve' },
      { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` },
    );
    // 404 = approval_not_found → middleware passed through
    expect(res.status).not.toBe(401);
  });

  it('POST /api/chat with correct bearer → not 401 (reaches handler, gets 400 or 404)', async () => {
    const res = await post(
      localAuthApp,
      '/api/chat',
      {
        entityId: '00000000-0000-0000-0000-000000000001',
        agentId: '00000000-0000-0000-0000-000000000002',
        conversationId: '00000000-0000-0000-0000-000000000003',
        message: 'hello',
      },
      { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` },
    );
    // 400 (validation / agent_not_found) or 404 — middleware let us through
    expect(res.status).not.toBe(401);
  });
});

// ─── requireRunnerAuth — local-trust mode ────────────────────────────────────
//
// In local-trust mode all routes are accessible without any Authorization header.

describe('requireRunnerAuth — local-trust mode (no auth required)', () => {
  // The top-level `app` is created with AUTH_MODE='local-trust'

  it('POST /api/cron with no auth → reaches handler (not 401)', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron', { method: 'POST' }));
    expect(res.status).not.toBe(401);
  });

  it('POST /api/chat with no auth → reaches handler (not 401)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: '00000000-0000-0000-0000-000000000001',
          agentId: '00000000-0000-0000-0000-000000000002',
          conversationId: '00000000-0000-0000-0000-000000000003',
          message: 'hello',
        }),
      }),
    );
    expect(res.status).not.toBe(401);
  });

  it('POST /api/agent with no auth → reaches handler (not 401)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'hello' }),
      }),
    );
    expect(res.status).not.toBe(401);
  });
});

// ─── /api/approve auth — bearer fallback (legacy test, kept for regression) ──

describe('/api/approve auth — bearer fallback (cross-process call from web)', () => {
  // Build a NEW app with AUTH_MODE='local-auth' and a provider that returns
  // null. Without the bearer fallback this would 401 every request — only
  // a valid WORKER_SECRET should let the call through.
  let nullSessionApp: ReturnType<typeof createApp>;
  const lockedEnv: RunnerEnv = { ...testEnv, AUTH_MODE: 'local-auth' };

  beforeAll(async () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const llmClient = createLlmClient({
      provider: 'anthropic',
      model: 'test',
      apiKey: 'k',
    });
    const embeddingClient = createEmbeddingClient({ provider: 'keyword' });
    const deps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient,
      registry,
      authProvider: { getSession: async () => null },
      close: async () => {},
    };
    nullSessionApp = createApp(deps, lockedEnv);
  });

  it('returns 401 when neither session nor bearer is provided', async () => {
    const res = await nullSessionApp.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000099',
          decision: 'approve',
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer is wrong', async () => {
    const res = await nullSessionApp.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-secret',
        },
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000099',
          decision: 'approve',
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes through to the route when bearer matches WORKER_SECRET', async () => {
    // The route itself returns 404 (approval doesn't exist) — that proves
    // the middleware let us through; the bearer bypass works.
    const res = await nullSessionApp.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lockedEnv.WORKER_SECRET}`,
        },
        body: JSON.stringify({
          approvalRequestId: '00000000-0000-0000-0000-000000000099',
          decision: 'approve',
        }),
      }),
    );
    // 404 (approval_not_found) means we successfully reached the route.
    expect(res.status).toBe(404);
  });
});
