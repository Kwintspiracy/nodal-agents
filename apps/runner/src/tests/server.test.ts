// server.test.ts — boot Hono, /health returns 200
// Minimal smoke test to verify server starts and responds.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createEmbeddingClient } from '@nodal-agents/llm';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { createMemory } from '@nodal-agents/memory';
import { createApp, startBackfillBackground } from '../server.ts';
import { _resetGuardedTickForTests } from '../cron/guarded-tick.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// Finding R3 (audit2): POST /api/cron now goes through the SAME guarded entry
// point (cron/guarded-tick.ts's runCronTickGuarded) as the in-process ticker,
// so an external managed cron that overlaps itself is skipped exactly like an
// overlapping in-process tick would be. Gate the underlying tick.ts's
// runCronTick (leaving everything else real) so a describe block below can
// prove the route enforces this shared guard end-to-end over real HTTP.
const { getCronGate, setCronGate } = vi.hoisted(() => {
  let _gate: Promise<void> | null = null;
  return {
    getCronGate: () => _gate,
    setCronGate: (p: Promise<void> | null) => {
      _gate = p;
    },
  };
});

vi.mock('../cron/tick.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../cron/tick.ts')>();
  return {
    ...actual,
    runCronTick: async (...args: Parameters<typeof actual.runCronTick>) => {
      const gate = getCronGate();
      if (gate) await gate;
      return actual.runCronTick(...args);
    },
  };
});

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
  NODALAI_APPROVAL_GRACE_MS: 0,
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
  const post = (
    app_: ReturnType<typeof createApp>,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
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
    const res = await post(
      localAuthApp,
      '/api/chat',
      { message: 'x' },
      { Authorization: 'Bearer wrong' },
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/cron with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/cron', {}, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('POST /api/agent with wrong bearer → 401', async () => {
    const res = await post(
      localAuthApp,
      '/api/agent',
      { task: 'x' },
      { Authorization: 'Bearer wrong' },
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/approve with wrong bearer → 401', async () => {
    const res = await post(localAuthApp, '/api/approve', {}, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  // Correct WORKER_SECRET → reaches the route handler (not 401)
  it('POST /api/cron with correct bearer → not 401 (reaches handler)', async () => {
    const res = await post(
      localAuthApp,
      '/api/cron',
      {},
      { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` },
    );
    // Handler returns 200 with cron tick result
    expect(res.status).not.toBe(401);
  });

  it('POST /api/agent with correct bearer → not 401 (reaches handler, gets 400 or 202)', async () => {
    const res = await post(
      localAuthApp,
      '/api/agent',
      { task: 'hello' },
      { Authorization: `Bearer ${localAuthEnv.WORKER_SECRET}` },
    );
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

// ─── requireRunnerAuth — bearer-token mode: fail-closed on empty entityId ────
//
// Defense in depth for findings #4/#5: every entity-scoped route trusts that
// an untrusted (session bearer-token) caller's callerEntityId is always a
// real, non-empty id. If a future AuthProvider bug ever produced a session
// with a falsy entityId (e.g. an `?? ''` fallback), requireRunnerAuth must
// refuse it outright — NOT let it through as "authenticated with no entity",
// which would silently reopen the cross-entity IDOR at every downstream route.

describe('requireRunnerAuth — bearer-token mode (fail-closed on empty entityId)', () => {
  let emptyEntityApp: ReturnType<typeof createApp>;
  const bearerEnv: RunnerEnv = { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' };

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
      // A session with a falsy entityId — the exact bug this hardening guards against.
      authProvider: {
        getSession: async () => ({ userId: 'some-user', entityId: '' }),
      },
      close: async () => {},
    };
    emptyEntityApp = createApp(deps, bearerEnv);
  });

  it('POST /api/chat with a session but empty entityId → 401 (fail-closed, no route reached)', async () => {
    const res = await emptyEntityApp.fetch(
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
    expect(res.status).toBe(401);
  });

  it('POST /api/agent with a session but empty entityId → 401 (fail-closed, no route reached)', async () => {
    const res = await emptyEntityApp.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'hello' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/approve with a session but empty entityId → 401 (fail-closed, no route reached)', async () => {
    const res = await emptyEntityApp.fetch(
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
});

// ─── F-3 (audit #2): POST /api/cron restricted to trusted callers ───────────
//
// A tick is a GLOBAL system operation, not scoped to any one entity.
// requireRunnerAuth authenticates a plain session bearer-token caller (any
// entity's own API user) onto this route — that's correct AUTHENTICATION but
// the wrong AUTHORIZATION model: an ordinary entity user should not be able
// to force a global tick. Only trusted callers (local-trust, or a valid
// WORKER_SECRET bearer) may.

describe('POST /api/cron — F-3 restricted to trusted callers', () => {
  let cronBearerApp: ReturnType<typeof createApp>;
  const cronBearerEnv: RunnerEnv = {
    ...testEnv,
    AUTH_MODE: 'bearer-token',
    BEARER_TOKEN: 'token',
  };

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
      // A perfectly valid session with a real, non-empty entityId — an
      // ordinary authenticated entity user, not a system caller.
      authProvider: {
        getSession: async () => ({ userId: 'some-user', entityId: 'some-entity' }),
      },
      close: async () => {},
    };
    cronBearerApp = createApp(deps, cronBearerEnv);
  });

  it('an untrusted session bearer-token caller (real entity, own session) is refused with 403', async () => {
    const res = await cronBearerApp.fetch(
      new Request('http://localhost/api/cron', { method: 'POST' }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
  });

  it('a trusted WORKER_SECRET bearer still reaches the handler (200)', async () => {
    const res = await cronBearerApp.fetch(
      new Request('http://localhost/api/cron', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronBearerEnv.WORKER_SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ─── startBackfillBackground — finding M-17 ──────────────────────────────────
//
// The memory-embedding backfill used to run sequentially, unbounded, BEFORE
// serve() in main() — a slow provider (openai) + a large table stalled the
// whole boot with no health endpoint reachable. It now fires as a background
// task, AFTER serve(). These tests assert the non-blocking contract directly:
// the function returns synchronously (not a Promise the caller could await
// away the point of the fix), the backfill still runs to completion in the
// background, and a rejection never escapes as an unhandled rejection.

describe('startBackfillBackground', () => {
  it('returns synchronously (void, not a Promise) while the backfill keeps running in the background', async () => {
    let started = false;
    let finished = false;
    const slowEmbeddingClient: EmbeddingClient = {
      embed: async (text: string) => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished = true;
        return Array.from(
          { length: 1536 },
          (_, i) => ((text.charCodeAt(i % text.length) + i) % 100) / 100,
        );
      },
      dimensions: 1536,
    };

    const seed = await seedMinimal(db);
    await createMemory(db, {
      entity_id: seed.entityId,
      fact: 'Row backing the non-blocking backfill test.',
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });

    const returnValue = startBackfillBackground({
      db: db as RunnerDeps['db'],
      embeddingClient: slowEmbeddingClient,
    });

    // The call itself did not wait for embed() to run at all.
    expect(returnValue).toBeUndefined();
    expect(started).toBe(false);
    expect(finished).toBe(false);

    // But the backfill DOES eventually run to completion in the background.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(started).toBe(true);
    expect(finished).toBe(true);
  });

  it('a rejected backfill is caught — never surfaces as an unhandled rejection', async () => {
    // Break at the OUTER level (the initial select, which backfill.ts does NOT
    // wrap in a try/catch — only the per-row loop is guarded, on purpose: a
    // failure finding candidates at all is a real setup problem, not a
    // per-row retry case). This exercises startBackfillBackground's own
    // .catch(), independent of the per-row guard inside backfillEmbeddings.
    const brokenDb = {
      select: () => {
        throw new Error('db select boom');
      },
    } as unknown as RunnerDeps['db'];

    expect(() =>
      startBackfillBackground({
        db: brokenDb,
        embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      }),
    ).not.toThrow();

    // Give the background task time to run and (safely) fail. If the
    // rejection weren't caught, this would surface as an unhandled rejection
    // and fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

// ─── POST /api/cron — shared guard with the ticker (finding R3) ─────────────
//
// Before this fix, only the in-process ticker (ticker.ts) had the M-7
// re-entrancy guard — this HTTP route called runCronTick directly with no
// protection, so an external managed cron (Vercel/Fly) firing faster than a
// slow tick completes was exposed to the same concurrent pile-up. The route
// now delegates to the exact same `runCronTickGuarded` singleton the ticker
// uses (cron/guarded-tick.ts), so this test proves the ROUTE itself enforces
// the shared guard over real HTTP — not just that the ticker does.

describe('POST /api/cron — shared guard with the in-process ticker (finding R3)', () => {
  it('a second request while one is in flight is skipped (skipped:true, zero counts)', async () => {
    _resetGuardedTickForTests();

    let releaseGate!: () => void;
    setCronGate(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      }),
    );

    try {
      // First request starts a tick and gets stuck on the gate.
      const firstReqPromise = app.fetch(
        new Request('http://localhost/api/cron', { method: 'POST' }),
      );

      // Yield a turn so the handler actually reaches runCronTickGuarded and
      // sets `running = true` before the second request is dispatched.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Second request arrives while the first is still stuck on the gate —
      // simulates an external scheduler firing again before the previous
      // invocation returned.
      const secondRes = await app.fetch(
        new Request('http://localhost/api/cron', { method: 'POST' }),
      );
      expect(secondRes.status).toBe(200);
      const secondBody = (await secondRes.json()) as { ok: boolean; skipped: boolean };
      expect(secondBody.skipped).toBe(true);

      // Release the first request and confirm it completed normally.
      releaseGate();
      const firstRes = await firstReqPromise;
      const firstBody = (await firstRes.json()) as { ok: boolean; skipped: boolean };
      expect(firstBody.skipped).toBe(false);
    } finally {
      setCronGate(null);
      _resetGuardedTickForTests();
    }
  });
});
