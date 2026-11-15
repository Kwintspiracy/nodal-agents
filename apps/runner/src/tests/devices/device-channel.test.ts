// device-channel.test.ts — a device is a channel of Nodal (#945), on the REAL runner.
//
// The real app (`createApp`): the device routes, the device sink it binds, the
// push stream, the real gates (`executeJob` with `ask_user`, `/api/approve`,
// the approval notifier, `publishJobEnded`, the spoken announcement), the real
// database. Only the model is simulated, and the network is a stub that keeps
// what would have gone to Telegram — the owner's DEFAULT channel here, so that
// "the card did not go there" means something.
//
// What is proven, by the events each stream received and the rows in base:
//   1. a device gets its conversation with the workspace's root; the guard
//      lets a session act only as a device of ITS workspace;
//   2. a question asked during a job launched from device A reaches device A's
//      stream as a card, and neither device B, nor the owner's Telegram; the
//      dashboard sees the request, never the card; the rows carry the origin;
//      answered through `/api/approve`, the card is closed on device A;
//   3. an approval (a gated action) of such a job reaches device A as a card
//      with the agent's purpose quoted, approve and reject as choices;
//   4. the end of a job launched by voice from device A: its reply, its state
//      and its spoken announcement on device A's stream; with only device B
//      listening, nothing is said;
//   5. isolation: a job of workspace Y whose chat names device A (of X)
//      reaches nothing on device A; the sink refuses it.
//
// The contrast case (the same question from a job made elsewhere, with the
// owner's chat, goes to the owner's Telegram) proves the setup HAS a default
// channel: without the device's own target, a device job's question went
// there too (the walk found the bot, then swapped in the owner's chat).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, inArray, sql } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  jobDeliverableVerificationState,
  approvalCardMessages,
  approvalRequestAttachments,
  approvalRequests,
  conversations,
  devices,
  entities,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { UserInputRequest, UserInputResponse } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { deviceAdapter, DeliveryError } from '@nodal-agents/delivery';
import { DEVICE_GESTURES, DeviceEventSchema } from '@nodal-agents/shared';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { createApp } from '../../server.ts';
import { executeJob } from '../../job/execute.ts';
import { notifyApprovalCreated } from '../../approvals/notify.ts';
import { createRequestUserInput } from '../../approvals/elicitation.ts';
import { publishApprovalRequested, publishJobEnded } from '../../events/publish.ts';
import { speakFinishedJob } from '../../chat/job-reply-voice.ts';
import { jobEvents } from '../../events/job-events.ts';
import { readSse, type SseEvent } from '../chat/_sse-reader.ts';
import { drawDeviceToken } from '../../devices/device-secrets.ts';
// @ts-expect-error — a plain .mjs build script, no declarations
import { buildClient } from '../../../../../packages/device-client/scripts/build.mjs';

vi.setConfig({ testTimeout: 30_000 });

// ─── The model (the harness of job-events-flow.test.ts) ──────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('device-channel.test: no active LLM client');
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

// ─── The network: what reaches Telegram is KEPT, nothing else leaves ─────────

const telegramSends: Array<{ chatId: string; text: string }> = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.telegram.org/')) {
      const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
        chat_id?: string;
        text?: string;
      };
      if (url.endsWith('/sendMessage')) {
        telegramSends.push({ chatId: String(body.chat_id), text: String(body.text) });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`device-channel.test: no network for ${url}`);
  }),
);

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

// ─── Two workspaces, three devices ───────────────────────────────────────────

const OWNER_CHAT = '424242';

let db: TestDb;
let x: Awaited<ReturnType<typeof seedMinimal>>;
let y: Awaited<ReturnType<typeof seedMinimal>>;
let deviceA = '';
let deviceB = '';
let deviceOfY = '';
/** Each device's key (#946): what it presents on its routes. */
const keyOf = new Map<string, string>();
const as = (id: string): Record<string, string> => ({ Authorization: `Bearer ${keyOf.get(id)}` });

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  x = await seedMinimal(db);
  y = await seedMinimal(db);
  for (const s of [x, y]) {
    await db.update(entities).set({ rootAgentId: s.agentId }).where(eq(entities.id, s.entityId));
  }
  // The owner's DEFAULT channel: X's root has a Telegram bot and an owner chat.
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, x.agentId));
  await db.insert(telegramAllowedChats).values({
    entityId: x.entityId,
    agentId: x.agentId,
    chatId: OWNER_CHAT,
    role: 'owner',
    status: 'active',
  });
  const rows = await db
    .insert(devices)
    .values([
      { entityId: x.entityId, name: 'Desk', capabilities: ['microphone', 'speaker', 'screen'] },
      { entityId: x.entityId, name: 'Kitchen', capabilities: ['speaker'] },
      { entityId: y.entityId, name: 'Elsewhere', capabilities: [] },
    ])
    .returning({ id: devices.id });
  [deviceA, deviceB, deviceOfY] = rows.map((r) => r.id) as [string, string, string];
  for (const id of [deviceA, deviceB, deviceOfY]) {
    const { token, tokenHash } = drawDeviceToken();
    await db.update(devices).set({ tokenHash }).where(eq(devices.id, id));
    keyOf.set(id, token);
  }
});

function makeDeps(
  llmClient: RunnerDeps['llmClient'] = makeMockLlmClient([{ text: 'unused' }]),
  authProvider: RunnerDeps['authProvider'] = new LocalTrustProvider(),
): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider,
    close: async () => {},
  };
}

// ─── The streams ─────────────────────────────────────────────────────────────

/**
 * Every stream a test opens, with the promise of its end. The teardown below
 * closes each one and AWAITS that end (the server's `stop` closes the body, so
 * the reader's `done` settles only once the subscriber is gone from the bus).
 * No test then depends on when the streams of the tests before it close.
 */
const opened: { ctl: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  const streams = opened.splice(0);
  for (const { ctl } of streams) ctl.abort();
  await Promise.all(streams.map((s) => s.done));
  telegramSends.length = 0;
});

interface Listener {
  status: number;
  events: SseEvent[];
  /** What is not the stream's own `ready` / `resync`. */
  gestures: () => SseEvent[];
}

async function listenTo(
  app: ReturnType<typeof createApp>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Listener> {
  const ctl = new AbortController();
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { headers, signal: ctl.signal }),
  );
  if (res.status !== 200) return { status: res.status, events: [], gestures: () => [] };
  const reader = readSse(res);
  opened.push({ ctl, done: reader.done });
  await waitFor(() => reader.events.length > 0);
  return {
    status: 200,
    events: reader.events,
    gestures: () => reader.events.filter((e) => e.event !== 'ready' && e.event !== 'resync'),
  };
}

const device = (app: ReturnType<typeof createApp>, id: string) =>
  listenTo(app, `/api/devices/${id}/events`, as(id));

/**
 * A gesture as the protocol parses it, the `seq` of a `state` set aside: the
 * order is proven on its own (`seqsOf`), the content compared here.
 */
function withoutSeq(data: unknown): unknown {
  const ev = DeviceEventSchema.parse(data);
  if (ev.type !== 'state') return ev;
  const { seq: _seq, ...rest } = ev;
  return rest;
}

/** The `state` gestures a device received, checked against the protocol. */
const statesOf = (l: Listener) =>
  l
    .gestures()
    .filter((e) => e.event === 'state')
    .map((e) => withoutSeq(e.data) as Record<string, unknown>);

/** The `seq` of each `state`, in arrival order: it must only grow. */
const seqsOf = (l: Listener) =>
  l
    .gestures()
    .filter((e) => e.event === 'state')
    .map((e) => (e.data as { seq: number }).seq);

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** `GET /api/devices/:id/cards`, as the device reads it. */
async function getCards(
  app: ReturnType<typeof createApp>,
  id: string,
  headers: Record<string, string> = as(id),
): Promise<{ status: number; cards: unknown[] }> {
  const res = await app.fetch(new Request(`http://localhost/api/devices/${id}/cards`, { headers }));
  if (res.status !== 200) return { status: res.status, cards: [] };
  const body = (await res.json()) as { cards: unknown[] };
  return { status: 200, cards: body.cards };
}

/** Long enough for an event that should not come to arrive. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

async function postConversation(
  app: ReturnType<typeof createApp>,
  id: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = as(id),
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request(`http://localhost/api/devices/${id}/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A job of a device's conversation, as a chat turn would launch it. */
async function deviceJob(opts: {
  entityId: string;
  agentId: string;
  deviceId: string;
  conversationId: string | null;
  status?: string;
  replyRendering?: 'text' | 'spoken';
  result?: string;
}): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: opts.entityId,
      agentId: opts.agentId,
      channel: 'device',
      chatId: opts.deviceId,
      chatChannel: 'device',
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      task: 'device test',
      status: opts.status ?? 'pending',
      messages: [],
      chainCount: 0,
      replyRendering: opts.replyRendering ?? 'text',
      ...(opts.result !== undefined ? { result: opts.result } : {}),
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

