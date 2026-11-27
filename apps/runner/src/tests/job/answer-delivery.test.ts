// answer-delivery.test.ts — a request made in a chat is answered in that chat,
// by the harness (#1215, #1203, part of #1170).
//
// The rule: the gate that writes `completed` (`completeJob`, job/state.ts)
// prepares, in the same transaction, the delivery of the job's answer to the
// chat the request came from (or that its trigger designated), on every
// channel and every runtime. It does not when the step that produced the
// answer holds a confirmed send to that same chat: a fact read from the stored
// tool calls (by step and by destination), the same after a suspension, a
// resume or a restart. "Delivered" is a row, not a flag.
//
// Asserted on rows: the job row (status, result), the prepared delivery rows
// (channel, chat, payload, key), the tool_calls row of a send (its receipt),
// what the channel adapter was handed, and what a device's stream received.
// The model is scripted; a channel send reaches no network.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  agentTasks,
  and,
  APPROVAL_ROW_KEY,
  approvalRequests,
  approvalRules,
  channelAllowedConversations,
  channelBindings,
  conversationHandleFor,
  eq,
  jobDeliveries,
  listenToTransitions,
  telegramAllowedChats,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { answerDeliveryKey, answerNotPreparedLine } from '../../job/answer-delivery.ts';
import { deliverCompletedRoots } from '../../cron/deliver-results.ts';
import { JobEventBus } from '../../events/job-events.ts';
import { transitionListener } from '../../events/publish.ts';

// ─── Interceptions ────────────────────────────────────────────────────────────

/** A text whose send times out after it was transmitted: the platform may have it. */
const UNCONFIRMED = 'UNCONFIRMED';

const { getActiveLlmClient, setActiveLlmClient, sent } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
    /** Every text a channel adapter was handed and accepted, in order. */
    sent: [] as Array<{ channel: string; chatId: string; text: string }>,
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const c = getActiveLlmClient();
      if (!c) throw new Error('answer-delivery test: no active LLM client');
      return c;
    },
  };
});

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  const adapterOf = (channel: string) => ({
    channel,
    capabilities: { buttons: true, threads: false, media: true, editMessage: true },
    text: actual.getAdapter('telegram').text,
    sendText: async (_creds: unknown, chatId: string, text: string) => {
      if (text.includes(UNCONFIRMED) && !text.includes('[resent]')) {
        const err = new actual.DeliveryError('telegram_request_failed', 'send timed out');
        err.mayHaveDelivered = true;
        throw err;
      }
      sent.push({ channel, chatId, text });
      return { messageId: `${channel}-${sent.length}` };
    },
    sendMedia: async () => ({ messageId: 'media' }),
    sendApprovalCard: async () => ({ messageId: 'card' }),
  });
  return { ...actual, getAdapter: (channel: string) => adapterOf(channel) };
});

// ─── Scripted model ───────────────────────────────────────────────────────────

interface Reply {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function scriptedModel(replies: Reply[]): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const reply = replies[i] ?? replies[replies.length - 1]!;
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (reply.text) content.push({ type: 'text', text: reply.text });
      for (const tc of reply.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: `${tc.toolCallId}-${i}`,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const calls = (reply.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: calls
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
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

const send = (id: string, text: string, chatId?: string) => ({
  toolCallId: id,
  toolName: 'telegram_send_message',
  args: { text, ...(chatId ? { chatId } : {}) },
});
const work = (id: string, fact: string) => ({
  toolCallId: id,
  toolName: 'save_memory',
  args: { fact, category: 'context', purpose: 'Keep this fact.' },
});
const done = (reason?: string) => ({
  toolCallId: 'rr',
  toolName: 'return_result',
  args: { status: 'success', ...(reason ? { reason } : {}) },
});

// ─── Fixture ──────────────────────────────────────────────────────────────────

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

/** Everything the transitions of this file pushed to the stream, with the device it went to. */
class RecordingBus extends JobEventBus {
  readonly seen: Array<{ type: string; deviceId: string | null; jobId: unknown }> = [];
  override publish(
    ...args: Parameters<JobEventBus['publish']>
  ): ReturnType<JobEventBus['publish']> {
    const [, , payload, deviceId] = args;
    const p = payload as unknown as { type: string; jobId?: unknown };
    this.seen.push({ type: p.type, deviceId: deviceId ?? null, jobId: p.jobId });
    return super.publish(...args);
  }
}

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const bus = new RecordingBus();
let unlisten: () => void = () => {};

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  // The agent is connected to the four messaging channels.
  await db
    .update(agents)
    .set({ telegramBotToken: 'fake-token' })
    .where(eq(agents.id, seed.agentId));
  for (const channel of ['whatsapp', 'discord', 'slack'] as const) {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      credentials: JSON.stringify({ botToken: `${channel}-token`, sessionDir: '/sessions/x' }),
      enabled: true,
    });
  }
  unlisten = listenToTransitions(transitionListener(bus));
});

