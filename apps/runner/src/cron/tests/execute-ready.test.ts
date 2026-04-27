// cron/tests/execute-ready.test.ts
// Acceptance criteria:
//   - task with no deps + assigned agent → claimed, job created, executed
//   - task with all deps done → eligible, claimed, executed
//   - task with unresolved deps → skipped (not claimed)
//   - concurrent calls: each task executed exactly once (idempotency)
//   - completed task → status set to done with result
//   - failed task → status set to blocked with error

import { describe, it, expect, beforeAll } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agentTasks, agents } from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import type { RunnerDeps } from '../../deps.ts';
import { executeReadyTasks } from '../execute-ready.ts';

// ─── Mock LLM helpers ─────────────────────────────────────────────────────────

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

function makeDeps(db: TestDb, llmResponses: Parameters<typeof makeMockLlmClient>[0]): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);

  return {
    db: db as RunnerDeps['db'],
    llmClient: makeMockLlmClient(llmResponses),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Make the seeded agent a worker (not orchestrator)
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function createTask(overrides: {
  status?: string;
  dependsOn?: string[];
  assignedAgentId?: string | null;
  rootJobId?: string | null;
}) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: overrides.assignedAgentId ?? seed.agentId,
      title: 'Execute test task',
      status: overrides.status ?? 'todo',
      dependsOn: (overrides.dependsOn ?? []) as unknown as string[],
      rootJobId: overrides.rootJobId ?? null,
    })
    .returning();
  return rows[0]!;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeReadyTasks', () => {
  it('claims and executes a task with no deps, marks it done', async () => {
    const task = await createTask({ status: 'todo', dependsOn: [] });

    const deps = makeDeps(db, [{ text: 'Task completed successfully.' }]);
    const count = await executeReadyTasks(db as RunnerDeps['db'], deps, 5);

    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentTasks.status, result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('done');
    expect(updated[0]?.result).toBe('Task completed successfully.');
  });

  it('creates a child job linking to the task', async () => {
    const rootJob = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'root task',
        status: 'pending',
        messages: [],
      })
      .returning();
    const rootJobId = rootJob[0]!.id;

    const task = await createTask({ rootJobId });

    const deps = makeDeps(db, [{ text: 'task done' }]);
    await executeReadyTasks(db as RunnerDeps['db'], deps, 5);

    // Verify task has a job_id set
    const updatedTask = await db
      .select({ jobId: agentTasks.jobId, status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updatedTask[0]?.status).toBe('done');
    // task.jobId is set to the created child job
    expect(updatedTask[0]?.jobId).not.toBeNull();
  });

  it('skips tasks with unresolved deps', async () => {
    const todoDep = await createTask({ status: 'todo' });
    const blockedTask = await createTask({ dependsOn: [todoDep.id] });

    const deps = makeDeps(db, [{ text: 'should not run' }]);
    await executeReadyTasks(db as RunnerDeps['db'], deps, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, blockedTask.id));

    expect(updated[0]?.status).toBe('todo');
  });

  it('executes task whose deps are done', async () => {
    const dep = await createTask({ status: 'done' });
    // We need to mark dep result manually
    await db
      .update(agentTasks)
      .set({ result: 'dep done result', status: 'done' })
      .where(eq(agentTasks.id, dep.id));

    const task = await createTask({ dependsOn: [dep.id] });

    const deps = makeDeps(db, [{ text: 'executed with dep context' }]);
    const count = await executeReadyTasks(db as RunnerDeps['db'], deps, 5);

    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('done');
  });

  it('marks task blocked when job fails', async () => {
    const task = await createTask({ status: 'todo' });

    // LLM returns empty response → no_tool_calls_no_text error → job fails
    const deps = makeDeps(db, [{ text: '', toolCalls: [] }]);
    await executeReadyTasks(db as RunnerDeps['db'], deps, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    // On failure, task → blocked
    expect(updated[0]?.status).toBe('blocked');
  });

  it('idempotency: two concurrent ticks claim each task exactly once', async () => {
    // Create two tasks
    const task1 = await createTask({ status: 'todo' });
    const task2 = await createTask({ status: 'todo' });

    // Run two concurrent ticks
    const depsA = makeDeps(db, [{ text: 'tick A result' }, { text: 'tick A result 2' }]);
    const depsB = makeDeps(db, [{ text: 'tick B result' }, { text: 'tick B result 2' }]);

    const [countA, countB] = await Promise.all([
      executeReadyTasks(db as RunnerDeps['db'], depsA, 5),
      executeReadyTasks(db as RunnerDeps['db'], depsB, 5),
    ]);

    // Total executions across both ticks should equal number of tasks (2)
    // Each task should be executed exactly once
    const total = countA + countB;
    expect(total).toBe(2);

    // Verify each task is in a terminal state (done or blocked) — not in_progress
    for (const taskId of [task1.id, task2.id]) {
      const rows = await db
        .select({ status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId));

      expect(['done', 'blocked']).toContain(rows[0]?.status);
    }
  });

  it('respects max limit', async () => {
    // Create 4 tasks
    for (let i = 0; i < 4; i++) {
      await createTask({ status: 'todo' });
    }

    const deps = makeDeps(db, [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }]);
    const count = await executeReadyTasks(db as RunnerDeps['db'], deps, 2);

    // max=2 so at most 2 tasks should be executed
    expect(count).toBeLessThanOrEqual(2);
  });
});
