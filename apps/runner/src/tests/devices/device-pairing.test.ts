// device-pairing.test.ts — a device pairs from its own side, and holds its own key (#946), on the REAL runner.
//
// The real app (`createApp`): the device gate, the pairing routes, the owner's
// routes, the device routes of #945, the dashboard routes a device speaks
// through, the real database. The device is a script: it calls the routes as
// any device would, from an address given to the request's socket.
//
// What is proven, by HTTP answers and rows in base:
//   1. pairing: a wrong or expired code is refused; polling faster than the
//      interval is `slow_down`; a refused request never yields a key; a
//      confirmed one yields it ONCE, kept only as a hash; two polls racing
//      never both collect it;
//   2. keys: a device reaches its own routes and conversations, and nothing
//      else — not another device, not another conversation of its
//      workspace, not a non-device route; the worker secret is refused on a
//      device's routes; the owner's routes refuse a device key;
//   3. a removed device: its key is refused on the next request, its open
//      stream is closed at once, cards stop reaching it;
//   4. the abuse limits hold, per address and in total;
//   5. isolation: a pairing confirmed in workspace X gives nothing in Y.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  approvalCardMessages,
  approvalRequests,
  conversations,
  devicePairings,
  devices,
  entities,
  isConversationAllowed,
} from '@nodal-agents/db';
import { createToolRegistry } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import {
  DEVICE_OWNER_ROUTES,
  DEVICE_PAIRING_GESTURES,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_TOKEN_RE,
  DevicePairStartedSchema,
  DevicePollResponseSchema,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { createApp } from '../../server.ts';
import { hashDeviceSecret } from '../../devices/device-secrets.ts';
import { isDeviceConnected } from '../../devices/device-streams.ts';
import { DEVICE_PAIRING_LIMITS } from '../../routes/device-pairing.ts';
import { readSse } from '../chat/_sse-reader.ts';
import { openUtterance } from '../../chat/voice-utterances.ts';
import { speakFinishedJob } from '../../chat/job-reply-voice.ts';

vi.setConfig({ testTimeout: 30_000 });

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 1,
  BIND: '127.0.0.1',
  APP_URL: 'http://127.0.0.1:1',
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

let db: TestDb;
let x: Awaited<ReturnType<typeof seedMinimal>>;
let y: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  x = await seedMinimal(db);
  y = await seedMinimal(db);
  for (const s of [x, y]) {
    await db.update(entities).set({ rootAgentId: s.agentId }).where(eq(entities.id, s.entityId));
  }
});

// Each test starts with no request waiting: the limits count them all.
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

const opened: AbortController[] = [];
afterEach(() => {
  for (const ctl of opened.splice(0)) ctl.abort();
});

/** A request as a device on the network sends it: from `address`, with no Origin. */
async function call(
  app: App,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; from?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    { incoming: { socket: { remoteAddress: opts.from ?? '192.168.1.40' } } },
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const key = (token: string) => ({ Authorization: `Bearer ${token}` });
const SECRET = { Authorization: `Bearer ${testEnv.WORKER_SECRET}` };

async function pair(
  app: App,
  opts: { name?: string; from?: string } = {},
): Promise<{ pairingId: string; deviceCode: string; userCode: string }> {
  const res = await call(app, 'POST', '/api/devices/pair', {
    body: {
      name: opts.name ?? 'Desk companion',
      capabilities: ['microphone', 'speaker'],
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    },
    from: opts.from ?? '192.168.1.40',
  });
  expect(res.status).toBe(201);
  return DevicePairStartedSchema.parse(res.json);
}

/** The next poll is on time: the clock of the last accepted poll is moved back. */
async function letPollAgain(pairingId: string): Promise<void> {
  await db
    .update(devicePairings)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(devicePairings.id, pairingId));
}

async function poll(app: App, deviceCode: string) {
  const res = await call(app, 'POST', '/api/devices/pair/poll', { body: { deviceCode } });
  return { status: res.status, body: DevicePollResponseSchema.parse(res.json) };
}