afterAll(() => unlisten());

function deps(client: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(client);
  return {
    db: db as RunnerDeps['db'],
    llmClient: client,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

type Surface = 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'device' | 'dashboard';

let chatSeq = 700_000;

/** A chat the agent may write to, as the pairing and the channel handlers record it. */
async function allowChat(channel: string, chatId: string): Promise<void> {
  if (channel === 'telegram') {
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId,
      status: 'active',
    });
    return;
  }
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel,
    conversationId: chatId,
    status: 'active',
  } as typeof channelAllowedConversations.$inferInsert);
}

/** A head job asked on `surface`, as the channel handlers write it. */
async function headJob(
  surface: Surface,
  extra: Partial<typeof agentJobs.$inferInsert> = {},
): Promise<{ id: string; chatId: string | null }> {
  chatSeq += 1;
  const chatId = surface === 'dashboard' ? null : String(chatSeq);
  if (chatId !== null && surface !== 'device') await allowChat(surface, chatId);
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: surface,
      chatId,
      chatChannel: chatId === null ? null : surface,
      task: `request ${chatSeq} from ${surface}`,
      status: 'pending',
      messages: [],
      ...extra,
    })
    .returning({ id: agentJobs.id, chatId: agentJobs.chatId });
  return job!;
}

async function rowOf(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      runnerNotes: agentJobs.runnerNotes,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

async function deliveriesOf(jobId: string) {
  return db
    .select({
      channel: jobDeliveries.channel,
      chatId: jobDeliveries.chatId,
      payload: jobDeliveries.payload,
      idempotencyKey: jobDeliveries.idempotencyKey,
    })
    .from(jobDeliveries)
    .where(eq(jobDeliveries.jobId, jobId));
}

async function run(jobId: string, replies: Reply[]) {
  return executeJob(jobId as JobId, deps(scriptedModel(replies)), testEnv);
}

/** The texts the adapter accepted for one chat. */
const sentTo = (chatId: string | null) =>
  sent.filter((s) => s.chatId === chatId).map((s) => s.text);

// ─── Every channel: the answer is delivered, by the harness ──────────────────

describe('the answer of a job asked on a chat is delivered to that chat @cap:parler-par-canal-externe/moteur', () => {
  it.each(['telegram', 'whatsapp', 'discord', 'slack'] as const)(
    'a job asked on %s that answers in text: one delivery, that text, on that chat, sent once',
    async (channel) => {
      const job = await headJob(channel);
      const result = await run(job.id, [{ text: `The answer, on ${channel}.` }]);
      expect(result.status).toBe('completed');
      const row = await rowOf(job.id);
      expect(row.result).toBe(`The answer, on ${channel}.`);
      expect(await deliveriesOf(job.id)).toEqual([
        {
          channel,
          chatId: job.chatId,
          payload: `The answer, on ${channel}.`,
          idempotencyKey: answerDeliveryKey(job.id),
        },
      ]);
      expect(sentTo(job.chatId)).toEqual([`The answer, on ${channel}.`]);
    },
  );

  it('a routine that asked for its confirmation in a chat: the answer goes to that chat', async () => {
    chatSeq += 1;
    const chatId = String(chatSeq);
    await allowChat('discord', chatId);
    const job = await headJob('dashboard', { channel: 'cron', chatId, chatChannel: 'discord' });
    await run(job.id, [{ text: 'Done: three invoices filed.' }]);
    expect(await deliveriesOf(job.id)).toEqual([
      {
        channel: 'discord',
        chatId,
        payload: 'Done: three invoices filed.',
        idempotencyKey: answerDeliveryKey(job.id),
      },
    ]);
  });

  it('a device job: no outbox row; its stream receives the end once', async () => {
    const job = await headJob('device');
    bus.seen.length = 0;
    const result = await run(job.id, [{ text: 'The lights are off.' }]);
    expect(result.status).toBe('completed');
    expect(await deliveriesOf(job.id)).toEqual([]);
    expect(bus.seen.filter((e) => e.type === 'job.finished' && e.jobId === job.id)).toEqual([
      { type: 'job.finished', deviceId: job.chatId, jobId: job.id },
    ]);
  });

  it('a dashboard job and an MCP job: no chat, no outbox row; the result is read where it was asked', async () => {
    const dashboard = await headJob('dashboard');
    const mcp = await headJob('dashboard', { channel: 'mcp' });
    for (const job of [dashboard, mcp]) {
      expect((await run(job.id, [{ text: 'Here it is.' }])).status).toBe('completed');
      expect((await rowOf(job.id)).result).toBe('Here it is.');
      expect(await deliveriesOf(job.id)).toEqual([]);
    }
  });

  it('a delegated child that inherits the chat answers its parent only', async () => {
    const parent = await headJob('telegram', { status: 'awaiting_delegation' });
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        chatId: parent.chatId,
        chatChannel: 'telegram',
        parentJobId: parent.id,
        task: 'a delegated step',
        status: 'pending',
        messages: [],
      })
      .returning({ id: agentJobs.id });
    await db
      .update(agentJobs)
      .set({
        pendingDelegation: {
          subJobId: child!.id,
          toolUseId: 'tu-1',
          toolName: 'assign_x',
          agentSlug: 'x',
        },
      })
      .where(eq(agentJobs.id, parent.id));
    expect((await run(child!.id, [{ text: 'The step is done.' }])).status).toBe('completed');
    expect(await deliveriesOf(child!.id)).toEqual([]);
    expect(sentTo(parent.chatId)).toEqual([]);
  });

  it('a chat on a channel the agent is not connected to: nothing is prepared, and the row says so', async () => {
    const job = await headJob('telegram');
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
    try {
      await run(job.id, [{ text: 'An answer nobody can carry.' }]);
    } finally {
      await db
        .update(agents)
        .set({ telegramBotToken: 'fake-token' })
        .where(eq(agents.id, seed.agentId));
    }
    const row = await rowOf(job.id);
    expect(row.status).toBe('completed');
    expect(await deliveriesOf(job.id)).toEqual([]);
    const line = answerNotPreparedLine('channel_inactive');
    expect(row.result).toBe(`An answer nobody can carry.\n\n${line}`);
    expect(row.runnerNotes).toContain(line);
  });
});

