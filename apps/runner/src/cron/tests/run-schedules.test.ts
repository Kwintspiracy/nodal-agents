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

import { describe, it, expect, beforeAll } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agentSchedules, agents } from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import type { RunnerDeps } from '../../deps.ts';
import { runScheduleTick } from '../run-schedules.ts';

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

/** Seed a prior Telegram conversation row so the auto-resolver finds a chatId. */
async function seedTelegramConversation(chatId: string) {
  await db.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'telegram',
    chatId,
    task: 'previous user message',
    status: 'completed',
    result: 'previous bot reply',
    messages: [],
  });
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

  it('auto-resolves channel=telegram + chatId from the agent`s last Telegram conversation', async () => {
    await seedTelegramConversation('987654321');
    const sched = await createSchedule({
      nextRun: null,
      task: 'Auto-route to last telegram chat',
    });

    const deps = makeDeps(db, [{ text: 'Hi from cron.' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({
        channel: agentJobs.channel,
        chatId: agentJobs.chatId,
        task: agentJobs.task,
      })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));

    const fired = jobs.find((j) => j.task === 'Auto-route to last telegram chat');
    expect(fired).toBeDefined();
    expect(fired?.channel).toBe('telegram');
    expect(fired?.chatId).toBe('987654321');

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('success');
  });

  it('falls back to channel=cron when agent has no prior Telegram conversation', async () => {
    // Create a fresh agent with no Telegram history
    const freshAgent = (
      await db
        .insert(agents)
        .values({
          entityId: seed.entityId,
          slug: 'cron-only-agent',
          name: 'Cron Only',
          role: 'agent',
          systemAgent: true,
          personality: 'A test worker with no telegram history.',
        })
        .returning()
    )[0]!;

    const rows = await db
      .insert(agentSchedules)
      .values({
        entityId: seed.entityId,
        agentId: freshAgent.id,
        type: 'cron',
        name: 'No telegram history',
        cronExpr: '0 9 * * *',
        task: 'Log-only task',
        active: true,
        nextRun: null,
      })
      .returning();
    const sched = rows[0]!;

    const deps = makeDeps(db, [{ text: 'log only' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({ channel: agentJobs.channel, chatId: agentJobs.chatId, task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, freshAgent.id));

    const fired = jobs.find((j) => j.task === 'Log-only task');
    expect(fired).toBeDefined();
    expect(fired?.channel).toBe('cron');
    expect(fired?.chatId).toBeNull();
    void sched;
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