/** A device paired in workspace `s`, by the whole path: request, confirm, collect. */
async function pairedDevice(
  app: App,
  s: { entityId: string },
  from = '192.168.1.40',
): Promise<{ deviceId: string; token: string; conversationId: string }> {
  const started = await pair(app, { from });
  const confirmed = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
    body: { entityId: s.entityId },
  });
  expect(confirmed.status).toBe(200);
  const got = await poll(app, started.deviceCode);
  if (got.body.status !== 'paired') throw new Error(`not paired: ${got.body.status}`);
  return got.body;
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─── 1. Pairing ──────────────────────────────────────────────────────────────

describe('a device pairs from its own side (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('asks for a code, waits, is confirmed, and collects its key ONCE; only hashes are kept', async () => {
    const app = createApp(makeDeps(), testEnv);
    const started = await pair(app, { name: '  Desk companion  ' });
    expect(started.userCode).toMatch(/^[0-9]{6}$/);

    // The request as the owner sees it, from any workspace: the name it gave,
    // its code, where it came from.
    const listed = await call(app, 'GET', `/api/device-pairings?entityId=${x.entityId}`);
    expect(listed.json['pairings']).toEqual([
      expect.objectContaining({
        pairingId: started.pairingId,
        name: 'Desk companion',
        capabilities: ['microphone', 'speaker'],
        userCode: started.userCode,
        from: '192.168.1.40',
        state: 'pending',
      }),
    ]);
    const [row] = await db
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.id, started.pairingId));
    expect(row!.deviceCodeHash).toBe(hashDeviceSecret(started.deviceCode));
    expect(JSON.stringify(row)).not.toContain(started.deviceCode);

    expect(await poll(app, started.deviceCode)).toEqual({
      status: 202,
      body: { status: 'pending' },
    });

    const confirmed = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
      body: { entityId: x.entityId },
    });
    expect(confirmed.status).toBe(200);

    await letPollAgain(started.pairingId);
    const got = await poll(app, started.deviceCode);
    expect(got.status).toBe(200);
    if (got.body.status !== 'paired') throw new Error('not paired');
    expect(got.body.token).toMatch(DEVICE_TOKEN_RE);
    expect(got.body).toMatchObject({
      deviceId: confirmed.json['deviceId'],
      conversationId: confirmed.json['conversationId'],
    });

    // The device, in workspace X, with only the hash of its key.
    const [device] = await db.select().from(devices).where(eq(devices.id, got.body.deviceId));
    expect(device).toMatchObject({
      entityId: x.entityId,
      name: 'Desk companion',
      capabilities: ['microphone', 'speaker'],
      pairedFrom: '192.168.1.40',
      tokenHash: hashDeviceSecret(got.body.token),
      revokedAt: null,
    });
    // Its conversation, with X's root, on its thread — the #945 path.
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, got.body.conversationId));
    expect(conv).toMatchObject({
      entityId: x.entityId,
      agentId: x.agentId,
      channel: 'device',
      chatId: got.body.deviceId,
    });

    // ONCE: a later poll gets nothing.
    await letPollAgain(started.pairingId);
    expect(await poll(app, started.deviceCode)).toEqual({
      status: 410,
      body: { status: 'expired' },
    });
    // The request no longer waits on any Devices page.
    const after = await call(app, 'GET', `/api/device-pairings?entityId=${y.entityId}`);
    expect(after.json['pairings']).toEqual([]);
  });

  it('a wrong code is refused, and so is an expired one; an expired request cannot be confirmed', async () => {
    const app = createApp(makeDeps(), testEnv);
    expect(await poll(app, 'not-a-code-anyone-was-given')).toEqual({
      status: 410,
      body: { status: 'expired' },
    });
    const started = await pair(app);
    await db
      .update(devicePairings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(devicePairings.id, started.pairingId));
    expect(await poll(app, started.deviceCode)).toEqual({
      status: 410,
      body: { status: 'expired' },
    });
    const late = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
      body: { entityId: x.entityId },
    });
    expect(late).toEqual({ status: 404, json: { error: 'pairing_not_pending' } });
    // Listed as expired, until dismissed.
    const listed = await call(app, 'GET', `/api/device-pairings?entityId=${x.entityId}`);
    expect(listed.json['pairings']).toEqual([
      expect.objectContaining({ pairingId: started.pairingId, state: 'expired' }),
    ]);
    const dismissed = await call(
      app,
      'DELETE',
      `/api/device-pairings/${started.pairingId}?entityId=${x.entityId}`,
    );
    expect(dismissed).toEqual({ status: 200, json: { dismissed: true } });
    expect((await call(app, 'GET', `/api/device-pairings?entityId=${x.entityId}`)).json).toEqual({
      pairings: [],
    });
  });

  it('polling faster than the interval is slow_down, and does not reset the clock', async () => {
    const app = createApp(makeDeps(), testEnv);
    const started = await pair(app);
    expect((await poll(app, started.deviceCode)).status).toBe(202);
    expect(await poll(app, started.deviceCode)).toEqual({
      status: 429,
      body: { status: 'slow_down' },
    });
    const [row] = await db
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.id, started.pairingId));
    await letPollAgain(started.pairingId);
    expect((await poll(app, started.deviceCode)).status).toBe(202);
    expect(row!.lastPolledAt).toBeInstanceOf(Date);
  });

  it('a refused request never yields a key, and creates no device', async () => {
    const app = createApp(makeDeps(), testEnv);
    const before = (await db.select().from(devices)).length;
    const started = await pair(app);
    const refused = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/refuse`, {
      body: { entityId: x.entityId },
    });
    expect(refused).toEqual({ status: 200, json: { refused: true } });
    for (let i = 0; i < 2; i++) {
      await letPollAgain(started.pairingId);
      expect(await poll(app, started.deviceCode)).toEqual({
        status: 403,
        body: { status: 'refused' },
      });
    }
    // Refused, it cannot be confirmed afterwards either.
    const late = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
      body: { entityId: x.entityId },
    });
    expect(late.status).toBe(404);
    expect((await db.select().from(devices)).length).toBe(before);
  });

  it('two polls racing for a confirmed request: exactly one collects the key', async () => {
    const app = createApp(makeDeps(), testEnv);
    const started = await pair(app);
    await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
      body: { entityId: x.entityId },
    });
    const both = await Promise.all([poll(app, started.deviceCode), poll(app, started.deviceCode)]);
    expect(both.filter((p) => p.body.status === 'paired')).toHaveLength(1);
  });

  it('the name is kept as the text it is, markup included, and never longer than 60', async () => {
    const app = createApp(makeDeps(), testEnv);
    const name = '<img src=x onerror=alert(1)>';
    const started = await pair(app, { name });
    const listed = await call(app, 'GET', `/api/device-pairings?entityId=${x.entityId}`);
    expect((listed.json['pairings'] as Array<{ name: string }>)[0]!.name).toBe(name);
    const tooLong = await call(app, 'POST', '/api/devices/pair', {
      body: { name: 'x'.repeat(61), capabilities: [], protocolVersion: 1 },
    });
    expect(tooLong.status).toBe(400);
    expect(started.pairingId).toBeTruthy();
  });
});

// ─── 2. Keys ─────────────────────────────────────────────────────────────────

describe('a device key reaches its own routes and conversations, and nothing else (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('its own stream and conversation; never another device, another conversation, or a non-device route', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const b = await pairedDevice(app, x, '192.168.1.41');

    // Its own routes.
    const conv = await call(app, 'POST', `/api/devices/${a.deviceId}/conversation`, {
      headers: key(a.token),
    });
    expect(conv).toEqual({
      status: 200,
      json: { entityId: x.entityId, agentId: x.agentId, conversationId: a.conversationId },
    });
    // Another device's routes answer as if it did not exist.
    expect(
      await call(app, 'POST', `/api/devices/${b.deviceId}/conversation`, { headers: key(a.token) }),
    ).toEqual({ status: 404, json: { error: 'device_not_found' } });

    // The dashboard's routes it speaks through: its conversation, never another.
    const stopOwn = await call(app, 'POST', '/api/chat/stop', {
      headers: key(a.token),
      body: { entityId: x.entityId, conversationId: a.conversationId },
    });
    expect(stopOwn).toEqual({ status: 200, json: { stopped: false } });
    const stopB = await call(app, 'POST', '/api/chat/stop', {
      headers: key(a.token),
      body: { entityId: x.entityId, conversationId: b.conversationId },
    });
    expect(stopB).toEqual({ status: 404, json: { error: 'conversation_not_found' } });
    // A dashboard conversation of the SAME workspace is not its own either.
    const [dash] = await db
      .insert(conversations)
      .values({ entityId: x.entityId, agentId: x.agentId, channel: 'dashboard' })
      .returning({ id: conversations.id });
    for (const [path, body] of [
      ['/api/chat/stop', { entityId: x.entityId, conversationId: dash!.id }],
      [
        '/api/chat/stream',
        { entityId: x.entityId, agentId: x.agentId, conversationId: dash!.id, message: 'hi' },
      ],
      ['/api/voice/turns', { entityId: x.entityId, conversationId: dash!.id, format: 'audio/wav' }],
    ] as const) {
      expect(await call(app, 'POST', path, { headers: key(a.token), body })).toEqual({
        status: 404,
        json: { error: 'conversation_not_found' },
      });
    }

    // Every route outside the device protocol refuses the key, in local
    // trust too, where the same request without it would pass.
    for (const [method, path] of [
      ['GET', `/api/events?entityId=${x.entityId}`],
      ['POST', '/api/agent'],
      ['GET', `/api/voice/setting?entityId=${x.entityId}`],
      ['GET', `/api/workspace-devices?entityId=${x.entityId}`],
      ['GET', `/api/device-pairings?entityId=${x.entityId}`],
      ['DELETE', `/api/workspace-devices/${a.deviceId}?entityId=${x.entityId}`],
      ['POST', '/api/devices/pair'],
    ] as const) {
      expect(await call(app, method, path, { headers: key(a.token) })).toEqual({
        status: 403,
        json: { error: 'device_token_not_accepted' },
      });
    }
    // The owner's route, without the key, does answer: the refusal is the key.
    expect((await call(app, 'GET', `/api/workspace-devices?entityId=${x.entityId}`)).status).toBe(
      200,
    );
    // A forged key is refused, not ignored.
    expect(
      await call(app, 'POST', '/api/chat/stop', {
        headers: key(`ndv_${'A'.repeat(43)}`),
        body: { entityId: x.entityId, conversationId: a.conversationId },
      }),
    ).toEqual({ status: 401, json: { error: 'device_token_invalid' } });
  });

  it('the worker secret, a session and local trust are refused on a device’s routes', async () => {
    const app = createApp(
      makeDeps({
        getSession: async (req: Request) =>
          req.headers.get('authorization') === 'Bearer session-of-x'
            ? { userId: x.userId, entityId: x.entityId }
            : null,
      }),
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
    );
    const local = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(local, x);
    for (const [target, headers] of [
      [app, SECRET],
      [app, { Authorization: 'Bearer session-of-x' }],
      [app, {}],
      [local, {}],
      [local, SECRET],
    ] as const) {
      expect(
        await call(target, 'POST', `/api/devices/${a.deviceId}/conversation`, { headers }),
      ).toEqual({ status: 401, json: { error: 'device_token_required' } });
    }
    // Its own key opens it, in both modes.
    expect(
      (
        await call(app, 'POST', `/api/devices/${a.deviceId}/conversation`, {
          headers: key(a.token),
        })
      ).status,
    ).toBe(200);
  });

  it('a device answers a card put on IT, as itself; a card it was not given is not found', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const card = async (onDevice: string | null) => {
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: x.entityId,
          agentId: x.agentId,
          channel: 'device',
          chatId: a.deviceId,
          chatChannel: 'device',
          task: 'pairing test',
          status: 'awaiting_approval',
          messages: [],
          chainCount: 0,
        })
        .returning({ id: agentJobs.id });
      const [request] = await db
        .insert(approvalRequests)
        .values({
          entityId: x.entityId,
          jobId: job!.id,
          agentId: x.agentId,
          toolName: 'run_command',
          toolInput: { command: 'ls' },
          kind: 'approval',
        })
        .returning({ id: approvalRequests.id });
      if (onDevice) {
        await db.insert(approvalCardMessages).values({
          approvalRequestId: request!.id,
          channel: 'device',
          agentId: x.agentId,
          conversationId: onDevice,
          messageId: `card-${request!.id}`,
        });
      }
      return request!.id;
    };
    const mine = await card(a.deviceId);
    const notMine = await card(null);

    // No responderUserId: the key says who answered.
    const answered = await call(app, 'POST', '/api/approve', {
      headers: key(a.token),
      body: { approvalRequestId: mine, decision: 'approve' },
    });
    expect(answered.status).toBe(200);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, mine));
    expect(row!.status).toBe('approved');

    const refused = await call(app, 'POST', '/api/approve', {
      headers: key(a.token),
      body: { approvalRequestId: notMine, decision: 'approve' },
    });
    expect(refused).toEqual({ status: 404, json: { error: 'approval_not_found' } });
    const [still] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, notMine));
    expect(still!.status).toBe('pending');
  });
});

describe('a device continues only ITS voice turns, and hears only ITS announcements (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('a turn opened by device A: B cannot send it a chunk nor cancel it; A can', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const b = await pairedDevice(app, x, '192.168.1.41');
    const opened = openUtterance({
      entityId: x.entityId,
      conversationId: a.conversationId,
      agentId: x.agentId,
      deviceId: a.deviceId,
      format: { kind: 'audio/wav' },
    });
    if (!opened.ok) throw new Error('turn not opened');
    const chunk = async (token: string) => {
      const res = await app.fetch(
        new Request(`http://127.0.0.1/api/voice/turns/${opened.id}/chunks/0`, {
          method: 'POST',
          headers: { ...key(token), 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array([1, 2, 3, 4]),
        }),
        { incoming: { socket: { remoteAddress: '192.168.1.40' } } },
      );
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect(await chunk(b.token)).toEqual({ status: 404, json: { error: 'turn_not_found' } });
    expect(
      await call(app, 'DELETE', `/api/voice/turns/${opened.id}`, { headers: key(b.token) }),
    ).toEqual({ status: 404, json: { error: 'turn_not_found' } });
    expect(await chunk(a.token)).toEqual({ status: 200, json: { received: 4 } });
    expect(
      await call(app, 'DELETE', `/api/voice/turns/${opened.id}`, { headers: key(a.token) }),
    ).toEqual({ status: 200, json: { cancelled: true } });
  });

  it('the announcement of a job of A’s conversation: A hears it, B is told it does not exist', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const b = await pairedDevice(app, x, '192.168.1.41');
    const ctl = new AbortController();
    opened.push(ctl);
    const stream = await app.fetch(
      new Request(`http://127.0.0.1/api/devices/${a.deviceId}/events`, {
        headers: key(a.token),
        signal: ctl.signal,
      }),
    );
    const reader = readSse(stream);
    await waitFor(() => reader.events.some((e) => e.event === 'ready'));
    const audioId = speakFinishedJob(db as RunnerDeps['db'], {
      jobId: '00000000-0000-4000-8000-000000000946',
      entityId: x.entityId,
      conversationId: a.conversationId,
      parentJobId: null,
      status: 'completed',
      result: 'Done.',
      replyRendering: 'spoken',
      deviceId: a.deviceId,
    });
    expect(audioId).not.toBeNull();
    const hear = async (token: string) => {
      const c = new AbortController();
      opened.push(c);
      const res = await app.fetch(
        new Request(`http://127.0.0.1/api/voice/replies/${audioId}?entityId=${x.entityId}`, {
          headers: key(token),
          signal: c.signal,
        }),
      );
      return res.status === 200 ? { status: 200 } : { status: res.status, json: await res.json() };
    };
    expect(await hear(b.token)).toEqual({
      status: 404,
      json: { error: 'reply_audio_not_found' },
    });
    expect(await hear(a.token)).toEqual({ status: 200 });
  });
});

