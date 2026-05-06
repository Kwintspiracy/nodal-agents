// execute.test.ts — full E2E job loop with mocked LLM, asserts each transition
// Tests:
//   - pending → processing → completed on return_result
//   - anti-loop: 51 tool_use blocks → tool_call_limit_exceeded
//   - tool whitelist violation → whitelist_violation:tool_name
//   - awaiting_approval does NOT bump chain_count

import { describe, it, expect, beforeAll } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodalai/orchestration';

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

  it('persists a system prompt with a Delivery context block matching job.channel', async () => {
    // channel='telegram' → the persisted system prompt should mention Telegram
    // so the LLM does not hallucinate about a missing send tool.
    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Say hi via telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram test job');

    const llmClient = makeMockLlmClient([{ text: 'hi' }]);
    await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);

    const tgRows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, tgJob.id));
    expect(tgRows[0]?.systemPrompt).toContain('## Delivery context');
    expect(tgRows[0]?.systemPrompt).toContain('Telegram');

    // channel='cron' → the same code path with different wording
    const [cronJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        task: 'Periodic check',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!cronJob) throw new Error('Failed to create cron test job');

    const llmClientCron = makeMockLlmClient([{ text: 'ok' }]);
    await executeJob(cronJob.id as JobId, makeDeps(llmClientCron), testEnv);

    const cronRows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, cronJob.id));
    expect(cronRows[0]?.systemPrompt).toContain('## Delivery context');
    expect(cronRows[0]?.systemPrompt).toContain('automated run');
  });

  it('a delegated child inherits the ROOT job channel for Delivery context (not its own internal channel)', async () => {
    // Simulate delegation: parent has channel='telegram', child has channel='internal'
    // (the actual value the orchestration layer sets — see router/delegate.ts).
    // The child's Delivery context block must reflect the ROOT's channel,
    // otherwise the LLM thinks its reply goes nowhere user-facing.
    const [parentJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Delegate this',
        status: 'awaiting_delegation',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!parentJob) throw new Error('Failed to create parent job');

    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal', // what the orchestration layer assigns to delegated children
        task: 'Child task',
        status: 'pending',
        messages: [],
        chainCount: 0,
        parentJobId: parentJob.id,
        delegationDepth: 1,
      })
      .returning();
    if (!childJob) throw new Error('Failed to create child job');

    const llmClient = makeMockLlmClient([{ text: 'reply from child' }]);
    await executeJob(childJob.id as JobId, makeDeps(llmClient), testEnv);

    const childRows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, childJob.id));

    // The block must reference the root channel (telegram), not the child's internal label
    expect(childRows[0]?.systemPrompt).toContain('## Delivery context');
    expect(childRows[0]?.systemPrompt).toContain('Telegram');
    expect(childRows[0]?.systemPrompt).not.toContain('an internal record');
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

  it('completes when LLM calls return_result', async () => {
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'return_result',
            args: { status: 'success', summary: 'Task is done!' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toBe('Task is done!');
    }

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('completed');
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
});