const QUESTION = 'Which printer tray should I use?';
const OPTIONS = ['Tray 1', 'Tray 2'];

function askUser(): RunnerDeps['llmClient'] {
  return makeMockLlmClient([
    {
      toolCalls: [
        {
          toolCallId: 'tc-ask',
          toolName: 'ask_user',
          args: { question: QUESTION, options: OPTIONS },
        },
      ],
    },
  ]);
}

const cardsOf = (requestId: string) =>
  db
    .select({
      channel: approvalCardMessages.channel,
      conversationId: approvalCardMessages.conversationId,
    })
    .from(approvalCardMessages)
    .where(eq(approvalCardMessages.approvalRequestId, requestId));

// ─── 1. The device's conversation, and its guard ─────────────────────────────

describe('a device gets its conversation with the root (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('the conversation is the device’s thread: channel device, its id, the root agent; fresh opens a new one', async () => {
    const app = createApp(makeDeps(), testEnv);
    const first = await postConversation(app, deviceA);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ entityId: x.entityId, agentId: x.agentId });
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, String(first.json['conversationId'])));
    expect(row).toMatchObject({
      entityId: x.entityId,
      agentId: x.agentId,
      channel: 'device',
      chatId: deviceA,
    });
    // The same thread until the device asks for a new one.
    const again = await postConversation(app, deviceA);
    expect(again.json['conversationId']).toBe(first.json['conversationId']);
    const fresh = await postConversation(app, deviceA, { fresh: true });
    expect(fresh.json['conversationId']).not.toBe(first.json['conversationId']);
    // Seen: the guard stamped it.
    const [seen] = await db.select().from(devices).where(eq(devices.id, deviceA));
    expect(seen!.lastSeenAt).toBeInstanceOf(Date);
  });

  it('a device acts only as ITSELF, with its own key; the worker secret and a session are refused (#946)', async () => {
    const app = createApp(
      makeDeps(undefined, {
        getSession: async (req: Request) =>
          req.headers.get('authorization') === 'Bearer session-of-x'
            ? { userId: x.userId, entityId: x.entityId }
            : null,
      }),
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
    );
    const asX = { Authorization: 'Bearer session-of-x' };
    const secret = { Authorization: `Bearer ${testEnv.WORKER_SECRET}` };
    expect((await listenTo(app, `/api/devices/${deviceA}/events`)).status).toBe(401);
    expect((await listenTo(app, `/api/devices/${deviceA}/events`, asX)).status).toBe(401);
    expect((await listenTo(app, `/api/devices/${deviceA}/events`, secret)).status).toBe(401);
    expect((await listenTo(app, `/api/devices/${deviceA}/events`, as(deviceA))).status).toBe(200);
    // Device A's key on another device: B of its workspace, the device of Y.
    expect((await listenTo(app, `/api/devices/${deviceB}/events`, as(deviceA))).status).toBe(404);
    expect((await listenTo(app, `/api/devices/${deviceOfY}/events`, as(deviceA))).status).toBe(404);
    expect((await postConversation(app, deviceOfY, {}, as(deviceA))).status).toBe(404);
    expect((await postConversation(app, deviceOfY, {}, secret)).status).toBe(401);
    expect((await getCards(app, deviceOfY, as(deviceA))).status).toBe(404);
    expect((await getCards(app, deviceB, as(deviceA))).status).toBe(404);
    expect((await getCards(app, deviceA, as(deviceA))).status).toBe(200);
    expect((await getCards(app, deviceA, secret)).status).toBe(401);
    expect((await getCards(app, deviceA, asX)).status).toBe(401);
    expect((await listenTo(app, `/api/devices/not-a-device/events`, as(deviceA))).status).toBe(404);
  });
});

// ─── 2 & 3. Questions and approvals go back to the device that asked ─────────

describe('what a job launched from a device asks comes back to THAT device (#945) @cap:approuver-une-action/moteur', () => {
  it('a question reaches device A’s stream as a card — not device B, not the owner’s Telegram — and closes there when answered', async () => {
    const deps = makeDeps(askUser());
    const app = createApp(deps, testEnv);
    const conv = String((await postConversation(app, deviceA)).json['conversationId']);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: conv,
    });

    const onA = await device(app, deviceA);
    const onB = await device(app, deviceB);
    const dashboard = await listenTo(app, `/api/events?entityId=${x.entityId}`);

    const suspended = await executeJob(job as JobId, deps, testEnv);
    expect(suspended.status).toBe('awaiting_approval');
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job), eq(approvalRequests.kind, 'question')));

    await waitFor(() => onA.gestures().some((e) => e.event === 'card'));
    await settle();
    expect(onA.gestures().filter((e) => e.event === 'card')).toHaveLength(1);
    const card = onA.gestures().find((e) => e.event === 'card')!;
    expect(DeviceEventSchema.parse(card.data)).toMatchObject({
      type: 'card',
      cardId: request!.id,
      kind: 'question',
      choices: [
        { label: 'Tray 1', decision: 'approve', answer: 'Tray 1' },
        { label: 'Tray 2', decision: 'approve', answer: 'Tray 2' },
      ],
    });
    // The agent's question, quoted in the platform's frame.
    expect((card.data as { text: string }).text).toContain(`« ${QUESTION} »`);
    // Followed without polling: the run's state, pushed — working when the
    // job was claimed, waiting on THIS card once the question was asked.
    expect(statesOf(onA)).toEqual([
      {
        type: 'state',
        jobId: job,
        conversationId: conv,
        state: 'working',
        waitingFor: [],
        deliverables: [],
      },
      {
        type: 'state',
        jobId: job,
        conversationId: conv,
        state: 'waiting',
        waitingFor: [request!.id],
        deliverables: [],
      },
    ]);
    // Nobody else hears it as a card.
    expect(onB.gestures()).toEqual([]);
    expect(telegramSends).toEqual([]);
    // The dashboard sees the request (its Approvals page answers it), never the card.
    expect(dashboard.gestures().map((e) => e.event)).toEqual(['question.asked']);
    // The rows say where it was asked, and where the card went.
    const [jobRow] = await db.select().from(agentJobs).where(eq(agentJobs.id, job));
    expect(jobRow).toMatchObject({ channel: 'device', chatId: deviceA, chatChannel: 'device' });
    expect(await cardsOf(request!.id)).toEqual([{ channel: 'device', conversationId: deviceA }]);

    // ── Answered as the dashboard answers: the card closes on device A ───────
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job));
    const answered = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: request!.id,
          decision: 'approve',
          answer: OPTIONS[1],
          responderUserId: x.userId,
        }),
      }),
    );
    expect(answered.status).toBe(200);
    await waitFor(() => onA.gestures().some((e) => e.event === 'card.closed'));
    expect(onA.gestures().find((e) => e.event === 'card.closed')!.data).toEqual({
      type: 'card.closed',
      cardId: request!.id,
      text: `✅ Answered: ${OPTIONS[1]}`,
    });
    // Answered: the run works again — re-queued, nothing waits.
    await waitFor(() => statesOf(onA).length >= 3);
    expect(statesOf(onA)[2]).toMatchObject({ state: 'working', waitingFor: [] });
    const seqs = seqsOf(onA);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    await settle();
    expect(onB.gestures()).toEqual([]);
    expect(telegramSends).toEqual([]);
  });

  it('contrast: the same question from a job made elsewhere, with the owner’s chat, goes to the owner’s Telegram', async () => {
    // A request made nowhere (an API call) that designated the owner's
    // Telegram chat: the default channel IS live in this workspace, so the
    // device case above is not green by absence.
    createApp(makeDeps(), testEnv);
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: x.entityId,
        agentId: x.agentId,
        channel: 'api',
        chatId: OWNER_CHAT,
        chatChannel: 'telegram',
        task: 'api test',
        status: 'awaiting_approval',
        messages: [],
        chainCount: 0,
      })
      .returning({ id: agentJobs.id });
    const toolInput = { question: QUESTION, options: OPTIONS };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId: job!.id,
        agentId: x.agentId,
        toolName: 'ask_user',
        toolInput,
        kind: 'question',
      })
      .returning({ id: approvalRequests.id });
    await notifyApprovalCreated(makeDeps(), {
      approvalRequestId: request!.id,
      toolName: 'ask_user',
      toolInput,
      jobId: job!.id,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'question',
    });
    expect(telegramSends.map((s) => s.chatId)).toEqual([OWNER_CHAT]);
    expect(telegramSends[0]!.text).toContain(`« ${QUESTION} »`);
    expect(await cardsOf(request!.id)).toEqual([
      { channel: 'telegram', conversationId: OWNER_CHAT },
    ]);
  });

  it('an approval (a gated action) reaches device A as a card: the agent’s purpose quoted, approve and reject', async () => {
    const app = createApp(makeDeps(), testEnv);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: null,
      status: 'awaiting_approval',
    });
    const toolInput = { command: 'rm -rf /tmp/x', purpose: 'Clear the scratch folder first' };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId: job,
        agentId: x.agentId,
        toolName: 'run_command',
        toolInput,
        kind: 'approval',
      })
      .returning({ id: approvalRequests.id });
    const onA = await device(app, deviceA);
    const onB = await device(app, deviceB);

    await notifyApprovalCreated(makeDeps(), {
      approvalRequestId: request!.id,
      toolName: 'run_command',
      toolInput,
      jobId: job,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'approval',
    });

    await waitFor(() => onA.gestures().some((e) => e.event === 'card'));
    const card = DeviceEventSchema.parse(onA.gestures().find((e) => e.event === 'card')!.data);
    expect(card).toMatchObject({
      type: 'card',
      cardId: request!.id,
      kind: 'approval',
      choices: [
        { label: '✅ Approve', decision: 'approve' },
        { label: '❌ Reject', decision: 'reject' },
      ],
    });
    expect(card.type === 'card' && card.text).toContain('« Clear the scratch folder first »');
    expect(card.type === 'card' && card.text).toContain('rm -rf /tmp/x');
    await settle();
    expect(onB.gestures()).toEqual([]);
    expect(telegramSends).toEqual([]);
    expect(await cardsOf(request!.id)).toEqual([{ channel: 'device', conversationId: deviceA }]);
  });
});