// ─── "Delivered" is a fact of the answer step ────────────────────────────────

describe('a send counts as the answer only in the answer step, to the chat that asked @cap:parler-par-canal-externe/moteur', () => {
  it('an acknowledgement by tool, then work, then the answer as text: the answer is delivered once', async () => {
    const job = await headJob('telegram');
    const result = await run(job.id, [
      { toolCalls: [send('ack', 'Je regarde ça.'), work('w1', 'looked at it')] },
      { toolCalls: [work('w2', 'still looking')] },
      { text: 'Voici la réponse complète.' },
    ]);
    expect(result.status).toBe('completed');
    expect(await deliveriesOf(job.id)).toEqual([
      {
        channel: 'telegram',
        chatId: job.chatId,
        payload: 'Voici la réponse complète.',
        idempotencyKey: answerDeliveryKey(job.id),
      },
    ]);
    expect(sentTo(job.chatId)).toEqual(['Je regarde ça.', 'Voici la réponse complète.']);
  });

  it('an acknowledgement alone, then the answer as text: the answer is newer, it is delivered', async () => {
    const job = await headJob('slack');
    await run(job.id, [{ toolCalls: [send('ack', 'On it.')] }, { text: 'Here is what I found.' }]);
    expect((await deliveriesOf(job.id)).map((d) => d.payload)).toEqual(['Here is what I found.']);
    expect(sentTo(job.chatId)).toEqual(['On it.', 'Here is what I found.']);
  });

  it('the answer step sends the answer to the chat that asked: no harness delivery, one message', async () => {
    const job = await headJob('telegram');
    const result = await run(job.id, [
      { toolCalls: [work('w1', 'did the work')] },
      { toolCalls: [send('answer', 'The full answer, sent by the agent.'), done()] },
    ]);
    expect(result.status).toBe('completed');
    expect(await deliveriesOf(job.id)).toEqual([]);
    expect(sentTo(job.chatId)).toEqual(['The full answer, sent by the agent.']);
    // The platform's receipt is on the call's row; the model read `{sent: true}`.
    const [call] = await db
      .select({ toolOutput: toolCalls.toolOutput })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.toolName, 'telegram_send_message')));
    expect(JSON.parse(call!.toolOutput!)).toEqual({
      sent: true,
      receipt: { channel: 'telegram', chatId: job.chatId, messageId: expect.any(String) },
    });
    const toolResults = (await rowOf(job.id)).messages as Array<{
      role: string;
      content: Array<{ toolName?: string; output?: unknown }>;
    }>;
    const sendResult = toolResults
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .find((p) => p.toolName === 'telegram_send_message');
    expect(sendResult?.output).toEqual({ type: 'json', value: { sent: true } });
  });

  it('the answer step names the chat that asked by its address: it is still that chat', async () => {
    const job = await headJob('discord');
    const handle = await conversationHandleFor(db as never, {
      entityId: seed.entityId,
      channel: 'discord',
      conversationId: job.chatId!,
    });
    await run(job.id, [
      { toolCalls: [send('answer', 'Sent to this chat by its address.', handle), done()] },
    ]);
    expect(await deliveriesOf(job.id)).toEqual([]);
    expect(sentTo(job.chatId)).toEqual(['Sent to this chat by its address.']);
  });

  it('the answer step sends to ANOTHER chat: the person who asked still gets the answer', async () => {
    const job = await headJob('telegram');
    chatSeq += 1;
    const group = String(chatSeq);
    await allowChat('telegram', group);
    const result = await run(job.id, [
      {
        toolCalls: [
          send('post', 'Le récap de la semaine.', group),
          done('Le récap est posté dans le groupe.'),
        ],
      },
    ]);
    expect(result.status).toBe('completed');
    expect(sentTo(group)).toEqual(['Le récap de la semaine.']);
    expect(await deliveriesOf(job.id)).toEqual([
      {
        channel: 'telegram',
        chatId: job.chatId,
        payload: 'Le récap est posté dans le groupe.',
        idempotencyKey: answerDeliveryKey(job.id),
      },
    ]);
    expect(sentTo(job.chatId)).toEqual(['Le récap est posté dans le groupe.']);
  });
});

