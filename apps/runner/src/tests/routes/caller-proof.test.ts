// caller-proof.test.ts — every caller of the runner proves who it is, in every
// auth mode, on the REAL app (`createApp`).
//
//   1. the routes that start a job, stream events and settle a decision answer
//      401 without the install's secret in the mode with no password, and are
//      served with it;
//   2. EVERY route of the app (walked from its router), in each of the three
//      auth modes: no proof is a 401, the secret passes the door; the only
//      routes out of the rule are the device pairing gestures, which a device
//      calls before it holds a key;
//   3. the caller the door proved is the caller the routes read: the secret is
//      trusted, the API token is its own workspace;
//   4. who answers an approval belongs to the workspace of the request, the
//      secret notwithstanding;
//   5. a refusal is logged with its route and reason, never a header value.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, entities, entityMembers, eq, users } from '@nodal-agents/db';
import { createToolRegistry } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { BearerTokenProvider, LocalTrustProvider, bodyTypesFor } from '@nodal-agents/auth';
import { isDevicePairingRoute } from '@nodal-agents/shared';
import { createApp } from '../../server.ts';
import { RUNNER_BODY_ROUTES } from '../../lib/admission.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

vi.setConfig({ testTimeout: 60_000 });

const SECRET_VALUE = 'install-secret-0123456789-0123456789';

const baseEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: SECRET_VALUE,
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  // Where the runner calls itself (`triggerWorker`): a port nothing serves, so
  // a route walked here never reaches a server of this machine.
  APP_URL: 'http://127.0.0.1:9',
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

const SECRET = { Authorization: `Bearer ${SECRET_VALUE}` };
const API_TOKEN = 'api-token-0123456789-0123456789-0123';
const MODES = ['local-trust', 'local-auth', 'bearer-token'] as const;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(entities)
    .set({ rootAgentId: seed.agentId })
    .where(eq(entities.id, seed.entityId));
});

function envFor(mode: (typeof MODES)[number]): RunnerEnv {
  return {
    ...baseEnv,
    AUTH_MODE: mode,
    BEARER_TOKEN: mode === 'bearer-token' ? API_TOKEN : undefined,
  };
}

function makeDeps(mode: (typeof MODES)[number] = 'local-trust'): RunnerDeps {
  return {
    db: db as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry: createToolRegistry(),
    authProvider:
      mode === 'bearer-token'
        ? new BearerTokenProvider({ token: API_TOKEN })
        : new LocalTrustProvider(),
    close: async () => {},
  };
}

type App = ReturnType<typeof createApp>;

