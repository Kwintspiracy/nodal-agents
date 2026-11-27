// request-admission.test.ts — the runner's door, on the REAL app (`createApp`).
//
// packages/auth proves the decision (`admitRequest`). This suite proves that
// the runner applies it, first, to every route it serves, in every auth mode:
//
//   1. a request sent on behalf of a page (it carries an `Origin`) is refused
//      without a credential, wherever the page lives: a private address, a
//      port of this machine, a public site, the dashboard's own origin;
//   2. the same requests with no `Origin` and the install's secret reach their
//      route (the caller rule itself is caller-proof.test.ts);
//   3. a body of a type the route does not take is refused, whoever sends it;
//   4. a paired device's key is a credential: a device client that is a page
//      keeps being served;
//   5. EVERY route of the app (walked from its router) is under the rule, so a
//      route added later cannot escape it;
//   6. the rule holds in local-auth and bearer-token modes too;
//   7. on a real socket, where the body's framing is the client's.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { devicePairings, entities, eq } from '@nodal-agents/db';
import { createToolRegistry } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { BearerTokenProvider, LocalTrustProvider } from '@nodal-agents/auth';
import { DEVICE_PROTOCOL_VERSION, DevicePairStartedSchema } from '@nodal-agents/shared';
import { createApp } from '../../server.ts';
import { RUNNER_BODY_ROUTES } from '../../lib/admission.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

vi.setConfig({ testTimeout: 30_000 });

const baseEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  // local-trust is the DEFAULT a normal install gets.
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3000',
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

/** Origins a page can have: where it lives never makes it Nodal's own. */
const PAGE_ORIGINS = [
  'http://192.168.1.1', // a private address (a router's page)
  'http://localhost:5173', // another port of this machine
  'https://pages.example', // a public site
  'http://localhost:3000', // the dashboard's own origin, calling the runner
  'null', // an opaque origin (sandboxed frame, file:)
];

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

beforeEach(async () => {
  await db.delete(devicePairings);
});

function makeDeps(authProvider: RunnerDeps['authProvider'] = new LocalTrustProvider()): RunnerDeps {
  return {
    db: db as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry: createToolRegistry(),
    authProvider,
    close: async () => {},
  };
}

type App = ReturnType<typeof createApp>;

/**
 * One request to the app. A body is sent with the framing a client gives it
 * (`Content-Length`), the header the runner reads to know a body is there.
 */
