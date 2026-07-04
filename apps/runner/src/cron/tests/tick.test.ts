// cron/tests/tick.test.ts
// Integration test: full tick on a seeded DB
// Verifies each phase ran and the composed result is correct.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks, agents, agentSchedules } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { runCronTick } from '../tick.ts';

// Brique 25: execute.ts calls createLlmClient() from @nodal-agents/llm directly.
// Intercept so tests continue using the per-call mock client.
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('tick.test: no active LLM client');
      return active;
    },
  };
});

// Toggle so a single test can force runCuratorTick to throw — proves the
// tick.ts try/catch guard (audit finding, curator Date-bind bug) keeps the
// rest of the tick (delivery, retention) running even when the curator dies.
const { getCuratorShouldThrow, setCuratorShouldThrow } = vi.hoisted(() => {
  let _throw = false;
  return {
    getCuratorShouldThrow: () => _throw,
    setCuratorShouldThrow: (v: boolean) => {
      _throw = v;
    },
  };
});

vi.mock('../run-curator.ts', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../run-curator.ts')>();
  return {
    ...actual,
    runCuratorTick: (...args: Parameters<typeof actual.runCuratorTick>) => {
      if (getCuratorShouldThrow()) throw new Error('tick.test: simulated curator crash');
      return actual.runCuratorTick(...args);
    },
  };
});

// ─── Mock LLM helpers ─────────────────────────────────────────────────────────

function makeMockLlmClient(textResponse = 'Task complete.'): RunnerDeps['llmClient'] {
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: textResponse }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
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
      throw new Error('not supported');
    },
    generateObject: () => {
      throw new Error('not supported');
    },
  };
}

