// execute.test.ts — full E2E job loop with mocked LLM, asserts each transition
// Tests:
//   - pending → processing → completed on return_result
//   - anti-loop: 51 tool_use blocks → tool_call_limit_exceeded
//   - tool whitelist violation → whitelist_violation:tool_name
//   - awaiting_approval does NOT bump chain_count

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  approvalRequests,
  approvalRules,
  agentMemory,
  chatMessages,
  conversations,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { DeliveryError } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Module-level mock registry ───────────────────────────────────────────────
// Approval-gate regression imports (used in the approval-gate describe block below)
// execute.ts calls createLlmClient() directly (Brique 25: no env fallback).
// We intercept that call here and forward to the per-test mock client.
// vi.hoisted ensures the factory runs before module imports are resolved.
const { sendTelegramMessageMock, getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    sendTelegramMessageMock: vi.fn().mockResolvedValue({ messageId: 999 }),
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    sendTelegramMessage: sendTelegramMessageMock,
  };
});

// Intercept createLlmClient called by execute.ts so it returns the per-test mock.
// createEmbeddingClient and all other exports are passed through unchanged.
vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active)
        throw new Error('execute.test: no active LLM client set — call setActiveLlmClient() first');
      return active;
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockLlmClient(
  responses: Array<{
    text?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  }>,
): RunnerDeps['llmClient'] {
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
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: JSON.stringify(tc.args),
          });
        }
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
      vision: false,
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

async function createTestJob(db: TestDb, seed: Awaited<ReturnType<typeof seedMinimal>>) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Run a test task',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();

  if (!job) throw new Error('Failed to create test job');
  return job;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Make the agent a worker role (not orchestrator) so whitelist logic uses registry
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true }) // systemAgent = gets always-on tools
    .where(eq(agents.id, seed.agentId));
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);

  // Register the mock client so the vi.mock('@nodal-agents/llm') intercept returns it
  // when execute.ts calls createLlmClient() for this test (Brique 25).
  setActiveLlmClient(llmClient);

  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