async function send(
  app: App,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Uint8Array; type?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    const bytes = typeof opts.body === 'string' ? new TextEncoder().encode(opts.body) : opts.body;
    headers['content-length'] = String(bytes.byteLength);
    if (opts.type !== undefined) headers['content-type'] = opts.type;
    body = new Blob([new Uint8Array(bytes)]);
  }
  const res = await app.fetch(
    new Request(`http://127.0.0.1:3099${path}`, { method, headers, ...(body ? { body } : {}) }),
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

const JSON_TYPE = 'application/json';
const SECRET = { Authorization: `Bearer ${baseEnv.WORKER_SECRET}` };

// ─── 1–2. A page without a credential, on the routes that act ───────────────

describe('the runner serves a page only with a credential @cap:se-connecter/moteur', () => {
  // Bodies and queries are deliberately incomplete: an admitted request stops
  // at the route's own 400, before it creates or resolves anything.
  const ACTING: { name: string; method: string; path: string; body?: string }[] = [
    { name: 'start a job', method: 'POST', path: '/api/agent', body: '{}' },
    { name: 'answer an approval', method: 'POST', path: '/api/approve', body: '{}' },
    { name: 'read the events stream', method: 'GET', path: '/api/events' },
  ];

  for (const route of ACTING) {
    for (const origin of PAGE_ORIGINS) {
      it(`${route.name}: Origin ${origin} without a credential is refused, 403 origin_not_allowed`, async () => {
        const app = createApp(makeDeps(), baseEnv);
        const res = await send(app, route.method, route.path, {
          headers: { Origin: origin },
          ...(route.body !== undefined ? { body: route.body, type: JSON_TYPE } : {}),
        });
        expect(res).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
      });
    }

    it(`${route.name}: with NO Origin and the secret, the request reaches its route`, async () => {
      const app = createApp(makeDeps(), baseEnv);
      const res = await send(app, route.method, route.path, {
        headers: SECRET,
        ...(route.body !== undefined ? { body: route.body, type: JSON_TYPE } : {}),
      });
      // The route's own validation answers: the door lets the caller in, and
      // the incomplete request is refused by the route, not by the door.
      expect(res.status).toBe(400);
      expect(res.json['error']).toBe('invalid_request');
    });
  }

  it('a page that carries the worker secret is served (the secret is the proof)', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/agent', {
      headers: { Origin: 'http://localhost:3000', ...SECRET },
      body: '{}',
      type: JSON_TYPE,
    });
    expect(res.status).toBe(400);
    expect(res.json['error']).toBe('invalid_request');
  });

  it('a wrong secret is not a proof', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/agent', {
      headers: { Origin: 'http://localhost:3000', Authorization: 'Bearer not-the-secret' },
      body: '{}',
      type: JSON_TYPE,
    });
    expect(res).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
  });

  it('a forged Host is refused, with or without an Origin (the name must mean this machine)', async () => {
    const app = createApp(makeDeps(), baseEnv);
    for (const headers of [
      { Host: 'evil.test' } as Record<string, string>,
      { Host: 'evil.test', Origin: 'http://evil.test' },
      { Host: 'evil.test', ...SECRET },
    ]) {
      const res = await send(app, 'POST', '/api/agent', { headers, body: '{}', type: JSON_TYPE });
      expect(res).toEqual({ status: 403, json: { error: 'host_not_allowed' } });
    }
  });

  it('the refusal is logged with its route and reason, never a header value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = createApp(makeDeps(), baseEnv);
      await send(app, 'POST', '/api/approve', {
        headers: { Origin: 'https://pages.example', Authorization: 'Bearer not-the-secret' },
        body: '{}',
        type: JSON_TYPE,
      });
      const lines = warn.mock.calls.map((args) => args.map(String).join(' '));
      expect(lines).toContain('[admission] refused POST /api/approve: origin_not_allowed');
      expect(lines.join('\n')).not.toContain('pages.example');
      expect(lines.join('\n')).not.toContain('not-the-secret');
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 3. Bodies ───────────────────────────────────────────────────────────────

describe('a body has the type its route takes @cap:se-connecter/moteur', () => {
  for (const type of [
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
  ]) {
    it(`a ${type} body on a JSON route is refused, 415, even with no Origin and the secret`, async () => {
      const app = createApp(makeDeps(), baseEnv);
      const res = await send(app, 'POST', '/api/agent', {
        headers: SECRET,
        body: '{"task":"x"}',
        type,
      });
      expect(res).toEqual({ status: 415, json: { error: 'unsupported_media_type' } });
    });
  }

  it('a body with no type at all is refused, 415', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/approve', { headers: SECRET, body: '{}' });
    expect(res).toEqual({ status: 415, json: { error: 'unsupported_media_type' } });
  });

  it('a JSON body with parameters is the JSON type', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const res = await send(app, 'POST', '/api/agent', {
      headers: SECRET,
      body: '{}',
      type: 'Application/JSON; charset=utf-8',
    });
    expect(res.status).toBe(400);
    expect(res.json['error']).toBe('invalid_request');
  });

  it('a request with no body needs no type (a turn ended, a pairing listed)', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const ended = await send(
      app,
      'POST',
      '/api/voice/turns/00000000-0000-4000-8000-000000000000/end',
      {
        headers: { 'content-length': '0', ...SECRET },
      },
    );
    expect(ended.status).not.toBe(415);
    expect(ended.json['error']).not.toBe('proof_required');
    const listed = await send(app, 'GET', `/api/device-pairings?entityId=${seed.entityId}`, {
      headers: SECRET,
    });
    expect(listed.status).toBe(200);
  });

  it('the audio of a turn takes octet-stream, and only that', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const path = '/api/voice/turns/00000000-0000-4000-8000-000000000000/chunks/0';
    const audio = await send(app, 'POST', path, {
      headers: SECRET,
      body: new Uint8Array([1, 2, 3, 4]),
      type: 'application/octet-stream',
    });
    // Past the door: the route answers about the turn, not about the type.
    expect(audio.status).not.toBe(415);
    expect(audio.status).not.toBe(401);
    expect(audio.json['error']).not.toBe('unsupported_media_type');
    const asText = await send(app, 'POST', path, {
      headers: SECRET,
      body: 'abcd',
      type: 'text/plain',
    });
    expect(asText).toEqual({ status: 415, json: { error: 'unsupported_media_type' } });
  });
});

// ─── 4. A paired device ──────────────────────────────────────────────────────