async function send(
  app: App,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string; type?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) {
    headers['content-type'] = opts.type ?? 'application/json';
    headers['content-length'] = String(new TextEncoder().encode(opts.body).byteLength);
  }
  const res = await app.fetch(
    new Request(`http://127.0.0.1:3099${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** A concrete path for a route pattern: each `:param` becomes a sample value. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
}

/** The answers that mean the DOOR refused the request (not its route). */
const DOOR_CODES = new Set([
  'proof_required',
  'proof_invalid',
  'origin_not_allowed',
  'host_not_allowed',
  'unsupported_media_type',
  'AUTH_REQUIRED',
]);

// ─── 1. The routes that act, in the mode with no password ───────────────────

describe('the mode with no password asks every caller for the install secret @cap:se-connecter/moteur', () => {
  // Bodies and queries are deliberately incomplete: an admitted request stops
  // at the route's own 400, before it creates or resolves anything.
  const ACTING = [
    { name: 'start a job', method: 'POST', path: '/api/agent', body: '{}' },
    { name: 'read the events stream', method: 'GET', path: '/api/events' },
    { name: 'answer an approval', method: 'POST', path: '/api/approve', body: '{}' },
    { name: 'stop a turn', method: 'POST', path: '/api/chat/stop', body: '{}' },
    {
      name: 'confirm a device',
      method: 'POST',
      path: '/api/device-pairings/00000000-0000-4000-8000-000000000000/confirm',
      body: '{}',
    },
  ];

  for (const route of ACTING) {
    it(`${route.name}: no secret is 401 proof_required, a wrong one 401 proof_invalid, the secret is served`, async () => {
      const app = createApp(makeDeps(), baseEnv);
      const body = route.body !== undefined ? { body: route.body } : {};
      expect(await send(app, route.method, route.path, body)).toEqual({
        status: 401,
        json: { error: 'proof_required' },
      });
      expect(
        await send(app, route.method, route.path, {
          ...body,
          headers: { Authorization: 'Bearer not-the-secret' },
        }),
      ).toEqual({ status: 401, json: { error: 'proof_invalid' } });
      const served = await send(app, route.method, route.path, { ...body, headers: SECRET });
      expect(served.status, JSON.stringify(served.json)).toBe(400);
      expect(served.json['error']).toBe('invalid_request');
    });
  }

  it('the refusal is logged with its route and reason, never a header value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = createApp(makeDeps(), baseEnv);
      await send(app, 'POST', '/api/agent', {
        body: '{}',
        headers: { Authorization: 'Bearer wrong-value-in-a-header' },
      });
      const lines = warn.mock.calls.map((args) => args.map(String).join(' '));
      expect(lines).toContain('[admission] refused POST /api/agent: proof_invalid');
      expect(lines.join('\n')).not.toContain('wrong-value-in-a-header');
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 2. Every route, in every mode ───────────────────────────────────────────

describe('every route of the runner asks for a proof, in every auth mode @cap:se-connecter/moteur', () => {
  const routes = createApp(makeDeps(), baseEnv)
    .routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'))
    .map((r) => ({ method: r.method, path: r.path }));

  it('the router has routes to walk, and the only ones out of the rule are the pairing gestures', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(
      routes
        .filter((r) => isDevicePairingRoute(r.method, concrete(r.path)))
        .map((r) => `${r.method} ${r.path}`),
    ).toEqual(['POST /api/devices/pair', 'POST /api/devices/pair/poll']);
  });

  for (const mode of MODES) {
    it(`${mode}: every route without a proof answers 401 proof_required`, async () => {
      const app = createApp(makeDeps(mode), envFor(mode));
      const answers: string[] = [];
      for (const r of routes.filter((x) => !isDevicePairingRoute(x.method, concrete(x.path)))) {
        const res = await send(app, r.method, concrete(r.path));
        answers.push(`${r.method} ${r.path} -> ${res.status} ${String(res.json['error'])}`);
      }
      expect(answers.filter((a) => !a.endsWith('-> 401 proof_required'))).toEqual([]);
    });

    it(`${mode}: with the install secret, every route passes the door`, async () => {
      const app = createApp(makeDeps(mode), envFor(mode));
      const answers: string[] = [];
      for (const r of routes) {
        // Each route with the body type it takes (JSON unless it declares another).
        const type = bodyTypesFor(r.method, concrete(r.path), RUNNER_BODY_ROUTES)[0];
        const res = await send(app, r.method, concrete(r.path), {
          headers: SECRET,
          ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}', type }),
        });
        answers.push(`${r.method} ${r.path} -> ${res.status} ${String(res.json['error'])}`);
      }
      expect(answers.filter((a) => DOOR_CODES.has(a.split(' ').at(-1) ?? ''))).toEqual([]);
    });
  }

  it('the pairing gestures reach their route without a key (the pairing is their proof)', async () => {
    const app = createApp(makeDeps(), baseEnv);
    for (const path of ['/api/devices/pair', '/api/devices/pair/poll']) {
      const res = await send(app, 'POST', path, { body: '{}' });
      expect(res.status, path).toBe(400);
      expect(DOOR_CODES.has(String(res.json['error'])), path).toBe(false);
    }
  });
});

// ─── 3. Who the caller is ───────────────────────────────────────────────────

describe('the caller the door proved is the caller the routes read @cap:se-connecter/moteur', () => {
  it('bearer-token: the API token is its own workspace only; the secret is trusted', async () => {
    const app = createApp(makeDeps('bearer-token'), envFor('bearer-token'));
    const other = await seedMinimal(db);
    // The token's session is the local workspace: stopping a turn of another
    // workspace is refused to it; the secret is trusted, and reaches the route's
    // own lookup of the conversation.
    const body = JSON.stringify({
      entityId: other.entityId,
      conversationId: '00000000-0000-4000-8000-0000000000c1',
    });
    const asToken = await send(app, 'POST', '/api/chat/stop', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      body,
    });
    expect(asToken).toEqual({ status: 403, json: { error: 'forbidden' } });
    const asSecret = await send(app, 'POST', '/api/chat/stop', { headers: SECRET, body });
    expect(asSecret).toEqual({ status: 404, json: { error: 'conversation_not_found' } });
  });

  it('local-trust and local-auth do not take an API token: 401 proof_invalid', async () => {
    for (const mode of ['local-trust', 'local-auth'] as const) {
      const app = createApp(makeDeps(mode), { ...envFor(mode), BEARER_TOKEN: API_TOKEN });
      const res = await send(app, 'GET', '/api/health', {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(res, mode).toEqual({ status: 401, json: { error: 'proof_invalid' } });
    }
  });
});

// ─── 4. Who answers belongs to the workspace ─────────────────────────────────

describe('who answers an approval belongs to its workspace @cap:se-connecter/moteur', () => {
  async function pendingApproval(entityId: string, agentId: string): Promise<string> {
    const [job] = await db
      .insert(agentJobs)
      .values({ entityId, agentId, channel: 'api', task: 't', status: 'awaiting_approval' })
      .returning();
    const [row] = await db
      .insert(approvalRequests)
      .values({
        entityId,
        jobId: job!.id,
        agentId,
        toolName: 'gmail_send',
        toolInput: { to: 'a@example.com' },
        status: 'pending',
      })
      .returning();
    return row!.id;
  }

  it('the secret with a responder of ANOTHER workspace is refused 403, and nothing is written', async () => {
    const mine = await seedMinimal(db);
    const theirs = await seedMinimal(db);
    await db
      .insert(entityMembers)
      .values({ entityId: theirs.entityId, userId: theirs.userId, role: 'owner' });
    const approvalId = await pendingApproval(mine.entityId, mine.agentId);
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/approve', {
      headers: SECRET,
      body: JSON.stringify({
        approvalRequestId: approvalId,
        decision: 'approve',
        responderUserId: theirs.userId,
      }),
    });
    expect(res).toEqual({ status: 403, json: { error: 'responder_not_member' } });
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(row!.status).toBe('pending');
  });

  it('an account that exists nowhere is refused the same way', async () => {
    const mine = await seedMinimal(db);
    const approvalId = await pendingApproval(mine.entityId, mine.agentId);
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/approve', {
      headers: SECRET,
      body: JSON.stringify({
        approvalRequestId: approvalId,
        decision: 'reject',
        responderUserId: '00000000-0000-4000-8000-00000000dead',
      }),
    });
    expect(res).toEqual({ status: 403, json: { error: 'responder_not_member' } });
  });

  it('a member of the workspace is served, and the decision is written', async () => {
    const mine = await seedMinimal(db);
    const [member] = await db
      .insert(users)
      .values({ email: `member-${Date.now()}@example.com` })
      .returning();
    await db
      .insert(entityMembers)
      .values({ entityId: mine.entityId, userId: member!.id, role: 'member' });
    const approvalId = await pendingApproval(mine.entityId, mine.agentId);
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/approve', {
      headers: SECRET,
      body: JSON.stringify({
        approvalRequestId: approvalId,
        decision: 'reject',
        responderUserId: member!.id,
      }),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    expect(row!.status).toBe('rejected');
  });

  it('bearer-token: the API token answers as its session, which belongs to its workspace only', async () => {
    const { LOCAL_ENTITY_ID, seedLocalUser } = await import('@nodal-agents/auth');
    await seedLocalUser(db as never);
    const app = createApp(makeDeps('bearer-token'), envFor('bearer-token'));
    // A request of its own workspace: answered, written.
    const own = await pendingApproval(LOCAL_ENTITY_ID, seed.agentId);
    const res = await send(app, 'POST', '/api/approve', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ approvalRequestId: own, decision: 'reject' }),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, own));
    expect(row!.status).toBe('rejected');
    // A request of another workspace does not even exist for it.
    const theirs = await pendingApproval(seed.entityId, seed.agentId);
    const refused = await send(app, 'POST', '/api/approve', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ approvalRequestId: theirs, decision: 'reject' }),
    });
    expect(refused).toEqual({ status: 404, json: { error: 'approval_not_found' } });
  });

  it("the workspace's owner belongs to it without a member row; a member row of ANOTHER workspace does not count", async () => {
    const mine = await seedMinimal(db);
    const theirs = await seedMinimal(db);
    // `theirs.userId` is a member of `theirs` only.
    await db
      .insert(entityMembers)
      .values({ entityId: theirs.entityId, userId: theirs.userId, role: 'admin' });
    const app = createApp(makeDeps(), baseEnv);
    const first = await pendingApproval(mine.entityId, mine.agentId);
    const byOwner = await send(app, 'POST', '/api/approve', {
      headers: SECRET,
      body: JSON.stringify({
        approvalRequestId: first,
        decision: 'reject',
        responderUserId: mine.userId,
      }),
    });
    expect(byOwner.status, JSON.stringify(byOwner.json)).toBe(200);
    const second = await pendingApproval(mine.entityId, mine.agentId);
    const byOther = await send(app, 'POST', '/api/approve', {
      headers: SECRET,
      body: JSON.stringify({
        approvalRequestId: second,
        decision: 'reject',
        responderUserId: theirs.userId,
      }),
    });
    expect(byOther).toEqual({ status: 403, json: { error: 'responder_not_member' } });
  });
});