// ─── 3. Removing a device ────────────────────────────────────────────────────

describe('a removed device is cut at once (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('its open stream closes now, its key is refused on the next request, cards stop reaching it', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const ctl = new AbortController();
    opened.push(ctl);
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/devices/${a.deviceId}/events`, {
        headers: key(a.token),
        signal: ctl.signal,
      }),
    );
    expect(res.status).toBe(200);
    const reader = readSse(res);
    await waitFor(() => reader.events.some((e) => e.event === 'ready'));
    expect(isDeviceConnected(a.deviceId)).toBe(true);
    const listed = await call(app, 'GET', `/api/workspace-devices?entityId=${x.entityId}`);
    expect(listed.json['devices']).toContainEqual(
      expect.objectContaining({ deviceId: a.deviceId, connected: true }),
    );
    expect(
      await isConversationAllowed(db as RunnerDeps['db'], {
        entityId: x.entityId,
        agentId: x.agentId,
        channel: 'device',
        conversationId: a.deviceId,
      }),
    ).toBe(true);

    const removed = await call(
      app,
      'DELETE',
      `/api/workspace-devices/${a.deviceId}?entityId=${x.entityId}`,
    );
    expect(removed).toEqual({ status: 200, json: { removed: true } });

    // The stream ends by itself: nobody aborted it.
    let ended = false;
    void reader.done.then(() => {
      ended = true;
    });
    await waitFor(() => ended);
    expect(ctl.signal.aborted).toBe(false);
    expect(isDeviceConnected(a.deviceId)).toBe(false);

    expect(
      await call(app, 'POST', `/api/devices/${a.deviceId}/conversation`, { headers: key(a.token) }),
    ).toEqual({ status: 401, json: { error: 'device_token_invalid' } });
    expect(
      await isConversationAllowed(db as RunnerDeps['db'], {
        entityId: x.entityId,
        agentId: x.agentId,
        channel: 'device',
        conversationId: a.deviceId,
      }),
    ).toBe(false);
    // Gone from the list; its row stays, for its past conversation's name.
    const after = await call(app, 'GET', `/api/workspace-devices?entityId=${x.entityId}`);
    expect(
      (after.json['devices'] as Array<{ deviceId: string }>).map((d) => d.deviceId),
    ).not.toContain(a.deviceId);
    const [row] = await db.select().from(devices).where(eq(devices.id, a.deviceId));
    expect(row).toMatchObject({ tokenHash: null });
    expect(row!.revokedAt).toBeInstanceOf(Date);
  });

  it('rename keeps the key; the name is the owner’s, trimmed', async () => {
    const app = createApp(makeDeps(), testEnv);
    const a = await pairedDevice(app, x);
    const renamed = await call(app, 'PATCH', `/api/workspace-devices/${a.deviceId}`, {
      body: { entityId: x.entityId, name: '  Kitchen speaker ' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json['device']).toMatchObject({ deviceId: a.deviceId, name: 'Kitchen speaker' });
    expect(
      (
        await call(app, 'POST', `/api/devices/${a.deviceId}/conversation`, {
          headers: key(a.token),
        })
      ).status,
    ).toBe(200);
  });
});

// ─── 4. Abuse limits ─────────────────────────────────────────────────────────

describe('the pairing route has limits (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('per address per minute, then in total; another address is not held by the first', async () => {
    const app = createApp(makeDeps(), testEnv);
    const perAddress = DEVICE_PAIRING_LIMITS.perAddressPerMinute;
    for (let i = 0; i < perAddress; i++) await pair(app, { from: '10.0.0.1' });
    const over = await call(app, 'POST', '/api/devices/pair', {
      body: { name: 'One more', capabilities: [], protocolVersion: 1 },
      from: '10.0.0.1',
    });
    expect(over).toEqual({ status: 429, json: { error: 'rate_limited', reason: 'per_address' } });
    await pair(app, { from: '10.0.0.2' });

    // The total cap: fill it from many addresses.
    const waiting = perAddress + 1;
    for (let i = waiting; i < DEVICE_PAIRING_LIMITS.maxPending; i++) {
      await pair(app, { from: `10.0.1.${i}` });
    }
    const full = await call(app, 'POST', '/api/devices/pair', {
      body: { name: 'Too many', capabilities: [], protocolVersion: 1 },
      from: '10.0.2.1',
    });
    expect(full).toEqual({ status: 429, json: { error: 'rate_limited', reason: 'pending_cap' } });
    const live = await db.select().from(devicePairings);
    expect(live).toHaveLength(DEVICE_PAIRING_LIMITS.maxPending);
    // Two requests waiting never show the same code.
    expect(new Set(live.map((p) => p.userCode)).size).toBe(live.length);
  });

  it('a request that expired long ago is purged', async () => {
    const app = createApp(makeDeps(), testEnv);
    const old = await pair(app, { from: '10.0.3.1' });
    await db
      .update(devicePairings)
      .set({ expiresAt: new Date(Date.now() - DEVICE_PAIRING_LIMITS.keepExpiredMs - 1_000) })
      .where(eq(devicePairings.id, old.pairingId));
    await pair(app, { from: '10.0.3.2' });
    const left = await db.select().from(devicePairings).where(eq(devicePairings.id, old.pairingId));
    expect(left).toEqual([]);
  });
});

// ─── 5. Isolation ────────────────────────────────────────────────────────────

describe('a pairing confirmed in workspace X gives nothing in workspace Y (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('the key reaches no conversation of Y; Y’s owner neither lists nor removes the device', async () => {
    const app = createApp(
      makeDeps({
        getSession: async (req: Request) => {
          const auth = req.headers.get('authorization');
          if (auth === 'Bearer session-of-x') return { userId: x.userId, entityId: x.entityId };
          if (auth === 'Bearer session-of-y') return { userId: y.userId, entityId: y.entityId };
          return null;
        },
      }),
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
    );
    const asX = { Authorization: 'Bearer session-of-x' };
    const asY = { Authorization: 'Bearer session-of-y' };
    const started = await pair(app);
    const confirmed = await call(app, 'POST', `/api/device-pairings/${started.pairingId}/confirm`, {
      headers: asX,
      body: { entityId: x.entityId },
    });
    expect(confirmed.status).toBe(200);
    const got = await poll(app, started.deviceCode);
    if (got.body.status !== 'paired') throw new Error('not paired');
    const { token } = got.body;

    const [convOfY] = await db
      .insert(conversations)
      .values({ entityId: y.entityId, agentId: y.agentId, channel: 'dashboard' })
      .returning({ id: conversations.id });
    expect(
      await call(app, 'POST', '/api/chat/stop', {
        headers: key(token),
        body: { entityId: y.entityId, conversationId: convOfY!.id },
      }),
    ).toEqual({ status: 403, json: { error: 'forbidden' } });

    // Y's owner: X's device is not in Y's list, cannot be removed from Y, nor
    // by naming X.
    const listY = await call(app, 'GET', `/api/workspace-devices?entityId=${y.entityId}`, {
      headers: asY,
    });
    expect(listY).toEqual({ status: 200, json: { devices: [] } });
    expect(
      (
        await call(
          app,
          'DELETE',
          `/api/workspace-devices/${got.body.deviceId}?entityId=${y.entityId}`,
          {
            headers: asY,
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          app,
          'DELETE',
          `/api/workspace-devices/${got.body.deviceId}?entityId=${x.entityId}`,
          {
            headers: asY,
          },
        )
      ).status,
    ).toBe(403);
    // Still X's, and still working.
    expect(
      (
        await call(app, 'POST', `/api/devices/${got.body.deviceId}/conversation`, {
          headers: key(token),
        })
      ).json,
    ).toMatchObject({ entityId: x.entityId });
  });
});

// ─── The contract is what the runner serves ──────────────────────────────────

describe('every pairing and owner route of the protocol is served (#946) @cap:parler-par-canal-externe/moteur', () => {
  it('DEVICE_PAIRING_GESTURES and DEVICE_OWNER_ROUTES name only routes the app serves', () => {
    const app = createApp(makeDeps(), testEnv);
    const served = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    const named = [
      ...Object.values(DEVICE_PAIRING_GESTURES).flatMap((routes) =>
        routes.map((r) => `${r.method} ${r.path}`),
      ),
      ...Object.values(DEVICE_OWNER_ROUTES).map((r) => `${r.method} ${r.path}`),
    ];
    expect(named.length).toBe(9);
    expect(named.filter((r) => !served.has(r))).toEqual([]);
  });
});
