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
import { publishJobEnded } from '../../events/publish.ts';
import { speakFinishedJob } from '../../chat/job-reply-voice.ts';
import { readSse, type SseEvent } from '../chat/_sse-reader.ts';

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
  listenTo(app, `/api/devices/${id}/events`);

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Long enough for an event that should not come to arrive. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

async function postConversation(
  app: ReturnType<typeof createApp>,
  id: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
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

  it('a session acts only as a device of ITS workspace; another workspace’s device is not found', async () => {
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
    expect((await listenTo(app, `/api/devices/${deviceA}/events`)).status).toBe(401);
    expect((await listenTo(app, `/api/devices/${deviceA}/events`, asX)).status).toBe(200);
    expect((await listenTo(app, `/api/devices/${deviceOfY}/events`, asX)).status).toBe(404);
    expect((await postConversation(app, deviceOfY, {}, asX)).status).toBe(404);
    expect((await listenTo(app, `/api/devices/not-a-device/events`, asX)).status).toBe(404);
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
    expect(onA.gestures()).toContainEqual(
      expect.objectContaining({
        event: 'state',
        data: { type: 'state', jobId: job, conversationId: conv, state: 'waiting' },
      }),
    );
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
      { type: 'state', jobId: job, conversationId: conv, state: 'done' },
      { type: 'announce', jobId: job, conversationId: conv, audioId },
    ]);
    await settle();
    expect(onB.gestures()).toEqual([]);
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
