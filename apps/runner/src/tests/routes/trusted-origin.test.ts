// trusted-origin.test.ts — NETWORK-001 wiring regression.
//
// packages/auth covers the DECISION (isAllowedOrigin / isAllowedHost). This
// suite covers the WIRING: that createApp actually installs the middleware on
// /api/*, that it runs BEFORE auth, and that it leaves /webhooks alone.
//
// The four requests asserted here are the ones measured against a running
// nodal-agents@0.8.1 in its default configuration (bind=loopback →
// local-trust). Every one of them returned 202 with a job created, and the
// runner log showed `[exec …] enter` — the agent actually started.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createApp } from '../../server.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

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
  // local-trust is the DEFAULT a normal install gets. The whole point of this
  // guard is that "no user authentication" must not also mean "accept
  // instructions from any web page".
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

/**
 * POST /api/agent with the given headers, mirroring the audit's curl calls.
 *
 * The body is deliberately INVALID (`task` missing). The origin guard runs
 * before the route, so a rejected request still yields 403 — while an accepted
 * one stops at the route's 400 instead of inserting a job. That keeps this suite
 * from writing rows other suites in the same test database then trip over.
 */
async function postAgent(headers: Record<string, string>): Promise<Response> {
  return app.fetch(
    new Request('http://localhost:3099/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({}),
    }),
  );
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  await seedMinimal(db);

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient: createLlmClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260217',
      apiKey: 'test-key',
    }),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

describe('NETWORK-001 — /api is closed to foreign origins', () => {
  it('refuses a hostile Origin (CSRF from any page the user visits)', async () => {
    const res = await postAgent({ Origin: 'https://attacker.test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('refuses a text/plain body from a hostile Origin (no CORS preflight)', async () => {
    // text/plain is a CORS "simple" request: the browser sends it straight
    // through, so there is no preflight the server could refuse. What stops it
    // is the Origin the browser is forced to attach.
    const res = await app.fetch(
      new Request('http://localhost:3099/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          Origin: 'https://attacker.test',
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses a forged Host (DNS rebinding, Origin absent)', async () => {
    const res = await postAgent({ Host: 'evil.test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'host_not_allowed' });
  });

  it('refuses DNS rebinding where Origin and Host AGREE', async () => {
    // The case an Origin-vs-Host comparison lets through — which is what Next's
    // server-action guard does, measured at HTTP 200 on the dashboard.
    const res = await postAgent({ Origin: 'http://evil.test', Host: 'evil.test' });
    expect(res.status).toBe(403);
  });

  it('runs before auth: a hostile origin is refused even WITH a valid secret', async () => {
    const res = await postAgent({
      Origin: 'https://attacker.test',
      Authorization: `Bearer ${testEnv.WORKER_SECRET}`,
    });
    expect(res.status).toBe(403);
  });
});

describe('NETWORK-001 — legitimate callers keep working', () => {
  it('accepts the dashboard calling server-side (no Origin, loopback Host)', async () => {
    const res = await postAgent({});
    // 400 from the route's own body validation — anything but 403 proves the
    // guard let it through.
    expect(res.status).toBe(400);
  });

  it('accepts a same-origin browser request from the dashboard', async () => {
    const res = await postAgent({ Origin: 'http://localhost:3000' });
    expect(res.status).toBe(400);
  });

  it('accepts a phone on the LAN reaching the install by IP', async () => {
    const res = await postAgent({ Origin: 'http://192.168.1.42:3000', Host: '192.168.1.42:3099' });
    expect(res.status).toBe(400);
  });

  it('leaves /api/health reachable', async () => {
    const res = await app.fetch(new Request('http://localhost:3099/api/health'));
    expect(res.status).toBe(200);
  });
});

describe('NETWORK-001 — webhooks are deliberately exempt', () => {
  it('does not apply the origin guard to /webhooks', async () => {
    // Third-party services legitimately arrive with an arbitrary Host (a tunnel
    // hostname, a reverse proxy). Their auth is the slug+secret in the path.
    const res = await app.fetch(
      new Request('http://localhost:3099/webhooks/some-slug/some-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: 'hooks.example.com' },
        body: JSON.stringify({ hello: 'world' }),
      }),
    );
    // Whatever the route decides (404 for an unknown slug, 401 for a bad
    // secret), it must NOT be the origin guard talking.
    expect(res.status).not.toBe(403);
  });
});