// ─── 3b. What the stream lost, the cards route gives back ───────────────────

describe('after a resync, a device re-reads its pending cards (#945) @cap:approuver-une-action/moteur', () => {
  /** A device of X of its own, with its key: its list holds only what this test asks. */
  async function newDevice(name: string): Promise<string> {
    const [d] = await db
      .insert(devices)
      .values({ entityId: x.entityId, name, capabilities: ['speaker', 'buttons'] })
      .returning({ id: devices.id });
    // Its key (#946): what it presents on its routes.
    const { token, tokenHash } = drawDeviceToken();
    await db.update(devices).set({ tokenHash }).where(eq(devices.id, d!.id));
    keyOf.set(d!.id, token);
    return d!.id;
  }

  it('a card asked before a restart survives it: listed as sent, answered, and the job resumes', async () => {
    const deviceA = await newDevice('Hall');
    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-ask-r',
              toolName: 'ask_user',
              args: { question: QUESTION, options: OPTIONS },
            },
          ],
        },
        {
          text: 'Tray 2 it is.',
          toolCalls: [
            { toolCallId: 'tc-rr-r', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );
    const app = createApp(deps, testEnv);
    const conv = String((await postConversation(app, deviceA)).json['conversationId']);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: conv,
    });
    const before = await device(app, deviceA);
    expect((await executeJob(job as JobId, deps, testEnv)).status).toBe('awaiting_approval');
    await waitFor(() => before.gestures().some((e) => e.event === 'card'));
    const sent = before.gestures().find((e) => e.event === 'card')!.data;

    // The runner restarts: the device comes back with the id of an event of
    // a runner that is gone. Its memory went with it — `resync`, nothing replayed.
    const after = await listenTo(app, `/api/devices/${deviceA}/events`, {
      ...as(deviceA),
      'Last-Event-ID': 'a-runner-that-is-gone:7',
    });
    expect(after.events.map((e) => e.event)).toEqual(['resync']);
    expect(after.events[0]!.data).toEqual({ type: 'resync', reason: 'runner_restarted' });

    // The row survived: the card is listed, exactly as it was sent.
    const listed = await getCards(app, deviceA);
    expect(listed.status).toBe(200);
    expect(listed.cards).toEqual([sent]);
    expect(DeviceEventSchema.parse(listed.cards[0])).toMatchObject({
      type: 'card',
      kind: 'question',
    });
    // Another device's list does not hold it.
    expect((await getCards(app, deviceB)).cards).toEqual([]);

    // Answered as the dashboard answers: the job is re-queued, then resumes to its end.
    const card = DeviceEventSchema.parse(sent);
    const choice = card.type === 'card' ? card.choices[1]! : null;
    const answered = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: card.type === 'card' ? card.cardId : '',
          decision: choice!.decision,
          answer: choice!.answer,
          responderUserId: x.userId,
        }),
      }),
    );
    expect(answered.status).toBe(200);
    expect((await getCards(app, deviceA)).cards).toEqual([]);
    const [requeued] = await db.select().from(agentJobs).where(eq(agentJobs.id, job));
    expect(requeued!.status).toBe('pending');
    expect((await executeJob(job as JobId, deps, testEnv)).status).toBe('completed');
    const [ended] = await db.select().from(agentJobs).where(eq(agentJobs.id, job));
    expect(ended).toMatchObject({ status: 'completed', result: 'Tray 2 it is.' });
  });

  it('an approval waiting on the device is listed as the card it was sent as; settled ones and forms are not', async () => {
    const deviceA = await newDevice('Study');
    const app = createApp(makeDeps(), testEnv);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: null,
      status: 'awaiting_approval',
    });
    const toolInput = { command: 'ls /tmp', purpose: 'List the scratch folder' };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId: job,
        agentId: x.agentId,
        toolName: 'run_command',
        toolInput,
        kind: 'approval',
      })
      .returning({ id: approvalRequests.id });
    // Two requests of the same job that are NOT waiting cards: a settled
    // one, and a server's form (answered on the dashboard).
    await db.insert(approvalRequests).values([
      {
        entityId: x.entityId,
        jobId: job,
        agentId: x.agentId,
        toolName: 'run_command',
        toolInput,
        kind: 'approval',
        status: 'approved',
      },
      {
        entityId: x.entityId,
        jobId: job,
        agentId: x.agentId,
        toolName: 'mcp_elicitation',
        toolInput: { message: 'Fill the form' },
        kind: 'elicitation',
      },
    ]);
    const onA = await device(app, deviceA);
    await notifyApprovalCreated(makeDeps(), {
      approvalRequestId: request!.id,
      toolName: 'run_command',
      toolInput,
      jobId: job,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'approval',
    });
    await waitFor(() => onA.gestures().some((e) => e.event === 'card'));
    const sent = onA.gestures().find((e) => e.event === 'card')!.data;
    expect((await getCards(app, deviceA)).cards).toEqual([sent]);
  });
});

// ─── 3b'. The question an MCP server asks during a call (#1067) ─────────────
//
// Mutations verified (each turns at least one case red):
//   - the choices rule skipped (every question goes as the bubble);
//   - the images dropped from the card;
//   - the image route's ownership check removed;
//   - the device card not recorded (no card.closed, its answer refused);
//   - the choice's content not read on the decision (accept needs `content`);
//   - any answer taken as the choice;
//   - the question left out of the cards list after a resync.