// ─── The shapes of an answer the code already knows ──────────────────────────

describe('each shape of an answer is delivered once, as the row reads it @cap:parler-par-canal-externe/moteur', () => {
  it.each([
    {
      shape: 'a text staled by later work, then the signal with its reason: the reason',
      replies: [
        { text: 'Je regarde, je relance le rendu.', toolCalls: [work('w1', 'render')] },
        { toolCalls: [work('w2', 'render again')] },
        { toolCalls: [done('Le rendu est fait : 2 pages.')] },
      ],
      answer: 'Le rendu est fait : 2 pages.',
    },
    {
      shape:
        'a text written with a call, then the signal with its reason: the text, then the reason',
      replies: [
        { text: 'Le rapport : tout est vert.', toolCalls: [work('w1', 'record verdict')] },
        { toolCalls: [done('Verdict enregistré.')] },
      ],
      answer: 'Le rapport : tout est vert.\n\nVerdict enregistré.',
    },
    {
      shape: 'a text written alone in its step, then the signal: the text',
      replies: [
        { toolCalls: [work('w1', 'work')] },
        { text: 'Tout est fait.', toolCalls: [done('ignored, the text saw everything')] },
      ],
      answer: 'Tout est fait.',
    },
  ])('$shape', async ({ replies, answer }) => {
    const job = await headJob('whatsapp');
    expect((await run(job.id, replies)).status).toBe('completed');
    const row = await rowOf(job.id);
    expect(row.result).toBe(answer);
    expect(await deliveriesOf(job.id)).toEqual([
      {
        channel: 'whatsapp',
        chatId: job.chatId,
        payload: answer,
        idempotencyKey: answerDeliveryKey(job.id),
      },
    ]);
  });
});

// ─── A suspension, a resume: the facts are read again, never remembered ──────