describe('a paired device is proved by its key, from a page too @cap:se-connecter/moteur', () => {
  /** Pair a device through the product's own path: request, owner confirms, collect. */
  async function pairedDevice(app: App): Promise<{ deviceId: string; token: string }> {
    const started = await send(app, 'POST', '/api/devices/pair', {
      body: JSON.stringify({
        name: 'Desk companion',
        capabilities: ['speaker'],
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      }),
      type: JSON_TYPE,
    });
    expect(started.status).toBe(201);
    const { pairingId, deviceCode } = DevicePairStartedSchema.parse(started.json);
    // The owner's side asks for the install's secret, like every owner route.
    const confirmed = await send(app, 'POST', `/api/device-pairings/${pairingId}/confirm`, {
      headers: SECRET,
      body: JSON.stringify({ entityId: seed.entityId }),
      type: JSON_TYPE,
    });
    expect(confirmed.status).toBe(200);
    const got = await send(app, 'POST', '/api/devices/pair/poll', {
      body: JSON.stringify({ deviceCode }),
      type: JSON_TYPE,
    });
    expect(got.status).toBe(200);
    return { deviceId: String(got.json['deviceId']), token: String(got.json['token']) };
  }

  it('with its key and an Origin, a device route is served; without the key, refused', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const { deviceId, token } = await pairedDevice(app);
    for (const origin of PAGE_ORIGINS) {
      const withKey = await send(app, 'GET', `/api/devices/${deviceId}/cards`, {
        headers: { Origin: origin, Authorization: `Bearer ${token}` },
      });
      expect(withKey.status, origin).toBe(200);
      expect(withKey.json, origin).toHaveProperty('cards');

      const noKey = await send(app, 'GET', `/api/devices/${deviceId}/cards`, {
        headers: { Origin: origin },
      });
      expect(noKey, origin).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
    }
  });

  it('a device key is a proof only where a device key is taken', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const { token } = await pairedDevice(app);
    // The owner's routes never take a device key: from a page, no proof at all.
    const res = await send(app, 'GET', `/api/device-pairings?entityId=${seed.entityId}`, {
      headers: { Origin: 'http://localhost:5173', Authorization: `Bearer ${token}` },
    });
    expect(res).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
  });

  it('a device sending no Origin is served as before', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const { deviceId, token } = await pairedDevice(app);
    const res = await send(app, 'GET', `/api/devices/${deviceId}/cards`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('a device JSON gesture from a page with its key passes the door (the route decides)', async () => {
    const app = createApp(makeDeps(), baseEnv);
    const { token } = await pairedDevice(app);
    const res = await send(app, 'POST', '/api/chat/stop', {
      headers: { Origin: 'http://localhost:5173', Authorization: `Bearer ${token}` },
      body: '{}',
      type: JSON_TYPE,
    });
    expect(res.status).toBe(400);
    expect(res.json['error']).toBe('invalid_request');
  });
});

// ─── 5. Every route ──────────────────────────────────────────────────────────