describe('a question an MCP server asks during a call reaches the device as a card, with its images (#1067) @cap:approuver-une-action/moteur', () => {
  // 1×1 PNG, and bytes stored as a JPEG: the route serves what is stored, as stored.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64');
  const NO_FIELD = { type: 'object', properties: {} };
  const MESSAGE = 'Confirm the job shown in the preview?';

  async function ownDevice(name: string): Promise<string> {
    const [d] = await db
      .insert(devices)
      .values({ entityId: x.entityId, name, capabilities: ['screen', 'buttons'] })
      .returning({ id: devices.id });
    const { token, tokenHash } = drawDeviceToken();
    await db.update(devices).set({ tokenHash }).where(eq(devices.id, d!.id));
    keyOf.set(d!.id, token);
    return d!.id;
  }

  /** A running job of the device's conversation, and its server asking, as the MCP adapter does. */
  async function serverAsks(
    app: ReturnType<typeof createApp>,
    dev: string,
    over: Partial<UserInputRequest> = {},
    how: { timeoutMs?: number; deps?: RunnerDeps } = {},
  ): Promise<{
    job: string;
    withdraw: () => void;
    reply: Promise<UserInputResponse>;
    requestId: () => Promise<string>;
  }> {
    const conv = String((await postConversation(app, dev)).json['conversationId']);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: conv,
      status: 'processing',
    });
    const ctl = new AbortController();
    const ask = createRequestUserInput(
      how.deps ?? makeDeps(),
      { jobId: job, agentId: x.agentId, entityId: x.entityId },
      { isLost: async () => false, timeoutMs: how.timeoutMs ?? 60_000, pollMs: 10 },
    );
    const reply = ask({
      serverSlug: 'preview-server',
      toolName: 'preview-server__run',
      toolCallId: `call-${job}`,
      message: MESSAGE,
      requestedSchema: NO_FIELD,
      attachments: [
        { mimeType: 'image/png', data: PNG, byteSize: 68, caption: 'Page 1' },
        { mimeType: 'image/jpeg', data: JPEG, byteSize: 10, caption: null },
      ],
      actions: { accept: 'Confirm', decline: 'Cancel' },
      signal: ctl.signal,
      ...over,
    });
    asking.push({ ctl, reply });
    const requestId = async (): Promise<string> => {
      for (let i = 0; i < 300; i += 1) {
        const [row] = await db
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(eq(approvalRequests.jobId, job));
        if (row) return row.id;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('the question was never asked');
    };
    return { job, withdraw: () => ctl.abort(), reply, requestId };
  }

  /** Every question still waiting is withdrawn at the end of its test: nothing polls on. */
  const asking: { ctl: AbortController; reply: Promise<UserInputResponse> }[] = [];
  afterEach(async () => {
    for (const a of asking.splice(0)) {
      a.ctl.abort();
      await a.reply.catch(() => undefined);
    }
  });

  const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>) =>
    app.fetch(new Request(`http://localhost${path}`, { headers }));

  const approve = (
    app: ReturnType<typeof createApp>,
    dev: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request('http://localhost/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...as(dev) },
          body: JSON.stringify(body),
        }),
      ),
    );

  it('a question with no field: a card with the server’s labels and image pointers; its images read with the device’s key; answered from the device, the server gets accept', async () => {
    const dev = await ownDevice('Porch');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const onB = await device(app, deviceB);
    const asked = await serverAsks(app, dev);
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card'));
    const sent = onDev.gestures().find((e) => e.event === 'card')!.data;

    // The card, as the device receives it: the platform's frame, the server's
    // words quoted, its own labels, and pointers to its two images.
    expect(DeviceEventSchema.parse(sent)).toEqual(sent);
    expect(sent).toEqual({
      type: 'card',
      cardId: id,
      kind: 'question',
      text:
        '❓ The MCP server "preview-server" asks:\n\n' +
        `│ ${MESSAGE}\n\n` +
        'Tap an option below, or answer from the dashboard.',
      choices: [
        { label: 'Confirm', decision: 'approve' },
        { label: 'Cancel', decision: 'reject' },
      ],
      images: [
        {
          path: `/api/devices/${dev}/cards/${id}/images/0`,
          mimeType: 'image/png',
          caption: 'Page 1',
        },
        { path: `/api/devices/${dev}/cards/${id}/images/1`, mimeType: 'image/jpeg' },
      ],
    });
    // Recorded as a card of THIS device; nothing went anywhere else.
    expect(await cardsOf(id)).toEqual([{ channel: 'device', conversationId: dev }]);
    expect(onB.gestures()).toEqual([]);
    expect(telegramSends).toEqual([]);

    // Each pointer, read with the device's key: the stored bytes, with their type.
    const card = DeviceEventSchema.parse(sent);
    const images = card.type === 'card' ? (card.images ?? []) : [];
    const stored = [PNG, JPEG];
    for (const [n, image] of images.entries()) {
      const res = await get(app, image.path, as(dev));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(image.mimeType);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(stored[n]!, 'base64'));
    }
    // Another device: through its own route, or naming this one, nothing.
    expect(
      (await get(app, `/api/devices/${deviceB}/cards/${id}/images/0`, as(deviceB))).status,
    ).toBe(404);
    expect((await get(app, images[0]!.path, as(deviceB))).status).toBe(404);
    // No key, the worker secret: refused.
    expect((await get(app, images[0]!.path, {})).status).toBe(401);
    expect(
      (await get(app, images[0]!.path, { Authorization: `Bearer ${testEnv.WORKER_SECRET}` }))
        .status,
    ).toBe(401);
    // An image this request does not have.
    expect((await get(app, `/api/devices/${dev}/cards/${id}/images/2`, as(dev))).status).toBe(404);

    // After a resync, the cards list holds the very card that was sent.
    expect((await getCards(app, dev)).cards).toEqual([sent]);
    expect((await getCards(app, deviceB)).cards).toEqual([]);

    // Answered as a module that sends back exactly the choice it received.
    const confirm = card.type === 'card' ? card.choices[0]! : null;
    const res = await approve(app, dev, { approvalRequestId: id, ...confirm });
    expect(res.status).toBe(200);
    // The server receives accept, with the empty content its form asks for.
    expect(await asked.reply).toEqual({ action: 'accept', content: {} });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row).toMatchObject({ status: 'approved', response: {}, resolvedBy: 'api' });
    // The card closes on the device, in the platform's words.
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card.closed'));
    expect(onDev.gestures().find((e) => e.event === 'card.closed')!.data).toEqual({
      type: 'card.closed',
      cardId: id,
      text: '✅ Answered',
    });
    expect((await getCards(app, dev)).cards).toEqual([]);
    expect(onB.gestures()).toEqual([]);
  });

  it('a request made elsewhere: its images are not the device’s to read', async () => {
    const dev = await ownDevice('Garage');
    const app = createApp(makeDeps(), testEnv);
    // A job of the same workspace, launched from the dashboard.
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: x.entityId,
        agentId: x.agentId,
        channel: 'dashboard',
        task: 'elsewhere',
        status: 'processing',
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
        toolName: 'preview-server__run',
        toolInput: { server: 'preview-server', message: MESSAGE, requestedSchema: NO_FIELD },
        kind: 'elicitation',
        executedAt: new Date(),
      })
      .returning({ id: approvalRequests.id });
    await db.insert(approvalRequestAttachments).values({
      approvalRequestId: request!.id,
      position: 0,
      mimeType: 'image/png',
      data: PNG,
      byteSize: 68,
      caption: null,
    });
    const res = await get(app, `/api/devices/${dev}/cards/${request!.id}/images/0`, as(dev));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'image_not_found' });
  });

  const imageOf = (dev: string, id: string, n: string | number): string =>
    `/api/devices/${dev}/cards/${id}/images/${n}`;

  type Asked = Awaited<ReturnType<typeof serverAsks>>;
  type Closing = (
    app: ReturnType<typeof createApp>,
    dev: string,
    asked: Asked,
    id: string,
  ) => Promise<void>;

  // THE rule of what a device may see of a request is the cards list's: a
  // request still waiting for a person. Once it is answered, withdrawn or
  // expired, its images are gone from the device exactly like an image that
  // never existed — the stored rows are still there, the route must not serve
  // them (the bytes of a question that was answered stay the server's business).
  it.each<[string, 'approved' | 'expired', Closing, { timeoutMs?: number }]>([
    [
      'answered from the device',
      'approved',
      async (app, dev, asked, id) => {
        const res = await approve(app, dev, { approvalRequestId: id, decision: 'approve' });
        expect(res.status).toBe(200);
        await asked.reply;
      },
      {},
    ],
    [
      'withdrawn by the server',
      'expired',
      async (_app, _dev, asked) => {
        asked.withdraw();
        await asked.reply;
      },
      {},
    ],
    [
      'expired with nobody answering',
      'expired',
      async (_app, _dev, asked) => {
        await asked.reply;
      },
      { timeoutMs: 1_500 },
    ],
  ])('a request no longer open serves no image: %s', async (_name, finalStatus, close, how) => {
    const dev = await ownDevice('Pantry');
    const app = createApp(makeDeps(), testEnv);
    const asked = await serverAsks(app, dev, {}, how);
    const id = await asked.requestId();
    // A second question of the same device stays open all along.
    const stays = await serverAsks(app, dev);
    const stillOpen = await stays.requestId();

    // Open: both images are served, with their type and bytes.
    const open0 = await get(app, imageOf(dev, id, 0), as(dev));
    expect(open0.status).toBe(200);
    expect(open0.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await open0.arrayBuffer())).toEqual(Buffer.from(PNG, 'base64'));
    expect((await get(app, imageOf(dev, id, 1), as(dev))).status).toBe(200);

    await close(app, dev, asked, id);
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row!.status).toBe(finalStatus);
    // The bytes are still stored: it is the route that no longer serves them.
    const kept = await db
      .select({ position: approvalRequestAttachments.position })
      .from(approvalRequestAttachments)
      .where(eq(approvalRequestAttachments.approvalRequestId, id));
    expect(kept.map((k) => k.position).sort()).toEqual([0, 1]);

    for (const n of [0, 1]) {
      const res = await get(app, imageOf(dev, id, n), as(dev));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'image_not_found' });
    }
    // Not the same as a closed route: the other open question is served.
    const other = await get(app, imageOf(dev, stillOpen, 0), as(dev));
    expect(other.status).toBe(200);
    expect(Buffer.from(await other.arrayBuffer())).toEqual(Buffer.from(PNG, 'base64'));
  });

  it.each(['-1', 'abc', '01', '00', '0000', '1000', '1.5', '0x1', '%20', '2', '999'])(
    'an image index that is not a place among the images (%s): the same 404 as a missing image',
    async (n) => {
      const dev = await ownDevice('Closet');
      const app = createApp(makeDeps(), testEnv);
      const asked = await serverAsks(app, dev);
      const id = await asked.requestId();
      // The request is open and has images 0 and 1: only the index is wrong.
      expect((await get(app, imageOf(dev, id, 0), as(dev))).status).toBe(200);
      expect((await get(app, imageOf(dev, id, 1), as(dev))).status).toBe(200);
      const res = await get(app, imageOf(dev, id, n), as(dev));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'image_not_found' });
    },
  );

  it('a stored type outside the four image types is never served, whatever intake did', async () => {
    const dev = await ownDevice('Loft');
    const app = createApp(makeDeps(), testEnv);
    const asked = await serverAsks(app, dev);
    const id = await asked.requestId();
    // Intake (and a CHECK on the column) refuse any other type; the route must
    // not rest on them alone. Lift the CHECK to put such rows where only the
    // route stands between them and the device, then put it back.
    const check = sql`approval_request_attachments_mime_check`;
    const checkOf = sql`approval_request_attachments_mime_type_check`;
    await db.execute(
      sql`ALTER TABLE approval_request_attachments DROP CONSTRAINT IF EXISTS ${check}`,
    );
    await db.execute(
      sql`ALTER TABLE approval_request_attachments DROP CONSTRAINT IF EXISTS ${checkOf}`,
    );
    try {
      const html = Buffer.from('<script>alert(1)</script>').toString('base64');
      await db.insert(approvalRequestAttachments).values([
        {
          approvalRequestId: id,
          position: 2,
          mimeType: 'text/html',
          data: html,
          byteSize: 25,
          caption: null,
        },
        {
          approvalRequestId: id,
          position: 3,
          mimeType: 'image/svg+xml',
          data: html,
          byteSize: 25,
          caption: null,
        },
      ]);
      for (const n of [2, 3]) {
        const res = await get(app, imageOf(dev, id, n), as(dev));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'image_not_found' });
      }
      // The images of the four types are still served as stored.
      for (const n of [0, 1]) {
        expect((await get(app, imageOf(dev, id, n), as(dev))).status).toBe(200);
      }
    } finally {
      await db
        .delete(approvalRequestAttachments)
        .where(
          and(
            eq(approvalRequestAttachments.approvalRequestId, id),
            inArray(approvalRequestAttachments.position, [2, 3]),
          ),
        );
      await db.execute(
        sql`ALTER TABLE approval_request_attachments ADD CONSTRAINT approval_request_attachments_mime_check CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif'))`,
      );
    }
  });

  it('a card that could not be recorded at send time: the device got it, cannot answer it, and it is never closed there', async () => {
    const dev = await ownDevice('Shed');
    // A database that refuses to record a card (the send itself works).
    const base = makeDeps();
    const failing = {
      ...base,
      db: new Proxy(base.db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === 'insert') {
            return (table: unknown) => {
              if (table === approvalCardMessages) throw new Error('cards table unavailable');
              return (target.insert as (t: unknown) => unknown)(table);
            };
          }
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      }),
    } as RunnerDeps;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createApp(failing, testEnv);
      const onDev = await device(app, dev);
      const asked = await serverAsks(app, dev, {}, { deps: failing });
      const id = await asked.requestId();
      // The card was sent: the device holds it as an event.
      await waitFor(() => onDev.gestures().some((e) => e.event === 'card'));
      expect(await cardsOf(id)).toEqual([]);
      // Said in the log, with what it costs.
      expect(
        warn.mock.calls.some(
          (c) =>
            String(c[0]).includes(`card for ${id} was sent`) &&
            String(c[0]).includes('could not be recorded'),
        ),
      ).toBe(true);
      // The device cannot answer a card it was not recorded as holding: the
      // request is untouched, still waiting.
      const res = await approve(app, dev, { approvalRequestId: id, decision: 'approve' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'approval_not_found' });
      const [still] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      expect(still!.status).toBe('pending');
      // Its images are still the device's (it is its open request).
      expect((await get(app, imageOf(dev, id, 0), as(dev))).status).toBe(200);
      // Settled elsewhere (the server withdraws), nothing closes it on the
      // device: no record, nothing to redraw.
      asked.withdraw();
      await asked.reply;
      await settle();
      expect(onDev.gestures().some((e) => e.event === 'card.closed')).toBe(false);
      expect((await get(app, imageOf(dev, id, 0), as(dev))).status).toBe(404);
    } finally {
      warn.mockRestore();
    }
  });

  it('the images of a question the device got as a bubble are not offered: a form it cannot fill is no card', async () => {
    const dev = await ownDevice('Stairs');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const asked = await serverAsks(app, dev, {
      requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
    });
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'bubble'));
    // The request is open, it is the device's, its images are stored: the
    // cards list does not hold it, so neither does the route.
    expect((await getCards(app, dev)).cards).toEqual([]);
    const res = await get(app, imageOf(dev, id, 0), as(dev));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'image_not_found' });
  });

  it('two choices whose labels read the same once trimmed: the form stays a bubble, no card', async () => {
    const dev = await ownDevice('Porch2');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const asked = await serverAsks(app, dev, {
      attachments: [],
      requestedSchema: {
        type: 'object',
        properties: {
          size: {
            type: 'string',
            title: 'Size',
            enum: ['a', 'b'],
            enumNames: ['Small', ' Small '],
          },
        },
      },
    });
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'bubble'));
    expect(onDev.gestures().some((e) => e.event === 'card')).toBe(false);
    expect(await cardsOf(id)).toEqual([]);
    expect((await getCards(app, dev)).cards).toEqual([]);
    const res = await approve(app, dev, {
      approvalRequestId: id,
      decision: 'approve',
      answer: 'Small',
    });
    expect(res.status).toBe(404);
  });

  it('labels that differ only by case: each tap selects exactly the option tapped', async () => {
    const dev = await ownDevice('Porch3');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const form = {
      type: 'object',
      properties: {
        size: { type: 'string', title: 'Size', enum: ['a', 'b'], enumNames: ['Small', 'small'] },
      },
      required: ['size'],
    };
    // Each question is tapped on its own option: the second one's `small`
    // must read `b`, the first one's `Small` must read `a`, never the other.
    for (const [tapped, value] of [
      ['small', 'b'],
      ['Small', 'a'],
    ] as const) {
      const asked = await serverAsks(app, dev, { attachments: [], requestedSchema: form });
      const id = await asked.requestId();
      await waitFor(() =>
        onDev
          .gestures()
          .some((e) => e.event === 'card' && (e.data as { cardId: string }).cardId === id),
      );
      const card = DeviceEventSchema.parse(
        onDev
          .gestures()
          .find((e) => e.event === 'card' && (e.data as { cardId: string }).cardId === id)!.data,
      );
      expect(card.type === 'card' ? card.choices : []).toEqual([
        { label: 'Size: Small', decision: 'approve', answer: 'Small' },
        { label: 'Size: small', decision: 'approve', answer: 'small' },
        { label: 'Cancel', decision: 'reject' },
      ]);
      // An answer in a case no option has is none of the choices.
      const wrong = await approve(app, dev, {
        approvalRequestId: id,
        decision: 'approve',
        answer: 'SMALL',
      });
      expect(await wrong.json()).toEqual({ error: 'answer_not_an_option' });
      const ok = await approve(app, dev, {
        approvalRequestId: id,
        decision: 'approve',
        answer: tapped,
      });
      expect(ok.status).toBe(200);
      expect(await asked.reply).toEqual({ action: 'accept', content: { size: value } });
    }
  });

  it('declined from the device: the server gets decline, and the card closes', async () => {
    const dev = await ownDevice('Attic');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const asked = await serverAsks(app, dev);
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card'));
    // The reference kit's body: the decision, and no answer.
    const res = await approve(app, dev, { approvalRequestId: id, decision: 'reject' });
    expect(res.status).toBe(200);
    expect(await asked.reply).toEqual({ action: 'decline' });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row).toMatchObject({ status: 'rejected', response: null });
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card.closed'));
    expect(onDev.gestures().find((e) => e.event === 'card.closed')!.data).toEqual({
      type: 'card.closed',
      cardId: id,
      text: '❌ Declined',
    });
  });

  it('the server withdraws its question: the device receives card.closed', async () => {
    const dev = await ownDevice('Cellar');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const asked = await serverAsks(app, dev);
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card'));
    asked.withdraw();
    expect(await asked.reply).toEqual({ action: 'cancel' });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row).toMatchObject({ status: 'expired', resolvedBy: 'system:server_cancelled' });
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card.closed'));
    expect(onDev.gestures().find((e) => e.event === 'card.closed')!.data).toEqual({
      type: 'card.closed',
      cardId: id,
      text: '⌛ Closed without an answer',
    });
    expect((await getCards(app, dev)).cards).toEqual([]);
  });

  it('one field to pick from: a choice per value, then decline; the choice fills the form', async () => {
    const dev = await ownDevice('Hallway');
    const app = createApp(makeDeps(), testEnv);
    const onDev = await device(app, dev);
    const asked = await serverAsks(app, dev, {
      attachments: [],
      requestedSchema: {
        type: 'object',
        properties: {
          size: { type: 'string', title: 'Size', enum: ['s', 'l'], enumNames: ['Small', 'Large'] },
        },
        required: ['size'],
      },
    });
    const id = await asked.requestId();
    await waitFor(() => onDev.gestures().some((e) => e.event === 'card'));
    const card = DeviceEventSchema.parse(onDev.gestures().find((e) => e.event === 'card')!.data);
    expect(card).toMatchObject({
      type: 'card',
      cardId: id,
      kind: 'question',
      choices: [
        { label: 'Size: Small', decision: 'approve', answer: 'Small' },
        { label: 'Size: Large', decision: 'approve', answer: 'Large' },
        { label: 'Cancel', decision: 'reject' },
      ],
    });
    // No images: the field is absent, not empty.
    expect(card).not.toHaveProperty('images');
    // An answer that is none of the choices is refused, the question stays open.
    const wrong = await approve(app, dev, {
      approvalRequestId: id,
      decision: 'approve',
      answer: 'Huge',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'answer_not_an_option' });
    // Approve without a choice: the form has a field, it needs one.
    const none = await approve(app, dev, { approvalRequestId: id, decision: 'approve' });
    expect(await none.json()).toEqual({ error: 'content_required' });
    const large = card.type === 'card' ? card.choices[1]! : null;
    expect((await approve(app, dev, { approvalRequestId: id, ...large })).status).toBe(200);
    expect(await asked.reply).toEqual({ action: 'accept', content: { size: 'l' } });
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
    expect(row).toMatchObject({ status: 'approved', response: { size: 'l' } });
  });

  it.each([
    ['a text field', { name: { type: 'string', title: 'Name' } }],
    ['a number field', { copies: { type: 'integer', title: 'Copies', minimum: 1 } }],
    [
      'two fields to pick from',
      {
        size: { type: 'string', title: 'Size', enum: ['s', 'l'] },
        tint: { type: 'boolean', title: 'Tint' },
      },
    ],
  ])(
    'a form with %s: the device gets today’s bubble with its reason, and no card',
    async (_, properties) => {
      const dev = await ownDevice('Landing');
      const app = createApp(makeDeps(), testEnv);
      const onDev = await device(app, dev);
      const asked = await serverAsks(app, dev, {
        message: 'Which one?',
        requestedSchema: { type: 'object', properties },
      });
      const id = await asked.requestId();
      await waitFor(() => onDev.gestures().some((e) => e.event === 'bubble'));
      // Besides the run's `state`: one bubble, and no card. Its words are the
      // ones every channel without a form gets, unchanged by #1067.
      const said = onDev.gestures().filter((e) => e.event !== 'state');
      expect(said.map((e) => e.event)).toEqual(['bubble']);
      expect((said[0]!.data as { text: string }).text).toBe(
        '❓ The MCP server "preview-server" asks:\n\n' +
          '│ Which one?\n\n' +
          'Answer from the dashboard: the question is on the run, and on the Approvals page.\n' +
          '(device has no buttons to fill a form with.)',
      );
      expect(await cardsOf(id)).toEqual([]);
      expect((await getCards(app, dev)).cards).toEqual([]);
      // Not a card the device holds: it cannot answer it.
      const res = await approve(app, dev, { approvalRequestId: id, decision: 'reject' });
      expect(res.status).toBe(404);
    },
  );
});

