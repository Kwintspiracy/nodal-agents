// execute.test.ts — full E2E job loop with mocked LLM, asserts each transition
// Tests:
//   - pending → processing → completed on return_result
//   - anti-loop: 51 tool_use blocks → tool_call_limit_exceeded
//   - tool whitelist violation → whitelist_violation:tool_name
//   - awaiting_approval does NOT bump chain_count

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import { DeliveryError } from '@nodalai/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodalai/orchestration';

// ─── Module-level mock registry ───────────────────────────────────────────────
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

vi.mock('@nodalai/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodalai/delivery')>();
  return {
    ...actual,
    sendTelegramMessage: sendTelegramMessageMock,
  };
});

// Intercept createLlmClient called by execute.ts so it returns the per-test mock.
// createEmbeddingClient and all other exports are passed through unchanged.
vi.mock('@nodalai/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodalai/llm')>();
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

  const mockModel = new MockLanguageModelV1({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;

      const toolCallsRaw = response.toolCalls?.map((tc) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: JSON.stringify(tc.args),
      }));

      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: toolCallsRaw && toolCallsRaw.length > 0 ? 'tool-calls' : 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
        text: response.text ?? undefined,
        toolCalls: toolCallsRaw ?? [],
        content: response.text ? [{ type: 'text' as const, text: response.text }] : [],
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
      generateText({ ...args, model: mockModel }) as ReturnType<
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

  // Register the mock client so the vi.mock('@nodalai/llm') intercept returns it
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
  });

  it('fails with no_tool_calls_no_text when LLM returns empty response', async () => {
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([{ text: '', toolCalls: [] }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no_tool_calls_no_text');
    }
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
          {
            toolCallId: 'tc-rr-ctx',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
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

  // ─── chat_id fallback to agents.lastSeenChatIdTelegram ────────────────────────
  // The Telegram chat_id falls back to the agent's last-seen chat when the job
  // itself doesn't carry one (cron, dashboard without checkbox, etc.) so the
  // agent can always reach the user on Telegram by default.

  it('chat_id fallback: cron job inherits agents.lastSeenChatIdTelegram into system_prompt', async () => {
    // Set the agent's last-seen chat (simulates the inbound poller having
    // populated it on a prior DM).
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '99887766' })
      .where(eq(agents.id, seed.agentId));

    const [cronJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: null,
        task: 'cron task',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!cronJob) throw new Error('Failed to create cron fallback job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-cron-fallback',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(cronJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, cronJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('- origin: cron');
    expect(sp).toContain('- telegram_chat_id: 99887766');

    // Cleanup so subsequent tests aren't affected.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });

  it('chat_id explicit job.chatId wins over agents.lastSeenChatIdTelegram', async () => {
    // Both are set, but job.chatId must win (e.g. inbound poller writes a DM
    // from a different chat than the agent's last-seen).
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '99887766' })
      .where(eq(agents.id, seed.agentId));

    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '11112222', // explicit per-job chat
        task: 'inbound from a different chat',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create explicit-chat fallback job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-explicit',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, tgJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('- telegram_chat_id: 11112222');
    expect(sp).not.toContain('99887766');

    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });
});