describe('a suspension longer than the grace window changes nothing @cap:parler-par-canal-externe/moteur', () => {
  /** The tool asks first for this agent: its own row says so (#917). */
  async function gate(toolName: string): Promise<void> {
    await db
      .insert(approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        toolName,
        action: 'require_approval',
      })
      .onConflictDoUpdate({ target: APPROVAL_ROW_KEY, set: { action: 'require_approval' } });
  }
  async function ungate(toolName: string): Promise<void> {
    await db
      .update(approvalRules)
      .set({ action: 'auto_approve' })
      .where(and(eq(approvalRules.agentId, seed.agentId), eq(approvalRules.toolName, toolName)));
  }
  async function approveAndRequeue(jobId: string): Promise<void> {
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.jobId, jobId));
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, jobId));
  }

  it('sent in the answer step, then suspended, approved and resumed: no duplicate, no false "nothing delivered"', async () => {
    await gate('save_memory');
    try {
      const job = await headJob('telegram');
      const model = scriptedModel([
        { toolCalls: [send('answer', 'Here is your summary.'), work('w1', 'the gated action')] },
        { toolCalls: [done()] },
      ]);
      const first = await executeJob(job.id as JobId, deps(model), testEnv);
      expect(first.status).toBe('awaiting_approval');
      await approveAndRequeue(job.id);
      // A new run of the job: nothing of the first one is in memory.
      const second = await executeJob(job.id as JobId, deps(model), testEnv);
      expect(second.status).toBe('completed');
      expect((await rowOf(job.id)).error).toBeNull();
      expect(await deliveriesOf(job.id)).toEqual([]);
      expect(sentTo(job.chatId)).toEqual(['Here is your summary.']);
    } finally {
      await ungate('save_memory');
    }
  });

  it('suspended before any answer, resumed, then the answer as text: delivered once', async () => {
    await gate('save_memory');
    try {
      const job = await headJob('discord');
      const model = scriptedModel([
        { toolCalls: [send('ack', 'Une validation est nécessaire.'), work('w1', 'gated')] },
        { text: 'C’est fait, la note est enregistrée.' },
      ]);
      expect((await executeJob(job.id as JobId, deps(model), testEnv)).status).toBe(
        'awaiting_approval',
      );
      await approveAndRequeue(job.id);
      expect((await executeJob(job.id as JobId, deps(model), testEnv)).status).toBe('completed');
      expect((await deliveriesOf(job.id)).map((d) => d.payload)).toEqual([
        'C’est fait, la note est enregistrée.',
      ]);
    } finally {
      await ungate('save_memory');
    }
  });
});

// ─── A send whose outcome is unknown ──────────────────────────────────────────

describe('a send whose outcome is unknown is not counted as delivered, and the row says it @cap:parler-par-canal-externe/moteur', () => {
  it('the answer step sent it and the platform never answered: the harness sends it again, under a key that says why', async () => {
    const job = await headJob('telegram');
    const text = `${UNCONFIRMED}: the answer the agent meant to send.`;
    const result = await run(job.id, [{ toolCalls: [send('answer', text), done()] }]);
    expect(result.status).toBe('completed');
    expect(await deliveriesOf(job.id)).toEqual([
      {
        channel: 'telegram',
        chatId: job.chatId,
        payload: text,
        idempotencyKey: `${answerDeliveryKey(job.id)}:resend_unconfirmed`,
      },
    ]);
    // The call's row keeps where the unconfirmed send was going.
    const [call] = await db
      .select({ toolOutput: toolCalls.toolOutput })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.toolName, 'telegram_send_message')));
    expect(JSON.parse(call!.toolOutput!)).toMatchObject({
      outcome: 'error',
      mayHaveDelivered: true,
      output: { attempt: { channel: 'telegram', chatId: job.chatId } },
    });
  });
});

// ─── The board: its summary goes through the same gate ───────────────────────

describe('a board answers through the same gate @cap:parler-par-canal-externe/moteur', () => {
  it('a board whose tasks are all done: one delivery on the chat that asked, the row says the answer key', async () => {
    const root = await headJob('telegram', { status: 'processing' });
    for (const [title, result] of [
      ['Task A', 'A is done'],
      ['Task B', 'B is done'],
    ] as const) {
      await db.insert(agentTasks).values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        rootJobId: root.id,
        title,
        status: 'done',
        result,
      });
    }
    await deliverCompletedRoots(db as never);
    const row = await rowOf(root.id);
    expect(row.status).toBe('completed');
    const rows = await deliveriesOf(root.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'telegram',
      chatId: root.chatId,
      idempotencyKey: answerDeliveryKey(root.id),
    });
    // No model answers in this test: the summary falls back to the compiled result, said by code.
    expect(rows[0]!.payload).toBe(row.result);
  });
});