// ─── 3c. The origin is the RUN's: delegates, task-board children, relaunches ─

describe('a job of a device’s run answers on that device, however it was born (#945) @cap:approuver-une-action/moteur', () => {
  async function ownDevice(name: string): Promise<string> {
    const [d] = await db
      .insert(devices)
      .values({ entityId: x.entityId, name, capabilities: ['speaker', 'buttons'] })
      .returning({ id: devices.id });
    // Its key (#946): what it presents on its routes.
    const { token, tokenHash } = drawDeviceToken();
    await db.update(devices).set({ tokenHash }).where(eq(devices.id, d!.id));
    keyOf.set(d!.id, token);
    return d!.id;
  }

  /** A job of X, born of `head` the way `link` says, with no chat of its own. */
  async function bornOf(
    head: string,
    link: { parentJobId?: string; relaunchedFromJobId?: string },
    extra: { channel: string; chatId?: string; chatChannel?: string; status: string },
    conversationId: string | null,
  ): Promise<string> {
    const [row] = await db
      .insert(agentJobs)
      .values({
        entityId: x.entityId,
        agentId: x.agentId,
        task: 'born of a device run',
        messages: [],
        chainCount: 0,
        ...(conversationId ? { conversationId } : {}),
        ...link,
        ...extra,
      })
      .returning({ id: agentJobs.id });
    expect(head).not.toBe(row!.id);
    return row!.id;
  }

  async function pendingQuestion(jobId: string): Promise<string> {
    const toolInput = { question: QUESTION, options: OPTIONS };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId,
        agentId: x.agentId,
        toolName: 'ask_user',
        toolInput,
        kind: 'question',
      })
      .returning({ id: approvalRequests.id });
    await notifyApprovalCreated(makeDeps(), {
      approvalRequestId: request!.id,
      toolName: 'ask_user',
      toolInput,
      jobId,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'question',
    });
    return request!.id;
  }

  it('a task-board child (born without a chat): its states reach the device, and its card survives a resync', async () => {
    const dev = await ownDevice('Board');
    const deps = makeDeps(askUser());
    const app = createApp(deps, testEnv);
    const conv = String((await postConversation(app, dev)).json['conversationId']);
    const head = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: conv,
      status: 'awaiting_delegation',
    });
    // `create_task` → cron/execute-ready.ts: channel task-board, the creator as
    // parent, NO chat.
    const child = await bornOf(
      head,
      { parentJobId: head },
      { channel: 'task-board', status: 'pending' },
      conv,
    );
    const live = await device(app, dev);
    expect((await executeJob(child as JobId, deps, testEnv)).status).toBe('awaiting_approval');
    const [request] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, child));
    await waitFor(() => statesOf(live).length >= 2);
    // The run's state, under the job the request launched.
    expect(statesOf(live)).toEqual([
      {
        type: 'state',
        jobId: head,
        conversationId: conv,
        state: 'working',
        waitingFor: [],
        deliverables: [],
      },
      {
        type: 'state',
        jobId: head,
        conversationId: conv,
        state: 'waiting',
        waitingFor: [request!.id],
        deliverables: [],
      },
    ]);
    await waitFor(() => live.gestures().some((e) => e.event === 'card'));
    const sent = live.gestures().find((e) => e.event === 'card')!.data;

    // A restart later, the device re-reads its cards: the child's is there.
    const after = await listenTo(app, `/api/devices/${dev}/events`, {
      ...as(dev),
      'Last-Event-ID': 'a-runner-that-is-gone:3',
    });
    expect(after.events.map((e) => e.event)).toEqual(['resync']);
    expect((await getCards(app, dev)).cards).toEqual([sent]);
  });

  it('a delegate’s and a relaunched head’s pending cards are listed for the device of the run', async () => {
    const dev = await ownDevice('Porch');
    const app = createApp(makeDeps(), testEnv);
    const head = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: null,
      status: 'awaiting_delegation',
    });
    // A delegate inherits the chat (router/delegate.ts)…
    const delegate = await bornOf(
      head,
      { parentJobId: head },
      { channel: 'internal', chatId: dev, chatChannel: 'device', status: 'awaiting_approval' },
      null,
    );
    // …a head relaunched by its conversation's inbox (#531) carries none here.
    const relaunched = await bornOf(
      head,
      { relaunchedFromJobId: head },
      { channel: 'device', status: 'awaiting_approval' },
      null,
    );
    const live = await device(app, dev);
    const first = await pendingQuestion(delegate);
    const second = await pendingQuestion(relaunched);
    await waitFor(() => live.gestures().filter((e) => e.event === 'card').length >= 2);
    const sent = live
      .gestures()
      .filter((e) => e.event === 'card')
      .map((e) => e.data);
    expect(sent.map((c) => (c as { cardId: string }).cardId)).toEqual([first, second]);
    expect((await getCards(app, dev)).cards).toEqual(sent);
  });
});

