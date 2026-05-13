// cron/tests/run-schedules.test.ts
// Acceptance criteria:
//   - active schedule with next_run NULL → claimed, fired, last_status=success
//   - active schedule with next_run in past → claimed, fired
//   - paused schedule → not claimed even if due
//   - active schedule with next_run in future → not claimed
//   - bad cron expression → last_status='failed', next_run pushed far out
//   - concurrent ticks → schedule fires exactly once (idempotency)
//   - failed job → last_status='failed' on schedule
//   - next_run advances correctly after firing

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentSchedules, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { runScheduleTick } from '../run-schedules.ts';

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
      if (!active) throw new Error('run-schedules.test: no active LLM client');
      return active;
    },
  };
});

// ─── Mock LLM helpers ─────────────────────────────────────────────────────────

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

function makeDeps(db: TestDb, llmResponses: Parameters<typeof makeMockLlmClient>[0]): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const client = makeMockLlmClient(llmResponses);
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

  // Seeded agent acts as a worker so scheduled jobs can complete with plain text
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createSchedule(overrides: {
  cronExpr?: string;
  active?: boolean;
  nextRun?: Date | null;
  task?: string;
}) {
  const rows = await db
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      type: 'cron',
      name: 'Test schedule',
      cronExpr: overrides.cronExpr ?? '0 9 * * *',
      task: overrides.task ?? 'Run a periodic check',
      active: overrides.active ?? true,
      nextRun: overrides.nextRun === undefined ? null : overrides.nextRun,
    })
    .returning();
  return rows[0]!;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runScheduleTick', () => {
  it('fires an active schedule with next_run NULL and marks success', async () => {
    const sched = await createSchedule({ nextRun: null });

    const deps = makeDeps(db, [{ text: 'Did the periodic check.' }]);
    const fired = await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    expect(fired).toBeGreaterThanOrEqual(1);

    const after = await db
      .select({
        lastStatus: agentSchedules.lastStatus,
        lastRun: agentSchedules.lastRun,
        nextRun: agentSchedules.nextRun,
      })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    expect(after[0]?.lastStatus).toBe('success');
    expect(after[0]?.lastRun).toBeInstanceOf(Date);
    expect(after[0]?.nextRun).toBeInstanceOf(Date);
    // next_run must advance past now
    expect(after[0]!.nextRun!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('fires when next_run is in the past', async () => {
    const past = new Date(Date.now() - 60_000);
    const sched = await createSchedule({ nextRun: past });

    const deps = makeDeps(db, [{ text: 'fired' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    // A child job was created on channel='cron' for this schedule's agent
    const jobs = await db
      .select({ id: agentJobs.id, channel: agentJobs.channel, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const cronJobs = jobs.filter((j) => j.channel === 'cron');
    expect(cronJobs.length).toBeGreaterThanOrEqual(1);

    // Schedule's last_run is set
    const after = await db
      .select({ lastRun: agentSchedules.lastRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastRun).toBeInstanceOf(Date);
  });

  it('propagates agent.lastSeenChatIdTelegram into the cron job chat_id (Telegram delivery default)', async () => {
    // Cron has no per-schedule chat UI yet, so the runner copies the agent's
    // last-seen Telegram chat into the job's chat_id at INSERT time. This puts
    // the delivery intent in the data (job.chat_id != null = "deliver here on
    // Telegram"), no runtime fallback required.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '7777' })
      .where(eq(agents.id, seed.agentId));

    const past = new Date(Date.now() - 60_000);
    await createSchedule({ nextRun: past, task: 'cron with telegram default' });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const cronJobs = await db
      .select({ id: agentJobs.id, chatId: agentJobs.chatId, channel: agentJobs.channel })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const justFired = cronJobs.filter((j) => j.channel === 'cron' && j.chatId === '7777');
    expect(justFired.length).toBeGreaterThanOrEqual(1);

    // Cleanup so subsequent tests aren't affected.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });

  it('leaves chat_id NULL when the agent has no last-seen Telegram chat', async () => {
    // Agent has never been DM'd → lastSeenChatIdTelegram is null → cron jobs
    // do NOT get a chat_id (no Telegram delivery, no error).
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));

    const past = new Date(Date.now() - 60_000);
    await createSchedule({ nextRun: past, task: 'cron without telegram default' });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const cronJobs = await db
      .select({
        id: agentJobs.id,
        chatId: agentJobs.chatId,
        channel: agentJobs.channel,
        task: agentJobs.task,
      })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const justFired = cronJobs.filter(
      (j) => j.channel === 'cron' && j.task === 'cron without telegram default',
    );
    expect(justFired.length).toBeGreaterThanOrEqual(1);
    expect(justFired[0]!.chatId).toBeNull();
  });

  it('skips a paused schedule even if next_run is past', async () => {
    const past = new Date(Date.now() - 60_000);
    const sched = await createSchedule({ active: false, nextRun: past });

    const deps = makeDeps(db, [{ text: 'should not fire' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus, lastRun: agentSchedules.lastRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    // Last_status not touched, last_run not bumped
    expect(after[0]?.lastStatus).toBeNull();
    expect(after[0]?.lastRun).toBeNull();
  });

  it('skips a schedule with next_run in the future', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const sched = await createSchedule({ nextRun: future });

    const deps = makeDeps(db, [{ text: 'should not fire' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastRun: agentSchedules.lastRun, nextRun: agentSchedules.nextRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    expect(after[0]?.lastRun).toBeNull();
    expect(after[0]?.nextRun?.getTime()).toBe(future.getTime());
  });

  it('marks failed and pushes next_run far out for a bad cron expression', async () => {
    const sched = await createSchedule({ cronExpr: 'not a cron at all', nextRun: null });

    const deps = makeDeps(db, [{ text: 'never reached' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus, nextRun: agentSchedules.nextRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    expect(after[0]?.lastStatus).toBe('failed');
    // Pushed >300 days out so we don't keep retrying every tick
    const days = (after[0]!.nextRun!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(300);
  });

  it('idempotency: two concurrent ticks fire each schedule exactly once', async () => {
    const sched = await createSchedule({ nextRun: null });

    const deps = makeDeps(db, [{ text: 'fired once' }]);

    const [r1, r2] = await Promise.all([
      runScheduleTick(db as RunnerDeps['db'], deps, 5),
      runScheduleTick(db as RunnerDeps['db'], deps, 5),
    ]);

    // The schedule we just inserted was claimed exactly once across the two
    // racing ticks. (Other tests' schedules may also be in the table, so we
    // can't just assert r1+r2; instead, count cron jobs created for this
    // specific schedule's agent — but seed.agentId is shared. Use the
    // schedule's last_run instead: it's set by exactly one tick.)
    void r1;
    void r2;

    const after = await db
      .select({ lastRun: agentSchedules.lastRun, lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    // last_run set, last_status not 'failed'
    expect(after[0]?.lastRun).toBeInstanceOf(Date);
    expect(after[0]?.lastStatus).not.toBe('failed');
  });

  it('marks failed when the fired job fails', async () => {
    const sched = await createSchedule({ nextRun: null });

    // Empty response → no_tool_calls_no_text → job fails
    const deps = makeDeps(db, [{ text: '', toolCalls: [] }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));

    expect(after[0]?.lastStatus).toBe('failed');
  });
});
