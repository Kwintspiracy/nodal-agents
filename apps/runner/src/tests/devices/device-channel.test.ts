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

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  jobDeliverableVerificationState,
  approvalCardMessages,
  approvalRequests,
  conversations,
  devices,
  entities,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
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
import { publishApprovalRequested, publishJobEnded } from '../../events/publish.ts';
import { speakFinishedJob } from '../../chat/job-reply-voice.ts';
import { jobEvents } from '../../events/job-events.ts';
import { readSse, type SseEvent } from '../chat/_sse-reader.ts';
import { drawDeviceToken } from '../../devices/device-secrets.ts';

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

const opened: AbortController[] = [];
afterEach(() => {
  for (const ctl of opened.splice(0)) ctl.abort();
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
  opened.push(ctl);
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { headers, signal: ctl.signal }),
  );
  if (res.status !== 200) return { status: res.status, events: [], gestures: () => [] };
  const reader = readSse(res);
  await waitFor(() => reader.events.length > 0);
  return {
    status: 200,
    events: reader.events,
    gestures: () => reader.events.filter((e) => e.event !== 'ready' && e.event !== 'resync'),
  };
}

const device = (app: ReturnType<typeof createApp>, id: string) =>
  listenTo(app, `/api/devices/${id}/events`, as(id));

/** The `state` gestures a device received, checked against the protocol. */
const statesOf = (l: Listener) =>
  l
    .gestures()
    .filter((e) => e.event === 'state')
    .map((e) => DeviceEventSchema.parse(e.data));

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
    expect(onA.gestures().map((e) => DeviceEventSchema.parse(e.data))).toEqual([
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
    expect(onA.gestures().map((e) => e.data)).toEqual([
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
    // The streams of the tests before are closed: only device B listens.
    await waitFor(() => jobEvents.listenersOf(x.entityId, null, deviceA) === 0);
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