// ─── 4. The end of a job, and its spoken announcement ───────────────────────

describe('a job launched by voice from a device ends on that device (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('its reply, its state and its announcement reach device A; nothing reaches device B', async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = String((await postConversation(app, deviceA)).json['conversationId']);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: conv,
      status: 'completed',
      replyRendering: 'spoken',
      result: 'The report is in your notes folder.',
    });
    // What the run produced, as the verification records it.
    await db.insert(jobDeliverableVerificationState).values({
      jobId: job,
      deliverableType: 'document',
      canonicalKey: 'notes/report.md',
      displayPathSnapshot: 'notes/report.md',
      declared: true,
      decisionStatus: 'green',
      dirtyGeneration: 1,
    });
    const onA = await device(app, deviceA);
    const onB = await device(app, deviceB);

    const finished = await publishJobEnded(db as RunnerDeps['db'], job);
    expect(finished).toMatchObject({ jobId: job, deviceId: deviceA });
    const audioId = speakFinishedJob(db as RunnerDeps['db'], finished!);
    expect(audioId).not.toBeNull();

    await waitFor(() => onA.gestures().some((e) => e.event === 'announce'));
    expect(onA.gestures().map((e) => withoutSeq(e.data))).toEqual([
      {
        type: 'bubble',
        bubbleId: job,
        jobId: job,
        conversationId: conv,
        text: 'The report is in your notes folder.',
      },
      // The end carries the deliverables `get_task` returns: a path, never
      // read in the agent's text.
      {
        type: 'state',
        jobId: job,
        conversationId: conv,
        state: 'done',
        waitingFor: [],
        deliverables: [
          { path: 'notes/report.md', type: 'document', declared: true, verification: 'green' },
        ],
      },
      { type: 'announce', jobId: job, conversationId: conv, audioId },
    ]);
    await settle();
    expect(onB.gestures()).toEqual([]);
  });

  it('a delegate that asks: the state is the RUN’s, under the job the request launched', async () => {
    const app = createApp(makeDeps(), testEnv);
    const head = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: null,
      status: 'awaiting_delegation',
    });
    // The delegate inherits the device as its chat (router/delegate.ts).
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: x.entityId,
        agentId: x.agentId,
        channel: 'internal',
        chatId: deviceA,
        chatChannel: 'device',
        parentJobId: head,
        task: 'delegated step',
        status: 'awaiting_approval',
        messages: [],
        chainCount: 0,
      })
      .returning({ id: agentJobs.id });
    const toolInput = { question: QUESTION, options: OPTIONS };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId: child!.id,
        agentId: x.agentId,
        toolName: 'ask_user',
        toolInput,
        kind: 'question',
      })
      .returning({ id: approvalRequests.id });
    const onA = await device(app, deviceA);
    await publishApprovalRequested(db as RunnerDeps['db'], {
      approvalRequestId: request!.id,
      toolName: 'ask_user',
      toolInput,
      jobId: child!.id,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'question',
    });
    await waitFor(() => statesOf(onA).length > 0);
    expect(statesOf(onA)).toEqual([
      {
        type: 'state',
        jobId: head,
        conversationId: null,
        state: 'waiting',
        waitingFor: [request!.id],
        deliverables: [],
      },
    ]);
  });

  it('a failed end carries its reason, as stored, and its deliverables', async () => {
    const app = createApp(makeDeps(), testEnv);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: null,
      status: 'failed',
      result: 'The printer did not answer.\nDetails below.',
    });
    await db.insert(jobDeliverableVerificationState).values({
      jobId: job,
      deliverableType: 'office_file',
      canonicalKey: 'out/draft.docx',
      displayPathSnapshot: 'out/draft.docx',
      declared: false,
      decisionStatus: 'red',
      dirtyGeneration: 1,
    });
    const onA = await device(app, deviceA);
    await publishJobEnded(db as RunnerDeps['db'], job);
    await waitFor(() => statesOf(onA).length > 0);
    expect(onA.gestures().map((e) => withoutSeq(e.data))).toEqual([
      {
        type: 'state',
        jobId: job,
        conversationId: null,
        state: 'failed',
        waitingFor: [],
        deliverables: [
          { path: 'out/draft.docx', type: 'office_file', declared: false, verification: 'red' },
        ],
        reason: 'The printer did not answer.',
      },
    ]);
  });

  it('with only another device listening, nothing is said', async () => {
    const app = createApp(makeDeps(), testEnv);
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: deviceA,
      conversationId: null,
      status: 'completed',
      replyRendering: 'spoken',
      result: 'Done.',
    });
    const onB = await device(app, deviceB);
    // The tests before closed and awaited their own streams (afterEach):
    // only device B listens, and that is checked, not waited for.
    expect(jobEvents.listenersOf(x.entityId, null, deviceA)).toBe(0);
    const finished = await publishJobEnded(db as RunnerDeps['db'], job);
    expect(speakFinishedJob(db as RunnerDeps['db'], finished!)).toBeNull();
    await settle();
    expect(onB.gestures()).toEqual([]);
  });
});