/** A concrete path for a route pattern: each `:param` becomes a sample value. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
}

describe('every route of the runner is under the rule @cap:se-connecter/moteur', () => {
  const app = createApp(makeDeps(), baseEnv);
  const routes = app.routes
    .filter((r) => r.method !== 'ALL')
    .map((r) => ({ method: r.method, path: r.path }));

  it('the router has routes to walk, and the only one outside /api is the webhook', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.filter((r) => !r.path.startsWith('/api/'))).toEqual([
      { method: 'POST', path: '/webhooks/:slug/:secret' },
    ]);
  });

  it('the admission is the FIRST thing mounted on /api/*', () => {
    const first = app.routes.find((r) => r.path === '/api/*');
    expect(first?.method).toBe('ALL');
    expect(first?.handler.name).toBe('admission');
  });

  it('every /api route refuses a page without a credential, 403 origin_not_allowed', async () => {
    const fresh = createApp(makeDeps(), baseEnv);
    const answers: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith('/api/'))) {
      const res = await send(fresh, r.method, concrete(r.path), {
        headers: { Origin: 'http://192.168.1.77:8080' },
      });
      answers.push(`${r.method} ${r.path} -> ${res.status} ${String(res.json['error'])}`);
    }
    expect(answers.filter((a) => !a.endsWith('-> 403 origin_not_allowed'))).toEqual([]);
  });

  for (const mode of ['local-trust', 'local-auth'] as const) {
    it(`${mode}: every /api route refuses a foreign name whose Origin equals its Host, 403 host_not_allowed`, async () => {
      // A foreign name pointed at this machine: the browser's Origin and Host
      // agree. The Host rule refuses it before any Origin rule, and a
      // credential does not change that.
      const fresh = createApp(makeDeps(), { ...baseEnv, AUTH_MODE: mode });
      const answers: string[] = [];
      for (const r of routes.filter((x) => x.path.startsWith('/api/'))) {
        for (const extra of [{}, SECRET]) {
          const res = await send(fresh, r.method, concrete(r.path), {
            headers: {
              Host: 'rebind.example:3001',
              Origin: 'http://rebind.example:3001',
              ...extra,
            },
          });
          answers.push(`${r.method} ${r.path} -> ${res.status} ${String(res.json['error'])}`);
        }
      }
      expect(answers.filter((a) => !a.endsWith('-> 403 host_not_allowed'))).toEqual([]);
    });
  }

  it('every /api route that takes a body refuses one of a type it does not take, 415', async () => {
    const fresh = createApp(makeDeps(), baseEnv);
    const answers: string[] = [];
    const withBody = routes.filter((x) => x.path.startsWith('/api/') && x.method !== 'GET');
    expect(withBody.length).toBeGreaterThan(25);
    for (const r of withBody) {
      const res = await send(fresh, r.method, concrete(r.path), {
        headers: SECRET,
        body: 'x=1',
        type: 'text/plain',
      });
      answers.push(`${r.method} ${r.path} -> ${res.status} ${String(res.json['error'])}`);
    }
    expect(answers.filter((a) => !a.endsWith('-> 415 unsupported_media_type'))).toEqual([]);
  });

  it('every route that declares another body type is a route the app serves', () => {
    const served = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const r of RUNNER_BODY_ROUTES) expect(served).toContain(`${r.method} ${r.path}`);
  });

  // Pinned on purpose: the runner answers no CORS preflight today, on any
  // route, device routes included. A change that starts answering some must
  // change this test, and say so.
  it('a preflight from a page is refused too: the runner answers none', async () => {
    const fresh = createApp(makeDeps(), baseEnv);
    const res = await send(fresh, 'OPTIONS', '/api/devices/pair', {
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
  });
});

// ─── 6. The other auth modes ─────────────────────────────────────────────────

describe('the rule holds in the sign-in and bearer modes @cap:se-connecter/moteur', () => {
  it('local-auth: a page is refused without a credential and served with the secret', async () => {
    const env: RunnerEnv = { ...baseEnv, AUTH_MODE: 'local-auth' };
    const app = createApp(makeDeps(), env);
    const page = await send(app, 'POST', '/api/agent', {
      headers: { Origin: 'http://192.168.1.20:3000' },
      body: '{}',
      type: JSON_TYPE,
    });
    expect(page).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
    const withSecret = await send(app, 'POST', '/api/agent', {
      headers: { Origin: 'http://192.168.1.20:3000', ...SECRET },
      body: '{}',
      type: JSON_TYPE,
    });
    expect(withSecret.status).toBe(400);
    // No Origin, no secret: the caller proves nothing, the door answers.
    const anonymous = await send(app, 'POST', '/api/agent', { body: '{}', type: JSON_TYPE });
    expect(anonymous).toEqual({ status: 401, json: { error: 'proof_required' } });
  });

  it('bearer-token: the API token is a credential; a page without it is refused', async () => {
    const env: RunnerEnv = { ...baseEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'api-token' };
    const app = createApp(makeDeps(new BearerTokenProvider({ token: 'api-token' })), env);
    const page = await send(app, 'GET', '/api/events', {
      headers: { Origin: 'https://pages.example' },
    });
    expect(page).toEqual({ status: 403, json: { error: 'origin_not_allowed' } });
    const withToken = await send(app, 'GET', '/api/events', {
      headers: { Origin: 'https://pages.example', Authorization: 'Bearer api-token' },
    });
    expect(withToken.status).toBe(400);
    expect(withToken.json['error']).toBe('invalid_request');
    const text = await send(app, 'POST', '/api/agent', {
      headers: { Authorization: 'Bearer api-token' },
      body: '{}',
      type: 'text/plain',
    });
    expect(text).toEqual({ status: 415, json: { error: 'unsupported_media_type' } });
  });
});

// ─── 7. On a real socket ─────────────────────────────────────────────────────

describe('on a real socket, the framing is the client own @cap:se-connecter/moteur', () => {
  let server: ServerType | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function listen(app: App): Promise<string> {
    return new Promise((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
        resolve(`http://127.0.0.1:${info.port}`),
      );
    });
  }

  it('a text body is refused 415, a page 403, and a JSON body reaches the route', async () => {
    const base = await listen(createApp(makeDeps(), baseEnv));
    const text = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: SECRET,
      body: '{"task":"x"}',
    });
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({ error: 'unsupported_media_type' });

    const page = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE, origin: 'http://192.168.1.1' },
      body: '{}',
    });
    expect(page.status).toBe(403);
    expect(await page.json()).toEqual({ error: 'origin_not_allowed' });

    const json = await fetch(`${base}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE, ...SECRET },
      body: '{}',
    });
    expect(json.status).toBe(400);
    expect(((await json.json()) as { error: string }).error).toBe('invalid_request');

    // A POST with no body, as a device ends its turn: no type needed.
    const ended = await fetch(`${base}/api/voice/turns/00000000-0000-4000-8000-000000000000/end`, {
      method: 'POST',
      headers: SECRET,
    });
    expect(ended.status).not.toBe(415);
    expect(ended.status).not.toBe(401);
  });
});