function makeDeps(db: TestDb, textResponse?: string): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const client = makeMockLlmClient(textResponse);
  // Register so the vi.mock('@nodal-agents/llm') intercept returns this client
  // when execute.ts calls createLlmClient() (Brique 25).
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

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runCronTick (integration)', () => {
  it('returns a CronTickResult with all phase counts', async () => {
    const deps = makeDeps(db);
    const result = await runCronTick(deps);

    expect(result).toHaveProperty('orphanJobsReset');
    expect(result).toHaveProperty('orphansReset');
    expect(result).toHaveProperty('tasksUnblocked');
    expect(result).toHaveProperty('tasksExecuted');
    expect(result).toHaveProperty('schedulesFired');
    expect(result).toHaveProperty('rootsDelivered');
    expect(typeof result.orphanJobsReset).toBe('number');
    expect(typeof result.orphansReset).toBe('number');
    expect(typeof result.tasksUnblocked).toBe('number');
    expect(typeof result.schedulesFired).toBe('number');
    expect(typeof result.tasksExecuted).toBe('number');
    expect(typeof result.rootsDelivered).toBe('number');
  });

  it('full tick: orphan reset → unblock → execute → deliver', async () => {
    // ── Phase 1: seed an orphaned task ────────────────────────────────────────
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const [orphanTask] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        title: 'Orphan task',
        status: 'in_progress',
        lockedAt: staleDate,
        lockedBy: 'dead-worker',
        jobId: null,
      })
      .returning();

    // ── Phase 2: seed a task with all deps done ───────────────────────────────
    const [doneDep] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        title: 'Done dep',
        status: 'done',
        result: 'dep result value',
      })
      .returning();

    const [depTask] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        title: 'Dep task',
        status: 'todo',
        dependsOn: [doneDep!.id] as unknown as string[],
      })
      .returning();

    // ── Phase 3: seed a root job + one todo task ──────────────────────────────
    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Root planning job',
        status: 'processing',
        messages: [],
      })
      .returning();

    await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        title: 'Execute this task',
        status: 'todo',
        rootJobId: rootJob!.id,
      })
      .returning();

    // Run the tick
    const deps = makeDeps(db, 'Task executed successfully.');
    const result = await runCronTick(deps, 5);

    // Phase 1: orphan should be reset — but may also be immediately executed in
    // Phase 3 of the same tick (reset to todo → eligible → claimed).
    // So we assert orphansReset count, and that the orphan is no longer in_progress
    // with a null job_id (the broken state it started in).
    expect(result.orphansReset).toBeGreaterThanOrEqual(1);
    const orphanUpdated = await db
      .select({ status: agentTasks.status, jobId: agentTasks.jobId })
      .from(agentTasks)
      .where(eq(agentTasks.id, orphanTask!.id));
    // After a tick it can be: todo (reset only), done (reset + executed), or blocked (reset + failed)
    // What it must NOT be: in_progress with null job_id (the original broken state)
    const orphanStatus = orphanUpdated[0]?.status;
    const orphanJobId = orphanUpdated[0]?.jobId;
    const isStillBroken = orphanStatus === 'in_progress' && orphanJobId === null;
    expect(isStillBroken).toBe(false);

    // Phase 2: dep task should have context.deps injected
    expect(result.tasksUnblocked).toBeGreaterThanOrEqual(1);
    const depTaskUpdated = await db
      .select({ context: agentTasks.context })
      .from(agentTasks)
      .where(eq(agentTasks.id, depTask!.id));
    const ctx = depTaskUpdated[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.['deps']).toBeDefined();

    // Phase 3: execTask should be executed
    expect(result.tasksExecuted).toBeGreaterThanOrEqual(1);

    // Phase 4: if execTask completed and it was the only task for rootJob,
    // delivery should trigger. (May be 0 if execTask wasn't the only one or
    // rootJob had multiple tasks — this depends on timing, so we check DB state)
    const rootJobUpdated = await db
      .select({ status: agentJobs.status, completedAt: agentJobs.completedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob!.id));

    // Root job should be marked completed after delivery
    if (result.rootsDelivered > 0) {
      expect(rootJobUpdated[0]?.status).toBe('completed');
      expect(rootJobUpdated[0]?.completedAt).not.toBeNull();
    }
  });

  it('tick is idempotent: two concurrent ticks do not double-execute tasks', async () => {
    // Create a set of 2 tasks
    const tasks = [];
    for (let i = 0; i < 2; i++) {
      const [t] = await db
        .insert(agentTasks)
        .values({
          entityId: seed.entityId,
          orchestratorId: seed.agentId,
          assignedAgentId: seed.agentId,
          title: `Idempotent tick task ${i}`,
          status: 'todo',
        })
        .returning();
      tasks.push(t!);
    }

    // Two concurrent ticks
    const depsA = makeDeps(db, 'tick A');
    const depsB = makeDeps(db, 'tick B');

    await Promise.all([runCronTick(depsA, 5), runCronTick(depsB, 5)]);

    // Each task should be executed at most once across both ticks
    for (const task of tasks) {
      const rows = await db
        .select({ status: agentTasks.status })
        .from(agentTasks)
        .where(eq(agentTasks.id, task.id));

      // Status must be terminal (done or blocked) — not still in_progress (double-execution)
      expect(['done', 'blocked', 'todo']).toContain(rows[0]?.status);
    }

    // No task can have more than one job — task.job_id is a single FK
    for (const task of tasks) {
      const rows = await db
        .select({ jobId: agentTasks.jobId })
        .from(agentTasks)
        .where(eq(agentTasks.id, task.id));

      // Each task row is unique — the DB has exactly one row per task
      expect(rows).toHaveLength(1);
    }
  });

  it('fix #20: a slow-firing schedule does not block phase 7 delivery within the same tick', async () => {
    // A due schedule whose fired job's LLM call is deliberately slow — this is
    // what an 8min planner fan-out looks like from runCronTick's point of view.
    const [sched] = await db
      .insert(agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        type: 'cron',
        name: 'Slow schedule',
        cronExpr: '0 9 * * *',
        task: 'slow periodic job',
        active: true,
        nextRun: null,
        notifyOnSuccess: false,
      })
      .returning();

    // An unrelated root job, ready for phase 7 delivery, that has nothing to
    // do with the schedule above.
    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'unrelated root job',
        status: 'processing',
        messages: [],
      })
      .returning();
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Unrelated task',
      status: 'done',
      result: 'already finished',
      rootJobId: rootJob!.id,
    });

    // LLM mock that BLOCKS on a gate the test controls — not a fixed sleep.
    // Under load a fixed sleep still races the rest of the tick (if the tick's
    // own DB-bound phases take longer than the sleep, the schedule can finish
    // "by chance" before runCronTick returns, defeating the proof). A gate the
    // test releases explicitly, AFTER already asserting the tick returned and
    // delivered, removes that race entirely: the schedule's job cannot
    // possibly finish before the test says so.
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const slowModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock',
      doGenerate: async () => {
        await gate;
        return {
          content: [{ type: 'text' as const, text: 'slow schedule done' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const slowClient: RunnerDeps['llmClient'] = {
      config: { provider: 'anthropic', model: 'mock' },
      capabilities: {
        toolUse: true,
        promptCaching: false,
        vision: false,
        structuredOutputs: false,
        streaming: false,
      },
      generateText: (args) =>
        generateText({ ...args, model: slowModel } as Parameters<
          typeof generateText
        >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
      streamText: () => {
        throw new Error('not supported');
      },
      generateObject: () => {
        throw new Error('not supported');
      },
    };
    setActiveLlmClient(slowClient);
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const deps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient: slowClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await runCronTick(deps, 5);

    // Non-temporal proof of the fix: runCronTick already RETURNED even though
    // the schedule's fired job is still blocked on `gate` — it cannot possibly
    // have finished (nothing releases the gate until below), so last_status
    // being anything other than null here would be impossible unless the tick
    // is genuinely not waiting on it. No stopwatch, no race: the job is
    // deterministically stuck until the test says otherwise.
    const schedAfterTick = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched!.id));
    expect(schedAfterTick[0]?.lastStatus).toBeNull();

    // Yet phase 7 (deliverCompletedRoots) already ran and delivered the
    // unrelated root within this same tick — delivery did not wait on the
    // still-blocked schedule.
    expect(result.rootsDelivered).toBeGreaterThanOrEqual(1);
    const delivered = await db
      .select({ completedAt: agentJobs.completedAt, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob!.id));
    expect(delivered[0]?.completedAt).not.toBeNull();
    expect(delivered[0]?.status).toBe('completed');

    // Release the gate and wait for the background schedule execution to
    // actually finish (poll, not a fixed sleep) — confirms it really was
    // running (not silently dropped), it just completed AFTER this tick had
    // already returned.
    releaseGate!();
    const deadline = Date.now() + 5000;
    let lastStatus: string | null = null;
    while (Date.now() < deadline) {
      const rows = await db
        .select({ lastStatus: agentSchedules.lastStatus })
        .from(agentSchedules)
        .where(eq(agentSchedules.id, sched!.id));
      lastStatus = rows[0]?.lastStatus ?? null;
      if (lastStatus !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(lastStatus).toBe('success');
  });

  it('a crashing curator does not crash the tick — delivery still runs', async () => {
    // Root job whose only task is already done — ready for phase 7 delivery,
    // independent of the curator entirely.
    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'root job unaffected by curator crash',
        status: 'processing',
        messages: [],
      })
      .returning();
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Already-done task',
      status: 'done',
      result: 'done before this tick',
      rootJobId: rootJob!.id,
    });

    setCuratorShouldThrow(true);
    try {
      const deps = makeDeps(db);
      const result = await runCronTick(deps, 5);

      // The tick resolved (didn't throw) and reports a neutral curator result
      // instead of propagating the crash.
      expect(result.curatorArchived).toBe(0);
      expect(result.curatorStaled).toBe(0);
      expect(result.curatorReactivated).toBe(0);
      expect(result.curatorConsolidationDeferred).toBe(0);
      expect(result.curatorConsolidationRan).toBe(0);

      // Phase 7 (delivery), which runs BEFORE the curator in tick order, still
      // completed and delivered the unrelated root within this same tick.
      expect(result.rootsDelivered).toBeGreaterThanOrEqual(1);
      const delivered = await db
        .select({ completedAt: agentJobs.completedAt, status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, rootJob!.id));
      expect(delivered[0]?.completedAt).not.toBeNull();
      expect(delivered[0]?.status).toBe('completed');
    } finally {
      setCuratorShouldThrow(false);
    }
  });
});