// ─── 5. Isolation ────────────────────────────────────────────────────────────

describe('a device of workspace X never receives an event of workspace Y (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('a job of Y whose chat names device A asks its question: nothing reaches device A', async () => {
    const deps = makeDeps(askUser());
    const app = createApp(deps, testEnv);
    // A forged chat: a job of Y pointing at a device of X.
    const job = await deviceJob({
      entityId: y.entityId,
      agentId: y.agentId,
      deviceId: deviceA,
      conversationId: null,
    });
    const onA = await device(app, deviceA);
    await executeJob(job as JobId, deps, testEnv);
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job));
    expect(request).toBeDefined();
    await settle();
    expect(onA.gestures()).toEqual([]);
    expect(await cardsOf(request!.id)).toEqual([]);
  });

  it('the device adapter refuses to send to a device outside the workspace it is told', async () => {
    const app = createApp(makeDeps(), testEnv);
    const onA = await device(app, deviceA);
    await expect(
      deviceAdapter.sendText({ entityId: y.entityId }, deviceA, 'hello'),
    ).rejects.toThrow(DeliveryError);
    await expect(
      deviceAdapter.sendText({ entityId: y.entityId }, deviceA, 'hello'),
    ).rejects.toThrow(/device_not_in_workspace/);
    // In its own workspace, the same send arrives — the refusal is the workspace.
    await deviceAdapter.sendText({ entityId: x.entityId }, deviceA, 'hello');
    await waitFor(() => onA.gestures().length > 0);
    expect(onA.gestures().map((e) => e.data)).toEqual([
      expect.objectContaining({ type: 'bubble', text: 'hello', jobId: null }),
    ]);
  });
});

// ─── The gestures are the dashboard's routes ─────────────────────────────────

describe('every gesture of the protocol is a route of the runner (#945) @cap:parler-par-canal-externe/moteur', () => {
  it('DEVICE_GESTURES names only routes the app serves', () => {
    const app = createApp(makeDeps(), testEnv);
    const served = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    const named = Object.values(DEVICE_GESTURES).flatMap((routes) =>
      routes.map((r) => `${r.method} ${r.path}`),
    );
    expect(named.filter((r) => !served.has(r))).toEqual([]);
  });
});

// ─── 7. The person's own words, sent by the reference client (#1099) ─────────

/** The built client, as a device maker copies it: only the part this test calls. */
interface BuiltClient {
  connect(
    url: string,
    session: { deviceId: string; token: string; conversationId: string },
    options: { fetch: typeof fetch; hearAnnouncements: boolean },
  ): {
    on(
      type: 'card',
      handler: (card: {
        cardId: string;
        kind: string;
        choices: { label: string; decision: 'approve' | 'reject'; answer?: string }[];
      }) => void,
    ): () => void;
    answer(
      cardId: string,
      choice: { label: string; decision: 'approve' | 'reject'; answer?: string },
      options?: { notes?: string },
    ): Promise<void>;
    close(): void;
  };
  NodalDeviceError: new (...args: never[]) => Error & { code: string };
  DEVICE_CARD_NOTES_MAX: number;
}