describe('executeJob', () => {
  it('returns already_handled when job status is not pending/processing', async () => {
    const job = await createTestJob(db, seed);

    // Set to completed
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, job.id));

    const llmClient = makeMockLlmClient([]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('already_handled');
  });

  it('returns failed with job_not_found for nonexistent jobId', async () => {
    const llmClient = makeMockLlmClient([]);
    const result = await executeJob(
      '00000000-0000-0000-0000-000000000000' as JobId,
      makeDeps(llmClient),
      testEnv,
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('job_not_found');
    }
  });

  it('completes when LLM returns text only (no tools)', async () => {
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([{ text: 'Here is my answer to the task.' }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Verify DB row, including token usage / turn / duration persisted on completion
    const rows = await db
      .select({
        status: agentJobs.status,
        result: agentJobs.result,
        inputTokens: agentJobs.inputTokens,
        outputTokens: agentJobs.outputTokens,
        turn: agentJobs.turn,
        totalDurationMs: agentJobs.totalDurationMs,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toBe('Here is my answer to the task.');
    expect(rows[0]?.inputTokens).toBe(10);
    expect(rows[0]?.outputTokens).toBe(5);
    expect(rows[0]?.turn).toBe(1); // single LLM call → turn 1
    // Wall-clock timer: should have elapsed time (>= 0, often > 0). On very
    // fast runs Date.now() can resolve to the same ms, so assert non-null.
    expect(rows[0]?.totalDurationMs).not.toBeNull();
    expect(rows[0]?.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('integration: agent with telegramBotToken sends via telegram_send_message tool (outbound tool path)', async () => {
    // Set the seeded agent's telegramBotToken so telegram_send_message is injected
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Say hi on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram test job');

    // LLM calls telegram_send_message (omitting chatId — falls back to job.chatId)
    // then return_result to finish (Brique 33: status-only, no text)
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: 'hi' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');

    // Assert sendTelegramMessage was called with the real args (not a call count)
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'hi',
      botToken: 'fake-token',
    });

    // Clean up token so other tests aren't affected
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Anti-spam guard: consecutive delivery-only turns ─────────────────────

  it('anti-spam: caps consecutive delivery-only turns at maxConsecutiveDeliveryTurns and fails loud', async () => {
    // Regression for live incident job 9bbdbfd7 (2026-05-29): the agent emitted
    // 11 filler/emoji telegram_send_message turns in a row, never calling
    // return_result, spamming the user. The guard must cut it off.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [spamJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!spamJob) throw new Error('Failed to create spam test job');

    // Every turn is a single telegram_send_message and the LLM NEVER calls
    // return_result. Distinct toolCallIds keep the message structure valid
    // across turns. Six turns offered; the guard (default 3) must stop earlier.
    const deliveryOnly = (i: number) => ({
      toolCalls: [
        {
          toolCallId: `tc-spam-${i}`,
          toolName: 'telegram_send_message',
          args: { text: `msg ${i}` },
        },
      ],
    });
    const llmClient = makeMockLlmClient([
      deliveryOnly(1),
      deliveryOnly(2),
      deliveryOnly(3),
      deliveryOnly(4),
      deliveryOnly(5),
      deliveryOnly(6),
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(spamJob.id as JobId, makeDeps(llmClient), testEnv);

    // Guard fired: job failed loud with the dedicated code (invariant 4).
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('delivery_spam_guard');
    }

    // Real effect asserted (not a call count of the guard): the user received
    // at most maxConsecutiveDeliveryTurns (3) messages, NOT all 6 — the 4th
    // turn's send was blocked BEFORE execution.
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(3);
    expect(sendTelegramMessageMock).toHaveBeenLastCalledWith({
      chatId: '12345',
      text: 'msg 3',
      botToken: 'fake-token',
    });

    // DB row reflects the loud failure.
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, spamJob.id));
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('delivery_spam_guard');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Delivery guard: Telegram job must deliver before completing ──────────

  it('delivery guard: plain-text reply on a Telegram job is re-prompted, then delivered via the tool', async () => {
    // Regression for live incident job 5d84d72e (2026-05-29): the agent answered
    // in plain assistant text (no tool call) so nothing reached Telegram. The
    // guard must re-prompt and force a real telegram_send_message.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create delivery test job');

    // Turn 1: plain text, NO tool calls (the slip). Turn 2 (after nudge):
    // telegram_send_message + return_result (the correction).
    const llmClient = makeMockLlmClient([
      { text: 'Voici ma réponse en texte brut, non livrée.' },
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: 'la vraie réponse' },
          },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // Real effect: the reply WAS delivered (once), with the right args.
    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'la vraie réponse',
      botToken: 'fake-token',
    });

    // The nudge forced a second turn (turn 1 = slip, turn 2 = delivery).
    const rows = await db
      .select({ status: agentJobs.status, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.turn).toBe(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('cron confirmation: a cron job WITH a chatId (notify_on_success) forces the agent to deliver a confirmation', async () => {
    // notify_on_success opt-in: the cron tick sets chat_id, which makes the
    // runner hold a 'cron' job to the same delivery bar as Telegram — the agent
    // must send the user a confirmation before completing.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: '12345',
        task: 'Nettoyage quotidien',
        status: 'pending',
        messages: [{ role: 'user', content: 'Nettoyage quotidien' }],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create cron-notify test job');

    // Turn 1: the agent tries to finish WITHOUT confirming → must be nudged.
    // Turn 2: it sends the confirmation, then finishes.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: '✅ Nettoyage quotidien terminé.' },
          },
          { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    // The confirmation actually reached the user (real args, not a call count).
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: '✅ Nettoyage quotidien terminé.',
      botToken: 'fake-token',
    });

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('cron silence: a cron job WITHOUT a chatId (notify_on_success off) completes silently — no forced delivery', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: null, // notify_on_success was off → no delivery target
        task: 'Maintenance silencieuse',
        status: 'pending',
        messages: [{ role: 'user', content: 'Maintenance silencieuse' }],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create cron-silent test job');

    // The agent finishes immediately. With no chatId, the runner must NOT force
    // a delivery — the job completes silently.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Conversation-first chat: runChatTurn never creates a job ─────────────

  it('runChatTurn: replies in text, persists 2 chat_messages + titles the conversation, and creates ZERO agent_jobs', async () => {
    const jobsBefore = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));

    // A conversation must exist first (the sidebar entry).
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    const llmClient = makeMockLlmClient([{ text: 'Salut Quentin, je suis là.' }]);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'salut',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toContain('Salut Quentin');

    // The conversation turn is persisted in chat_messages (user + assistant).
    const msgs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    expect(msgs.length).toBe(2);
    expect(msgs.some((m) => m.role === 'user' && m.content === 'salut')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant' && (m.content?.length ?? 0) > 0)).toBe(true);

    // The first message auto-titles the conversation.
    const [titled] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(titled?.title).toBe('salut');

    // Crucially: NO agent_jobs row was created — chat is conversation, not a job.
    const jobsAfter = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    expect(jobsAfter.length).toBe(jobsBefore.length);
  });

  it('delivery guard: persistent plain-text on a Telegram job fails loud (telegram_not_delivered), nothing sent', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create delivery-fail test job');

    // The model never uses the tool — every turn is plain text.
    const llmClient = makeMockLlmClient([{ text: 'texte brut, encore et toujours' }]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('telegram_not_delivered');
    }
    // Nothing was ever delivered to the user.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('telegram_not_delivered');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('delivery guard: return_result without any send on a Telegram job is re-prompted, then delivered', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create return_result-only test job');

    // Turn 1: return_result ALONE (no prior send). Turn 2: deliver + return_result.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'enfin livré' } },
          { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'enfin livré',
      botToken: 'fake-token',
    });
    const rows = await db
      .select({ turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.turn).toBe(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('delivery guard: recommended one-turn pattern [telegram_send_message, return_result] completes with no nudge', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create one-turn test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'pile poil' } },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    // No nudge: the whole job is a single turn.
    const rows = await db
      .select({ turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.turn).toBe(1);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Brique 18.6: sibling-tool-error guard ────────────────────────────────

  it('Brique 18.6: tool error in same turn as return_result blocks finalization, LLM gets fresh turn with error', async () => {
    // Set telegramBotToken so the tool is whitelisted
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    // channel: 'api', chatId: null → telegram_send_message throws telegram_no_recipient
    // (no explicit chatId in LLM args, no job chatId fallback)
    const [guardJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'Send telegram message',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!guardJob) throw new Error('Failed to create guard test job');

    // Turn 1: [telegram_send_message (will throw telegram_no_recipient), return_result]
    // Turn 2: [return_result with status='blocked'] — after seeing the error
    // Brique 33: return_result is status-only, no text
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'foo' } },
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr2',
            toolName: 'return_result',
            args: { status: 'blocked' },
          },
        ],
      },
    ]);

    // sendTelegramMessageMock is NOT mocked to throw here — the tool's own
    // validation fires before the API call (chatId is null → telegram_no_recipient)
    sendTelegramMessageMock.mockClear();
    const result = await executeJob(guardJob.id as JobId, makeDeps(llmClient), testEnv);

    // Job completes on turn 2, not turn 1
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, guardJob.id));

    // LLM was called twice (turn === 2, not 1)
    expect(rows[0]?.turn).toBe(2);
    // Brique 33: result is empty because no dashboard_publish was called.
    // Guard still forced a second turn — that is the invariant being tested here.
    expect(rows[0]?.status).toBe('completed');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 18.6: tool error WITHOUT return_result in same turn → loop continues unchanged (regression guard)', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [loopJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Send telegram message with retry',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!loopJob) throw new Error('Failed to create loop regression job');

    // First call throws, subsequent calls succeed
    sendTelegramMessageMock.mockClear();
    sendTelegramMessageMock.mockImplementationOnce(() => {
      throw new DeliveryError('telegram_rate_limited', 'Rate limited');
    });
    // Remaining calls use the default resolved mock (messageId: 999)

    // Turn 1: telegram_send_message only (no return_result) — mock throws once
    // Turn 2: telegram_send_message again — mock succeeds
    // Turn 3: return_result — finalize (Brique 33: status-only)
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg1', toolName: 'telegram_send_message', args: { text: 'first' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-tg2', toolName: 'telegram_send_message', args: { text: 'retry' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(loopJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Brique 33: result is empty — no dashboard_publish was called. The Telegram
    // delivery already happened via telegram_send_message, which is the correct path.
    // sendTelegramMessage called exactly twice: once errored (turn 1), once succeeded (turn 2)
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 18.6: tool success + return_result same turn → nominal finalization (regression guard)', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [happyJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Send and finalize',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!happyJob) throw new Error('Failed to create happy path job');

    // sendTelegramMessageMock resolves normally
    sendTelegramMessageMock.mockClear();
    sendTelegramMessageMock.mockResolvedValue({ messageId: 1 });

    // Single turn: [telegram_send_message (succeeds), return_result]
    // Brique 33: return_result is status-only; result column stays empty
    // because no dashboard_publish was called (delivery happened to Telegram).
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'hi' } },
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(happyJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ result: agentJobs.result, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, happyJob.id));

    // Delivery went to Telegram, not dashboard → result column stays null/empty
    expect(rows[0]?.result ?? '').toBe('');
    // LLM called only once — guard must NOT have triggered
    expect(rows[0]?.turn).toBe(1);
    // sendTelegramMessage called exactly once with correct args
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'hi',
      botToken: 'fake-token',
    });

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('accumulates token usage across multiple LLM turns', async () => {
    const job = await createTestJob(db, seed);

    // Two-turn scenario: first calls save_memory, second returns final text.
    // Mock returns 10/5 per call → expected 20/10 totals after 2 calls.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-1',
            toolName: 'save_memory',
            args: { fact: 'remembered', category: 'context' },
          },
        ],
      },
      { text: 'Done.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({
        inputTokens: agentJobs.inputTokens,
        outputTokens: agentJobs.outputTokens,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.inputTokens).toBe(20);
    expect(rows[0]?.outputTokens).toBe(10);
    expect(rows[0]?.turn).toBe(2); // two LLM calls → turn 2
  });

  it('completes when LLM calls dashboard_publish + return_result (Brique 33)', async () => {
    // Brique 33: return_result is status-only. The dashboard's `result` column
    // is populated by dashboard_publish (a delivery tool with a side-effect that
    // updates agent_jobs.result). When return_result fires alone with no prior
    // delivery tool, agent_jobs.result stays empty.
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-pub',
            toolName: 'dashboard_publish',
            args: { text: 'Task is done!' },
          },
          {
            toolCallId: 'tc-1',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('completed');
    // dashboard_publish's side-effect populated result; completeJob preserves it
    // (finalResult is '' from return_result, so completeJob doesn't overwrite).
    expect(rows[0]?.result).toBe('Task is done!');

    // Regression for the silent delegation-result loss bug: ExecuteJobResult.result
    // must carry the dashboard_publish text (not '') so resumeDelegated can inject
    // it into the parent's tool-result for assign_<sub>. Pre-fix, the runner
    // returned result:'' here and the parent orchestrator hallucinated answers
    // because it never saw what the sub-agent produced.
    if (result.status === 'completed') {
      expect(result.result).toBe('Task is done!');
    }
  });

  it('fails with no_tool_calls_no_text after exhausting empty-turn retries', async () => {
    const job = await createTestJob(db, seed);

    // The mock repeats its last response, so every attempt (initial + 2
    // retries) is empty → the retry budget is exhausted and the job fails loud.
    const llmClient = makeMockLlmClient([{ text: '', toolCalls: [] }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no_tool_calls_no_text');
    }
  });

  it('retries an empty LLM turn and completes when the retry succeeds', async () => {
    const job = await createTestJob(db, seed);

    // Turn 1: empty response (transient model glitch). The retry re-calls the
    // LLM, which this time returns text → the job recovers and completes
    // instead of hard-failing. Regression for job beb3a4b9 (2026-05-20).
    const llmClient = makeMockLlmClient([
      { text: '', toolCalls: [] },
      { text: 'Recovered answer after the empty turn.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toBe('Recovered answer after the empty turn.');
    }

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toBe('Recovered answer after the empty turn.');
  });

  it('recovers on the last allowed retry (2 empty turns then success)', async () => {
    const job = await createTestJob(db, seed);

    // Initial attempt + 2 retries = 3 LLM calls. Two empty turns then a
    // success on the third call still completes the job — proves the budget
    // boundary recovers rather than failing one retry short.
    const llmClient = makeMockLlmClient([
      { text: '', toolCalls: [] },
      { text: '', toolCalls: [] },
      { text: 'Recovered on the final retry.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toBe('Recovered on the final retry.');
    }
  });

  // ─── Transcript checkpoint (regression for the 9-turns-lost bug) ───────────
  // Job 8b66b21d (2026-05-17) ran 9 successful turns of CMB research then
  // crashed on the 10th LLM call. Because the catch path's failJob doesn't
  // touch `messages` and saveCheckpoint only fired on delegation/approval,
  // the entire 9-turn transcript was lost — DB stored just the user task.
  // Fix: saveCheckpoint at the end of every loop iteration (execute.ts:927+).

  it('persists per-turn checkpoint so a later crash preserves prior turns in DB', async () => {
    const job = await createTestJob(db, seed);

    // Two clean turns (save_memory) then empty LLM responses: turn 3 is empty
    // and the 2 retries (turns 4 & 5) are empty too → the job fails with
    // no_tool_calls_no_text once the retry budget is exhausted.
    // After failure, DB must reflect what was done in turns 1 & 2.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-a',
            toolName: 'save_memory',
            args: { fact: 'turn-1 fact', category: 'context', importance: 3 },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-b',
            toolName: 'save_memory',
            args: { fact: 'turn-2 fact', category: 'context', importance: 3 },
          },
        ],
      },
      // Turn 3 onward: empty response (mock repeats it) → retried twice, then
      // the runner fails with no_tool_calls_no_text at turn 5.
      { text: '', toolCalls: [] },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no_tool_calls_no_text');
    }

    const rows = await db
      .select({
        messages: agentJobs.messages,
        toolsUsed: agentJobs.toolsUsed,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    // PRE-FIX behaviour: messages.length === 1 (only user task), toolsUsed=[],
    // even though turn>1. POST-FIX: messages reflects both completed turns
    // (user + asst1 + tool1 + asst2 + tool2 = 5 entries) and toolsUsed
    // includes save_memory. The empty turns 3-5 `continue` before the
    // end-of-loop checkpoint, so they never overwrite the turn-2 transcript.
    const persistedMessages = (rows[0]?.messages ?? []) as unknown[];
    expect(persistedMessages.length).toBe(5);
    expect(rows[0]?.toolsUsed).toContain('save_memory');
    expect(rows[0]?.turn).toBe(5);

    // Spot-check shape: messages[1] is the turn-1 assistant tool_call,
    // messages[2] is the turn-1 tool_result with the save_memory id.
    const m1 = persistedMessages[1] as { role: string; content: unknown };
    expect(m1.role).toBe('assistant');
    const m2 = persistedMessages[2] as { role: string; content: unknown };
    expect(m2.role).toBe('tool');
    const ids = Array.isArray(m2.content)
      ? (m2.content as Array<{ toolCallId?: string }>).map((b) => b.toolCallId)
      : [];
    expect(ids).toContain('tc-mem-a');
  });

  it('anti-loop: 51 tool_use blocks → tool_call_limit_exceeded', async () => {
    const job = await createTestJob(db, seed);

    // Build 51 save_memory calls (always-on tool so it's in whitelist)
    const manyToolCalls = Array.from({ length: 51 }, (_, i) => ({
      toolCallId: `tc-${i}`,
      toolName: 'save_memory',
      args: { fact: `fact ${i}`, category: 'context' },
    }));

    // LLM returns 51 tool calls, then text (never reached due to limit)
    const llmClient = makeMockLlmClient([{ toolCalls: manyToolCalls }, { text: 'done' }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('tool_call_limit_exceeded');
    }

    // Verify DB row
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('tool_call_limit_exceeded');
  });

  it('tool whitelist: calling unregistered tool fails with whitelist_violation', async () => {
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-evil',
            toolName: 'gmail_send', // Not in whitelist
            args: { to: 'hacker@evil.com', subject: 'pwned' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/whitelist_violation/);
    }
  });

  it('agent without telegramBotToken cannot invoke telegram_send_message (whitelist enforcement)', async () => {
    // Ensure the seeded agent has no telegramBotToken (should already be null by default,
    // but be explicit so order-of-execution doesn't matter)
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));

    const job = await createTestJob(db, seed);

    // LLM attempts to call telegram_send_message even though agent has no token configured
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg-leak',
            toolName: 'telegram_send_message',
            args: { text: 'leak attempt' },
          },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // telegram_send_message is not in the whitelist because telegramBotToken is null
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('whitelist_violation:telegram_send_message');
    }

    // sendTelegramMessage delivery function must NEVER have been called
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    // Verify DB row reflects the whitelist violation
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('whitelist_violation:telegram_send_message');
  });

  // ─── Brique 25: fail-loud on missing llmKeyId ──────────────────────────────

  it('Brique 25: agent without llmKeyId fails with agent_no_llm_configured', async () => {
    // Clear the llmKeyId that seedMinimal sets — simulates a legacy/misconfigured agent.
    await db.update(agents).set({ llmKeyId: null }).where(eq(agents.id, seed.agentId));

    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([{ text: 'Should never reach LLM' }]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('agent_no_llm_configured');
    }

    // Verify DB row reflects the error
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('agent_no_llm_configured');

    // Restore llmKeyId for subsequent tests
    await db.update(agents).set({ llmKeyId: seed.llmKeyId }).where(eq(agents.id, seed.agentId));
  });

  // ─── Brique 31: Job context block in system_prompt ────────────────────────────

  it('Brique 31: Telegram-channel job persists ## Job context block in system_prompt', async () => {
    // A real Telegram job belongs to an agent with a bot token; it must deliver
    // via telegram_send_message (the delivery guard now enforces this), so the
    // mock sends then finalizes — same single turn, system_prompt still persisted.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgContextJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Context test',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgContextJob) throw new Error('Failed to create telegram context test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg-ctx', toolName: 'telegram_send_message', args: { text: 'done' } },
          { toolCallId: 'tc-rr-ctx', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgContextJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Assert the persisted system_prompt contains the Job context block
    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, tgContextJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('## Job context');
    expect(sp).toContain('- origin: telegram');
    expect(sp).toContain('- telegram_chat_id: 12345');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 31: api-channel job system_prompt has Job context with origin=api, no telegram_chat_id', async () => {
    const [apiContextJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'API context test',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!apiContextJob) throw new Error('Failed to create api context test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-api',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(apiContextJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, apiContextJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('## Job context');
    expect(sp).toContain('- origin: api');
    expect(sp).not.toContain('telegram_chat_id');
  });

  // ─── Turn cap (invariant 8) ───────────────────────────────────────────────────

  it('turn cap: job that loops forever fails with turn_limit_exceeded after DEFAULT_LIMITS.maxTurns turns', async () => {
    // Import DEFAULT_LIMITS to drive the assertion — the test must not hardcode 50.
    const { DEFAULT_LIMITS } = await import('@nodal-agents/orchestration');

    const job = await createTestJob(db, seed);

    // LLM always returns save_memory (always-on, whitelisted) — never return_result.
    // We need 51 distinct entries (one per turn) with unique toolCallIds so the
    // message-structure validator doesn't reject duplicate_tool_use_id before the
    // turn cap fires. The last response is reused for turns beyond the array length
    // — so we generate DEFAULT_LIMITS.maxTurns + 1 entries, all unique.
    const loopingLlmClient = makeMockLlmClient(
      Array.from({ length: DEFAULT_LIMITS.maxTurns + 1 }, (_, i) => ({
        toolCalls: [
          {
            toolCallId: `tc-loop-${i}`,
            toolName: 'save_memory',
            args: { fact: `loop ${i}`, category: 'context' },
          },
        ],
      })),
    );

    const result = await executeJob(job.id as JobId, makeDeps(loopingLlmClient), testEnv);

    // Return value assertion
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('turn_limit_exceeded');
    }

    // Real DB row assertion — failJob must have persisted the error code
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('turn_limit_exceeded');
    // The cap check fires AFTER `turn += 1`, so when `turn > maxTurns` (51 > 50), the
    // persisted turn value is 51. The LLM was called exactly maxTurns (50) times.
    expect(rows[0]?.turn).toBe(DEFAULT_LIMITS.maxTurns + 1);
  });

  // ─── Tool-result truncation ───────────────────────────────────────────────────

  it('tool-result truncation: oversized string tool result is truncated before entering messages', async () => {
    const { z } = await import('zod');
    const { createEmbeddingClient } = await import('@nodal-agents/llm');
    const { LocalTrustProvider } = await import('@nodal-agents/auth');
    const { createToolRegistry: makeReg, registerBuiltins: regBuiltins } =
      await import('@nodal-agents/tools');

    const job = await createTestJob(db, seed);

    // Build a custom registry where save_memory (an always-on, whitelisted tool)
    // is overridden to return a very large string. This tests the truncation path
    // without FK issues — save_memory is in ALWAYS_ON_TOOLS so it's guaranteed
    // to be in the whitelist regardless of skill assignments.
    const customRegistry = makeReg();
    regBuiltins(customRegistry);

    const LARGE_OUTPUT = 'x'.repeat(200_000);
    // Override save_memory to return a large string for this test
    customRegistry.register({
      name: 'save_memory',
      description: 'save_memory override for truncation test',
      inputSchema: z.object({ fact: z.string(), category: z.string().optional() }),
      riskLevel: 'read' as const,
      execute: async () => LARGE_OUTPUT,
    });

    // LLM: turn 1 calls save_memory (returns 200K chars), turn 2 calls return_result
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem',
            toolName: 'save_memory',
            args: { fact: 'test fact', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    setActiveLlmClient(llmClient);
    const customDeps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry: customRegistry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await executeJob(job.id as JobId, customDeps, testEnv);
    expect(result.status).toBe('completed');

    // Real effect: messages persisted via completeJob must contain truncated tool result
    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    type OutputBlock = {
      type: string;
      toolName: string;
      output: { type: string; value: unknown };
    };
    type MsgRow = { role: string; content: unknown };
    const msgs = rows[0]?.messages as MsgRow[] | undefined;
    expect(msgs).toBeDefined();

    // Find the tool-result message (role: 'tool')
    const toolMsg = msgs?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const blocks = toolMsg?.content as OutputBlock[] | undefined;
    const memBlock = blocks?.find((b) => b.toolName === 'save_memory');
    expect(memBlock).toBeDefined();

    const val = memBlock?.output.value;
    expect(typeof val).toBe('string');
    // Must be truncated: well under the original 200K, <= 50_000 + ~120 marker overhead
    expect((val as string).length).toBeLessThanOrEqual(50_000 + 120);
    expect((val as string).length).not.toBe(200_000);
    // Must carry the explicit truncation marker so the model knows content was cut
    expect(val as string).toContain('[... truncated:');
  });

  it('tool-result truncation: oversized OBJECT tool result switches to text variant and is truncated', async () => {
    // Production case: firecrawl_scrape returns an OBJECT ({ url, markdown, ... }),
    // so truncation hits the JSON branch of toResultOutput — serialize, length
    // check, then switch to the 'text' variant (truncated JSON would not parse).
    const { z } = await import('zod');
    const { createEmbeddingClient } = await import('@nodal-agents/llm');
    const { LocalTrustProvider } = await import('@nodal-agents/auth');
    const { createToolRegistry: makeReg, registerBuiltins: regBuiltins } =
      await import('@nodal-agents/tools');

    const job = await createTestJob(db, seed);

    // Override save_memory (always-on, whitelisted) to return a large OBJECT.
    const customRegistry = makeReg();
    regBuiltins(customRegistry);

    const LARGE_MARKDOWN = 'x'.repeat(200_000);
    customRegistry.register({
      name: 'save_memory',
      description: 'save_memory override returning a large object for truncation test',
      inputSchema: z.object({ fact: z.string(), category: z.string().optional() }),
      riskLevel: 'read' as const,
      execute: async () => ({ url: 'http://example.com', markdown: LARGE_MARKDOWN }),
    });

    // LLM: turn 1 calls save_memory (returns big object), turn 2 calls return_result
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-obj',
            toolName: 'save_memory',
            args: { fact: 'test fact', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-obj', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    setActiveLlmClient(llmClient);
    const customDeps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry: customRegistry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await executeJob(job.id as JobId, customDeps, testEnv);
    expect(result.status).toBe('completed');

    // Real effect: messages persisted via completeJob must contain truncated tool result
    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    type OutputBlock = {
      type: string;
      toolName: string;
      output: { type: string; value: unknown };
    };
    type MsgRow = { role: string; content: unknown };
    const msgs = rows[0]?.messages as MsgRow[] | undefined;
    expect(msgs).toBeDefined();

    const toolMsg = msgs?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const blocks = toolMsg?.content as OutputBlock[] | undefined;
    const memBlock = blocks?.find((b) => b.toolName === 'save_memory');
    expect(memBlock).toBeDefined();

    // Oversized structured result must switch to the 'text' variant — a truncated
    // JSON string would not parse, so the discriminated union flips to 'text'.
    expect(memBlock?.output.type).toBe('text');

    const val = memBlock?.output.value;
    expect(typeof val).toBe('string');
    // The original serialized object is well over 200K chars; truncated result
    // must be <= 50_000 + ~120 marker overhead and far under the original.
    const originalSerializedLen = JSON.stringify({
      url: 'http://example.com',
      markdown: LARGE_MARKDOWN,
    }).length;
    expect((val as string).length).toBeLessThanOrEqual(50_000 + 120);
    expect((val as string).length).not.toBe(originalSerializedLen);
    // Must carry the explicit truncation marker so the model knows content was cut
    expect(val as string).toContain('[... truncated:');
  });

  // ─── chat_id semantics: explicit, no runtime fallback ────────────────────────
  // `agent_jobs.chat_id` is the single source of truth for Telegram-delivery
  // intent. The runner does NOT override a NULL chat_id at execute time using
  // agent.lastSeenChatIdTelegram — that would silently flip a deliberate "no
  // Telegram" (e.g. dashboard checkbox unticked) into "yes Telegram".
  // Job-creation sources (cron tick, sendTaskAction, telegram poller) are
  // each responsible for populating chat_id when delivery is wanted.

  it('NULL chat_id stays NULL in Job context, even when the agent has a last-seen Telegram chat', async () => {
    // Agent has been DM'd before — last-seen is populated.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '99887766' })
      .where(eq(agents.id, seed.agentId));

    // But this job has chat_id=null (e.g. dashboard send with checkbox unticked).
    const [optedOutJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'dashboard task without telegram delivery',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!optedOutJob) throw new Error('Failed to create opted-out job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-no-tg',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(optedOutJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, optedOutJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('- origin: api');
    // Critical: telegram_chat_id MUST NOT appear, despite the agent having a
    // last-seen chat. Otherwise the skill would instruct the LLM to deliver
    // when the user explicitly opted out.
    expect(sp).not.toContain('telegram_chat_id');
    expect(sp).not.toContain('99887766');

    // Cleanup so subsequent tests aren't affected.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });
});

// ─── Approval-gate regression tests ──────────────────────────────────────────
// Covers the three bugs fixed in feat/v4-root-agent:
//   Bug A: sibling tool_use blocks in the same turn as a gated tool got no
//          tool_result → invalid message structure on resume (unmatched_tool_use).
//   Bug B: injectApproval looked for block.result (string) but AI SDK v6 stores
//          the output under block.output → the replacement was a no-op.
//   Bug C: on resume execute.ts only injected [APPROVED] text, never actually
//          executed the tool.
//
// Gated tool: save_memory, which is in ALWAYS_ON_TOOLS → always in the
// whitelist regardless of skill assignments. Real side-effect: an agent_memory
// row in DB. We assert that row exists (approve path) or is absent (reject path)
// to prove real execution, not just a marker swap.

describe('executeJob — approval gate (Bugs A, B, C)', () => {
  // Fresh DB per suite so approval rules and memory rows don't bleed across tests.
  let approvalDb: TestDb;
  let approvalSeed: Awaited<ReturnType<typeof seedMinimal>>;

  beforeAll(async () => {
    const result = await spinUpTestDb();
    approvalDb = result.db;
    approvalSeed = await seedMinimal(approvalDb);

    // Worker role so the whitelist uses registry (not orchestrator paths).
    await approvalDb
      .update(agents)
      .set({ role: 'agent' })
      .where(eq(agents.id, approvalSeed.agentId));
  });

  function makeApprovalDeps(llmClient: ReturnType<typeof makeMockLlmClient>): RunnerDeps {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    setActiveLlmClient(llmClient);

    return {
      db: approvalDb as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };
  }

  async function createApprovalJob() {
    const [job] = await approvalDb
      .insert(agentJobs)
      .values({
        entityId: approvalSeed.entityId,
        agentId: approvalSeed.agentId,
        channel: 'api',
        task: 'Do the gated thing',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create approval test job');
    return job;
  }

  it('Bug A: two tools in same turn — gated save_memory + sibling save_memory → messages structurally valid', async () => {
    // Seed a require_approval rule for save_memory on this entity.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    // LLM emits two save_memory calls in one turn. First one needs approval (gated),
    // second is the sibling that must get a [DEFERRED] marker (not executed).
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-a',
            toolName: 'save_memory',
            args: { fact: 'gated fact A', category: 'context' },
          },
          {
            toolCallId: 'tc-sibling-a',
            toolName: 'save_memory',
            args: { fact: 'sibling fact A', category: 'context' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);

    // Job must suspend awaiting_approval.
    expect(result.status).toBe('awaiting_approval');

    // Load the saved messages from DB.
    const rows = await approvalDb
      .select({ messages: agentJobs.messages, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('awaiting_approval');

    type MsgShape = { role: string; content: unknown };
    type ToolCallBlock = { type: string; toolCallId: string };
    type ToolResultBlock = { type: string; toolCallId: string };

    const msgs = rows[0]?.messages as MsgShape[];
    expect(msgs).toBeDefined();

    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    const toolMsg = msgs.find((m) => m.role === 'tool');

    expect(assistantMsg).toBeDefined();
    expect(toolMsg).toBeDefined();

    const toolCallIds = (assistantMsg!.content as ToolCallBlock[])
      .filter((b) => b.type === 'tool-call')
      .map((b) => b.toolCallId);

    const toolResultIds = (toolMsg!.content as ToolResultBlock[])
      .filter((b) => b.type === 'tool-result')
      .map((b) => b.toolCallId);

    // Every tool_use id must have a matching tool_result id — Bug A fix.
    for (const id of toolCallIds) {
      expect(toolResultIds).toContain(id);
    }

    type ResultBlock = {
      type: string;
      toolCallId: string;
      output: { type: string; value: string };
    };

    // First tool got the [AWAITING_APPROVAL] marker.
    const gatedBlock = (toolMsg!.content as ResultBlock[]).find(
      (b) => b.toolCallId === 'tc-gated-a',
    );
    expect(gatedBlock?.output.value).toContain('[AWAITING_APPROVAL]');

    // Second tool (sibling) got the [DEFERRED] marker.
    const siblingBlock = (toolMsg!.content as ResultBlock[]).find(
      (b) => b.toolCallId === 'tc-sibling-a',
    );
    expect(siblingBlock?.output.value).toContain('[DEFERRED]');

    // Cleanup rule.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });

  it('Telegram heads-up: a gated tool on a Telegram job warns the user (via telegram_send_message) before suspending', async () => {
    // Regression for live incident job eeb2b587 (2026-05-31): a gated meta-tool
    // suspended the job in awaiting_approval with ZERO Telegram signal — the user
    // had no way to know an approval was waiting. The runner must give the agent
    // a bounded turn to tell the user, in its own voice via its own delivery tool,
    // THEN suspend.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });
    // telegramBotToken makes telegram_send_message available + marks the channel
    // tool-only, so the heads-up guard engages.
    await approvalDb
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, approvalSeed.agentId));

    const [tgJob] = await approvalDb
      .insert(agentJobs)
      .values({
        entityId: approvalSeed.entityId,
        agentId: approvalSeed.agentId,
        channel: 'telegram',
        chatId: '199791464',
        task: 'Mémorise un truc important',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram approval test job');

    // Turn 1: gated save_memory → gate fires.
    // Turn 2 (after the approval nudge): the agent tells the user on Telegram.
    const HEADS_UP = "J'ai lancé la mémorisation, j'attends ton approbation pour continuer.";
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-tg',
            toolName: 'save_memory',
            args: { fact: 'truc important', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-headsup', toolName: 'telegram_send_message', args: { text: HEADS_UP } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeApprovalDeps(llmClient), testEnv);

    // Job still suspends — the gate is unchanged, only the comms is added.
    expect(result.status).toBe('awaiting_approval');

    // The heads-up actually reached Telegram, with the real args (not a call count).
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '199791464',
      text: HEADS_UP,
      botToken: 'fake-token',
    });

    // And a pending approval_request was genuinely created for the gated tool.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, tgJob.id));
    expect(approvalRows.some((r) => r.toolName === 'save_memory' && r.status === 'pending')).toBe(
      true,
    );

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
    await approvalDb
      .update(agents)
      .set({ telegramBotToken: null })
      .where(eq(agents.id, approvalSeed.agentId));
  });

  it('Bug C: approve → save_memory ACTUALLY runs (agent_memory row created) and executed_at stamped', async () => {
    // Seed the require_approval rule for save_memory.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    // Unique fact string — used to assert the real DB row was created by
    // save_memory.execute() on resume (not by any earlier code path).
    const GATED_FACT = `approval-gate-test-fact-${Date.now()}`;

    // Turn 1: LLM emits save_memory → job suspends.
    // Turn 2 (after approval): LLM calls return_result to finish.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-b',
            toolName: 'save_memory',
            args: { fact: GATED_FACT, category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-b', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // First execution → suspends, save_memory NOT executed yet.
    const suspendResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // Confirm no agent_memory row exists yet for the unique fact.
    const memBefore = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, GATED_FACT));
    expect(memBefore.length).toBe(0);

    // Find the pending approval_requests row created by executeTool.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'save_memory' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();

    // Drive the approval through the real path: mark approved, set job back to pending.
    // This mirrors what approveRoute now does (it only records the decision + re-queues).
    await approvalDb
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await approvalDb
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // Resume — execute.ts step 11.7 executes the approved tool.
    const resumeResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // Core assertion (Bug C): save_memory.execute() ran → agent_memory row exists.
    // This is a REAL DB side-effect, not hand-seeded.
    const memAfter = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, GATED_FACT));
    expect(memAfter.length).toBeGreaterThan(0);

    // executed_at is stamped on the approval_requests row.
    const updatedApproval = await approvalDb
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(updatedApproval[0]?.executedAt).not.toBeNull();

    // The messages in DB must NOT contain [AWAITING_APPROVAL] — replaced with real output.
    const jobRow = await approvalDb
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
    let foundAwaiting = false;
    for (const tm of messages.filter((m) => m.role === 'tool')) {
      for (const block of tm.content as Array<{ output?: { value?: string } }>) {
        if (block.output?.value?.includes?.('[AWAITING_APPROVAL]')) foundAwaiting = true;
      }
    }
    expect(foundAwaiting).toBe(false);

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });

  it('rejection: rejected save_memory → [REJECTED] marker replaces [AWAITING_APPROVAL], NO memory row created', async () => {
    // Seed the require_approval rule.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    const REJECTED_FACT = `rejection-gate-test-fact-${Date.now()}`;

    // LLM: turn 1 emits save_memory, turn 2 (after rejection) calls return_result.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-c',
            toolName: 'save_memory',
            args: { fact: REJECTED_FACT, category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-c', toolName: 'return_result', args: { status: 'blocked' } },
        ],
      },
    ]);

    // First execution → suspends.
    const suspendResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // Find the pending approval_requests row.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'save_memory' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();

    // Reject the request.
    await approvalDb
      .update(approvalRequests)
      .set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: 'test', notes: 'Too risky' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await approvalDb
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // Resume.
    const resumeResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // save_memory.execute() must NOT have run — no agent_memory row for the fact.
    const memAfter = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, REJECTED_FACT));
    expect(memAfter.length).toBe(0);

    // executed_at is stamped even for rejections (marker was replaced, work is done).
    const updatedApproval = await approvalDb
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(updatedApproval[0]?.executedAt).not.toBeNull();

    // Messages must contain [REJECTED], NOT [AWAITING_APPROVAL].
    const jobRow = await approvalDb
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
    let foundRejected = false;
    let foundAwaiting = false;
    for (const tm of messages.filter((m) => m.role === 'tool')) {
      for (const block of tm.content as Array<{ output?: { value?: string } }>) {
        if (block.output?.value?.includes?.('[REJECTED]')) foundRejected = true;
        if (block.output?.value?.includes?.('[AWAITING_APPROVAL]')) foundAwaiting = true;
      }
    }
    expect(foundRejected).toBe(true);
    expect(foundAwaiting).toBe(false);

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });
});