describe('a device answers a card with what the person said (#1099) @cap:approuver-une-action/moteur', () => {
  let built: BuiltClient;
  let buildDir = '';
  const NO_FIELD = { type: 'object', properties: {} };
  const WORDS = 'Use the second tray, and print it in grey.';

  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), 'nodal-device-notes-'));
    const { js } = (await buildClient(buildDir)) as { js: string };
    built = (await import(pathToFileURL(js).href)) as BuiltClient;
  }, 120_000);
  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  /** Every question withdrawn and every client closed at the end of its test: nothing polls on. */
  const withdrawals: AbortController[] = [];
  const clients: { close: () => void }[] = [];
  afterEach(() => {
    for (const ctl of withdrawals.splice(0)) ctl.abort();
    for (const cl of clients.splice(0)) cl.close();
  });

  const approve = (
    app: ReturnType<typeof createApp>,
    dev: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request('http://localhost/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...as(dev) },
          body: JSON.stringify(body),
        }),
      ),
    );

  async function ownDevice(name: string): Promise<string> {
    const [d] = await db
      .insert(devices)
      .values({ entityId: x.entityId, name, capabilities: ['screen', 'buttons'] })
      .returning({ id: devices.id });
    const { token, tokenHash } = drawDeviceToken();
    await db.update(devices).set({ tokenHash }).where(eq(devices.id, d!.id));
    keyOf.set(d!.id, token);
    return d!.id;
  }

  /** The device, through the BUILT client, on the real app: what the runner receives is recorded. */
  async function clientOf(app: ReturnType<typeof createApp>, dev: string) {
    const conv = String((await postConversation(app, dev)).json['conversationId']);
    const cards: Parameters<Parameters<ReturnType<BuiltClient['connect']>['on']>[1]>[0][] = [];
    const received: { body: Record<string, unknown>; text: string }[] = [];
    const fetchApp = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/api/approve' && typeof init?.body === 'string') {
        received.push({ body: JSON.parse(init.body) as Record<string, unknown>, text: init.body });
      }
      return Promise.resolve(app.fetch(new Request(url, init)));
    }) as typeof fetch;
    const client = built.connect(
      'http://localhost/',
      { deviceId: dev, token: keyOf.get(dev)!, conversationId: conv },
      { fetch: fetchApp, hearAnnouncements: false },
    );
    client.on('card', (c) => cards.push(c));
    clients.push(client);
    return {
      client,
      conv,
      received,
      card: async (id: string) => {
        await waitFor(() => cards.some((c) => c.cardId === id));
        return cards.find((c) => c.cardId === id)!;
      },
    };
  }

  const rowOf = async (id: string) => {
    const [row] = await db
      .select({
        status: approvalRequests.status,
        notes: approvalRequests.notes,
        answer: approvalRequests.answer,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    return row!;
  };

  /** An approval card: a gated action of a job of the device, announced to it. */
  async function approvalCard(dev: string) {
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: null,
      status: 'awaiting_approval',
    });
    const toolInput = { command: 'rm -rf /tmp/x', purpose: 'Clear the scratch folder first' };
    const [request] = await db
      .insert(approvalRequests)
      .values({
        entityId: x.entityId,
        jobId: job,
        agentId: x.agentId,
        toolName: 'run_command',
        toolInput,
        kind: 'approval',
      })
      .returning({ id: approvalRequests.id });
    await notifyApprovalCreated(makeDeps(), {
      approvalRequestId: request!.id,
      toolName: 'run_command',
      toolInput,
      jobId: job,
      agentId: x.agentId,
      entityId: x.entityId,
      kind: 'approval',
    });
    return { id: request!.id, settled: async (): Promise<unknown> => undefined };
  }

  /** A question card: `ask_user` of a job of the device, run to its suspension. */
  async function questionCard(dev: string, conv: string) {
    const deps = makeDeps(askUser());
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: conv,
    });
    expect((await executeJob(job as JobId, deps, testEnv)).status).toBe('awaiting_approval');
    const [request] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job), eq(approvalRequests.kind, 'question')));
    return { id: request!.id, settled: async (): Promise<unknown> => undefined };
  }

  /** A server's question card, asked as the MCP adapter asks it. */
  async function serverQuestionCard(dev: string, conv: string) {
    const job = await deviceJob({
      entityId: x.entityId,
      agentId: x.agentId,
      deviceId: dev,
      conversationId: conv,
      status: 'processing',
    });
    const ctl = new AbortController();
    withdrawals.push(ctl);
    const ask = createRequestUserInput(
      makeDeps(),
      { jobId: job, agentId: x.agentId, entityId: x.entityId },
      { isLost: async () => false, timeoutMs: 60_000, pollMs: 10 },
    );
    const reply = ask({
      serverSlug: 'preview-server',
      toolName: 'preview-server__run',
      toolCallId: `call-${job}`,
      message: 'Confirm the job shown in the preview?',
      requestedSchema: NO_FIELD,
      attachments: [],
      actions: { accept: 'Confirm', decline: 'Cancel' },
      signal: ctl.signal,
    });
    void reply.catch(() => undefined);
    let id = '';
    await waitFor(() => {
      void db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job))
        .then(([r]) => {
          if (r) id = r.id;
        });
      return id !== '';
    }, 5_000);
    return { id, settled: async (): Promise<unknown> => reply };
  }

  const KINDS = [
    { name: 'an approval', make: approvalCard, wantAnswer: false },
    { name: 'a question', make: questionCard, wantAnswer: true },
    { name: 'a server’s question', make: serverQuestionCard, wantAnswer: false },
  ] as const;

  for (const kind of KINDS) {
    for (const side of ['approve', 'reject'] as const) {
      it(`${kind.name}, ${side === 'approve' ? 'approved' : 'refused'} from the device: the person’s words reach the runner and the stored row`, async () => {
        const dev = await ownDevice(`Notes ${kind.name} ${side}`);
        const app = createApp(makeDeps(), testEnv);
        const c = await clientOf(app, dev);
        const made = await kind.make(dev, c.conv);
        const card = await c.card(made.id);
        // A question's card offers its options only; declining it is still a
        // gesture the route takes (`[REJECTED]` for the agent), so a device
        // that lets the person decline builds that choice itself.
        const choice = card.choices.find((ch) => ch.decision === side) ?? {
          label: 'Decline',
          decision: side,
        };

        await c.client.answer(made.id, choice, { notes: WORDS });

        // What the runner received: the decision, the choice, and the words.
        expect(c.received).toHaveLength(1);
        expect(c.received[0]!.body).toEqual({
          approvalRequestId: made.id,
          decision: side,
          ...(choice.answer !== undefined ? { answer: choice.answer } : {}),
          notes: WORDS,
        });
        // What it stored.
        expect(await rowOf(made.id)).toEqual({
          status: side === 'approve' ? 'approved' : 'rejected',
          notes: WORDS,
          answer: side === 'approve' && kind.wantAnswer ? choice.answer : null,
        });
        await made.settled();
      });
    }
  }

  it('no words, or only whitespace: the row keeps no notes, and the body is the one without options', async () => {
    const dev = await ownDevice('Notes none');
    const app = createApp(makeDeps(), testEnv);
    const c = await clientOf(app, dev);
    const one = await approvalCard(dev);
    const two = await approvalCard(dev);
    const cardOne = await c.card(one.id);
    const cardTwo = await c.card(two.id);
    await c.client.answer(one.id, cardOne.choices[0]!);
    await c.client.answer(two.id, cardTwo.choices[1]!, { notes: ' \n\t ' });
    expect(c.received.map((r) => r.text)).toEqual([
      JSON.stringify({ approvalRequestId: one.id, decision: 'approve' }),
      JSON.stringify({ approvalRequestId: two.id, decision: 'reject' }),
    ]);
    expect((await rowOf(one.id)).notes).toBeNull();
    expect((await rowOf(two.id)).notes).toBeNull();
  });

  it('past the bound the client refuses before any request; the same text beside the client is refused by the route with notes_too_long; the bound itself is taken', async () => {
    const dev = await ownDevice('Notes bound');
    const app = createApp(makeDeps(), testEnv);
    const c = await clientOf(app, dev);
    const made = await approvalCard(dev);
    const card = await c.card(made.id);
    const tooLong = 'x'.repeat(built.DEVICE_CARD_NOTES_MAX + 1);

    // The client: refused locally, nothing reached the runner, the card still waits.
    const refused = await c.client
      .answer(made.id, card.choices[0]!, { notes: tooLong })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(built.NodalDeviceError);
    expect((refused as { code: string }).code).toBe('invalid_argument');
    expect(c.received).toEqual([]);
    expect(await rowOf(made.id)).toEqual({ status: 'pending', notes: null, answer: null });

    // The route, called beside the client: a named code, the row untouched.
    const direct = await approve(app, dev, {
      approvalRequestId: made.id,
      decision: 'approve',
      notes: tooLong,
    });
    expect(direct.status).toBe(400);
    expect(await direct.json()).toEqual({ error: 'notes_too_long' });
    expect(await rowOf(made.id)).toEqual({ status: 'pending', notes: null, answer: null });

    // The same route takes exactly the bound.
    const atBound = 'y'.repeat(built.DEVICE_CARD_NOTES_MAX);
    const ok = await approve(app, dev, {
      approvalRequestId: made.id,
      decision: 'approve',
      notes: atBound,
    });
    expect(ok.status).toBe(200);
    expect((await rowOf(made.id)).notes).toBe(atBound);
  });

  it('the bound is the route’s, whoever calls it: the dashboard’s path (trusted caller) is refused the same way', async () => {
    const dev = await ownDevice('Notes dashboard');
    const app = createApp(makeDeps(), testEnv);
    const made = await approvalCard(dev);
    const res = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: made.id,
          decision: 'reject',
          notes: 'z'.repeat(5001),
          responderUserId: x.userId,
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'notes_too_long' });
    expect((await rowOf(made.id)).status).toBe('pending');
    // And what the dashboard sends today (up to 5000) is still taken.
    const ok = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: made.id,
          decision: 'reject',
          notes: 'z'.repeat(5000),
          responderUserId: x.userId,
        }),
      }),
    );
    expect(ok.status).toBe(200);
    expect((await rowOf(made.id)).notes).toHaveLength(5000);
  });
});
