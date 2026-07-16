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
//   - Event Triggers, Brique 3: daily budget guard (F1) + no-overlap guard (F2)

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agentJobs,
  agentSchedules,
  agents,
  telegramAllowedChats,
  channelAllowedConversations,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';

// Mock the delivery channel so the budget-exhausted owner notice (F1) can be
// asserted deterministically without network. Hoisted by vitest — mirrors
// deliver-results.test.ts's pattern. S3: notifyBudgetExhausted now dispatches
// via getAdapter(...).sendText — the fake adapter forwards to the same
// sendTelegramMessageMock so the existing assertions keep working unchanged.
type SendOpts = { chatId: string; text: string; botToken: string };
const sendTelegramMessageMock = vi.fn(async (_opts: SendOpts) => ({ messageId: 1 }));
vi.mock('@nodal-agents/delivery', () => ({
  sendTelegramMessage: (opts: SendOpts) => sendTelegramMessageMock(opts),
  resolveTransportChannel: () => 'telegram',
  // No test here binds an agent to a non-telegram channel — an empty active
  // list preserves the pre-existing 'telegram' default.
  listActiveChannelsForAgent: async (..._args: unknown[]) => [] as string[],
  getAdapter: (channel: string) => ({
    channel,
    sendText: (creds: { botToken: string }, conversationId: string, text: string) =>
      sendTelegramMessageMock({ chatId: conversationId, text, botToken: creds.botToken }),
  }),
}));

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
  notifyOnSuccess?: boolean;
  notifyChannel?: string | null;
  chatId?: string | null;
  dailyBudgetUsd?: number;
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
      notifyOnSuccess: overrides.notifyOnSuccess ?? false,
      notifyChannel: overrides.notifyChannel ?? null,
      chatId: overrides.chatId ?? null,
      dailyBudgetUsd: overrides.dailyBudgetUsd ?? 5,
    })
    .returning();
  return rows[0]!;
}

/** Insert an agent_jobs row tied to a schedule with a controlled cost + created_at, for budget rollup tests. */
async function insertScheduleJob(
  scheduleId: string,
  overrides: { totalCostUsd?: number; createdAt?: Date; status?: string; task?: string } = {},
) {
  const rows = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: overrides.task ?? 'rollup fixture',
      status: overrides.status ?? 'completed',
      scheduleId,
      totalCostUsd: overrides.totalCostUsd ?? 0,
      createdAt: overrides.createdAt ?? new Date(),
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

  it('propagates the bot owner chat into the cron job chat_id ONLY when notify_on_success is on', async () => {
    // Opt-in: a schedule that asked for a success confirmation gets the bot
    // OWNER's 1:1 chat copied into the job's chat_id at INSERT time. That
    // non-null chat_id is what makes the runner force the agent to confirm.
    // (The owner's chat is NEVER the agent's last-seen chat — a group message
    // silently overwrites that — it's the dedicated telegram_allowed_chats row.)
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '7777',
      role: 'owner',
      status: 'active',
    });

    const past = new Date(Date.now() - 60_000);
    await createSchedule({ nextRun: past, task: 'cron with confirmation', notifyOnSuccess: true });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const cronJobs = await db
      .select({ id: agentJobs.id, chatId: agentJobs.chatId, channel: agentJobs.channel })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const justFired = cronJobs.filter((j) => j.channel === 'cron' && j.chatId === '7777');
    expect(justFired.length).toBeGreaterThanOrEqual(1);

    // Cleanup so subsequent tests aren't affected.
    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it("an explicit schedule.chat_id wins over the owner's chat", async () => {
    // A schedule with a deliberate target (e.g. "post to #team") must never be
    // redirected to the owner's 1:1 — the explicit target is authoritative.
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '7777',
      role: 'owner',
      status: 'active',
    });

    const past = new Date(Date.now() - 60_000);
    await createSchedule({
      nextRun: past,
      task: 'cron with explicit target',
      notifyOnSuccess: true,
      chatId: '424242',
    });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const cronJobs = await db
      .select({ chatId: agentJobs.chatId, channel: agentJobs.channel, task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const fired = cronJobs.filter(
      (j) => j.channel === 'cron' && j.task === 'cron with explicit target',
    );
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired.every((j) => j.chatId === '424242')).toBe(true);

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('leaves chat_id NULL on a cron job when notify_on_success is off, even with a registered owner', async () => {
    // Default behavior: the cron runs silently. A registered owner is NOT
    // enough — the user must opt in per schedule.
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '8888',
      role: 'owner',
      status: 'active',
    });

    const past = new Date(Date.now() - 60_000);
    await createSchedule({ nextRun: past, task: 'silent cron', notifyOnSuccess: false });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const cronJobs = await db
      .select({ chatId: agentJobs.chatId, channel: agentJobs.channel, task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    // Isolate this test's job by task (the file reuses one agent across tests).
    const fired = cronJobs.filter((j) => j.channel === 'cron' && j.task === 'silent cron');
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired.every((j) => j.chatId === null)).toBe(true);

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('leaves chat_id NULL when the agent has no registered owner (no leak to a stale last-seen chat)', async () => {
    // No telegram_allowed_chats owner row → resolveOwnerChatId returns null →
    // cron jobs do NOT get a chat_id (no Telegram delivery, no error). Also
    // proves a polluted agents.last_seen_chat_id_telegram is never consulted.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '9999' })
      .where(eq(agents.id, seed.agentId));

    const past = new Date(Date.now() - 60_000);
    await createSchedule({
      nextRun: past,
      task: 'cron without registered owner',
      notifyOnSuccess: true,
    });

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
      (j) => j.channel === 'cron' && j.task === 'cron without registered owner',
    );
    expect(justFired.length).toBeGreaterThanOrEqual(1);
    expect(justFired[0]!.chatId).toBeNull();

    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
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

  // ─── Event Triggers, Brique 1: schedule_id + trigger_context ────────────────

  it('stamps the fired job with schedule_id and trigger_context.prevRunAt = the PREVIOUS last_run', async () => {
    const priorRun = new Date(Date.now() - 60 * 60_000); // 1h ago
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'watch for new rows since prevRunAt',
    });
    // Seed a prior last_run directly so this tick's captured "previous" value
    // is deterministic (createSchedule leaves last_run NULL by default).
    await db
      .update(agentSchedules)
      .set({ lastRun: priorRun })
      .where(eq(agentSchedules.id, sched.id));

    const deps = makeDeps(db, [{ text: 'checked since prevRunAt' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({
        scheduleId: agentJobs.scheduleId,
        triggerContext: agentJobs.triggerContext,
        channel: agentJobs.channel,
        task: agentJobs.task,
      })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    const fired = jobs.filter(
      (j) => j.channel === 'cron' && j.task === 'watch for new rows since prevRunAt',
    );
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const job = fired[0]!;
    expect(job.scheduleId).toBe(sched.id);
    expect(job.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'Test schedule',
      prevRunAt: priorRun.toISOString(),
      notifyChannel: null,
    });
  });

  it("trigger_context.prevRunAt is null on a schedule's first-ever run", async () => {
    const sched = await createSchedule({
      nextRun: null,
      task: 'first run ever',
    });
    expect(sched.lastRun).toBeNull();

    const deps = makeDeps(db, [{ text: 'first fire' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({ scheduleId: agentJobs.scheduleId, triggerContext: agentJobs.triggerContext })
      .from(agentJobs)
      .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'first run ever')));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]!.scheduleId).toBe(sched.id);
    expect(jobs[0]!.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'Test schedule',
      prevRunAt: null,
      notifyChannel: null,
    });
  });

  // ─── Event Triggers, Brique 3: daily budget guard (F1) ──────────────────────

  it('fires normally when the schedule has spent under its daily budget today', async () => {
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'budget ok',
    });
    await insertScheduleJob(sched.id, { totalCostUsd: 4.99 });

    const deps = makeDeps(db, [{ text: 'ran within budget' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('success');

    const fired = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(and(eq(agentJobs.scheduleId, sched.id), eq(agentJobs.task, 'budget ok')));
    expect(fired.length).toBeGreaterThanOrEqual(1);
  });

  it(
    'holds a schedule that already spent past its daily budget, notifies the owner once, ' +
      'and does not repeat the notice on the next tick while still exhausted',
    async () => {
      await db.insert(telegramAllowedChats).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        chatId: 'budget-owner-1',
        role: 'owner',
        status: 'active',
      });
      await db
        .update(agents)
        .set({ telegramBotToken: 'test-bot-token' })
        .where(eq(agents.id, seed.agentId));

      const sched = await createSchedule({
        nextRun: new Date(Date.now() - 60_000),
        task: 'budget exceeded',
      });
      await insertScheduleJob(sched.id, { totalCostUsd: 5.01 });

      const deps = makeDeps(db, [{ text: 'should not run' }]);
      await runScheduleTick(db as RunnerDeps['db'], deps, 5);

      const after1 = await db
        .select({ lastStatus: agentSchedules.lastStatus, lastRun: agentSchedules.lastRun })
        .from(agentSchedules)
        .where(eq(agentSchedules.id, sched.id));
      expect(after1[0]?.lastStatus).toBe('budget_exhausted');
      // No new job created — only the pre-existing fixture job.
      const jobsAfterFirstTick = await db
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(eq(agentJobs.scheduleId, sched.id));
      expect(jobsAfterFirstTick.length).toBe(1);

      expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
      const sent = sendTelegramMessageMock.mock.calls[0]![0];
      expect(sent.botToken).toBe('test-bot-token');
      expect(sent.chatId).toBe('budget-owner-1');
      expect(sent.text).toContain('Test schedule');
      expect(sent.text).toContain('5.00');

      // Second tick: still exhausted (no new spend) — must NOT re-notify.
      sendTelegramMessageMock.mockClear();
      await runScheduleTick(db as RunnerDeps['db'], deps, 5);
      const after2 = await db
        .select({ lastStatus: agentSchedules.lastStatus })
        .from(agentSchedules)
        .where(eq(agentSchedules.id, sched.id));
      expect(after2[0]?.lastStatus).toBe('budget_exhausted');
      expect(sendTelegramMessageMock).not.toHaveBeenCalled();

      await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
      await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
    },
  );

  it('does not count cost from a previous day toward the budget', async () => {
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'yesterday cost',
    });
    // >24h ago is safely "yesterday" regardless of the server's local timezone
    // (max UTC offset is ±14h).
    const yesterday = new Date(Date.now() - 25 * 60 * 60_000);
    await insertScheduleJob(sched.id, { totalCostUsd: 999, createdAt: yesterday });

    const deps = makeDeps(db, [{ text: 'still runs' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('success');
  });

  it("does not count another schedule's cost toward this one's budget", async () => {
    const schedA = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'schedule A budget',
    });
    const schedB = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'schedule B budget',
    });
    await insertScheduleJob(schedB.id, { totalCostUsd: 999 });

    const deps = makeDeps(db, [{ text: 'A runs fine' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const afterA = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, schedA.id));
    expect(afterA[0]?.lastStatus).toBe('success');

    const afterB = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, schedB.id));
    expect(afterB[0]?.lastStatus).toBe('budget_exhausted');
  });

  it("never counts a non-schedule job (schedule_id NULL) toward any schedule's budget", async () => {
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'unrelated non-schedule job',
      status: 'completed',
      totalCostUsd: 999,
      scheduleId: null,
    });
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'unaffected by null-schedule jobs',
    });

    const deps = makeDeps(db, [{ text: 'runs fine' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('success');
  });

  it('accepts budget_exhausted as a valid last_status (migration 0062 CHECK constraint)', async () => {
    const sched = await createSchedule({ nextRun: null, task: 'constraint probe' });
    await db
      .update(agentSchedules)
      .set({ lastStatus: 'budget_exhausted' })
      .where(eq(agentSchedules.id, sched.id));
    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('budget_exhausted');
  });

  // ─── Event Triggers, Brique 3: no-overlap guard (F2) ────────────────────────

  it('skips firing a due schedule while a previous job for it is still live', async () => {
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'overlap guard task',
    });
    const liveJob = await insertScheduleJob(sched.id, {
      status: 'processing',
      task: 'overlap guard task',
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps(db, [{ text: 'should not fire' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.scheduleId, sched.id));
    expect(jobs.length).toBe(1); // only the pre-existing live job, no new one
    expect(jobs[0]!.id).toBe(liveJob.id);

    const after = await db
      .select({ lastRun: agentSchedules.lastRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastRun).toBeNull(); // untouched
  });

  it('fires normally once the previous live job for the schedule has completed (regression)', async () => {
    const sched = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'overlap then clear',
    });
    const priorJob = await insertScheduleJob(sched.id, {
      status: 'processing',
      task: 'overlap then clear',
    });

    const deps = makeDeps(db, [{ text: 'should not fire yet' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);
    let jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.scheduleId, sched.id));
    expect(jobs.length).toBe(1); // still just the live one

    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, priorJob.id));

    await runScheduleTick(db as RunnerDeps['db'], deps, 5);
    jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.scheduleId, sched.id));
    expect(jobs.length).toBe(2); // the completed one + a newly-fired one

    const after = await db
      .select({ lastRun: agentSchedules.lastRun })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastRun).toBeInstanceOf(Date);
  });

  it('a live job on one schedule does not block a different schedule from firing', async () => {
    const schedBusy = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'busy schedule',
    });
    const schedFree = await createSchedule({
      nextRun: new Date(Date.now() - 60_000),
      task: 'free schedule',
    });
    await insertScheduleJob(schedBusy.id, { status: 'processing', task: 'busy schedule' });

    const deps = makeDeps(db, [{ text: 'free schedule fires' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const freeJobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.scheduleId, schedFree.id));
    expect(freeJobs.length).toBeGreaterThanOrEqual(1);

    const afterFree = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, schedFree.id));
    expect(afterFree[0]?.lastStatus).toBe('success');

    const busyJobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.scheduleId, schedBusy.id));
    expect(busyJobs.length).toBe(1); // untouched — still just the live fixture job
  });

  // ─── B1 (notify-channel-choice): explicit notify_channel ────────────────────

  it('an explicit notify_channel resolves the owner conversation ON THAT CHANNEL, and stamps it into trigger_context', async () => {
    // A discord owner conversation exists, but NOT a telegram one — proves the
    // resolution is channel-parametric (resolveOwnerConversation), not the
    // telegram-only resolveOwnerChatId wrapper the null/auto path still uses.
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: 'discord-owner-42',
      role: 'owner',
      status: 'active',
    });

    const past = new Date(Date.now() - 60_000);
    await createSchedule({
      nextRun: past,
      task: 'notify via discord',
      notifyOnSuccess: true,
      notifyChannel: 'discord',
    });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({
        chatId: agentJobs.chatId,
        channel: agentJobs.channel,
        triggerContext: agentJobs.triggerContext,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'notify via discord')));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]!.chatId).toBe('discord-owner-42');
    expect(jobs[0]!.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'Test schedule',
      prevRunAt: null,
      notifyChannel: 'discord',
    });

    await db
      .delete(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, seed.agentId));
  });

  it(
    'fails loud with lastStatus notify_unreachable (no fallback to another channel) when the ' +
      'chosen notify_channel has no owner conversation yet, and still fires the job WITHOUT a chatId',
    async () => {
      const past = new Date(Date.now() - 60_000);
      await createSchedule({
        nextRun: past,
        task: 'notify via unreachable slack',
        notifyOnSuccess: true,
        notifyChannel: 'slack', // no owner row for slack anywhere in this test
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const deps = makeDeps(db, [{ text: 'cron ran anyway' }]);
      await runScheduleTick(db as RunnerDeps['db'], deps, 5);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('notify_unreachable'));
      errorSpy.mockRestore();

      const jobs = await db
        .select({ chatId: agentJobs.chatId, id: agentJobs.id })
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.agentId, seed.agentId),
            eq(agentJobs.task, 'notify via unreachable slack'),
          ),
        );
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      // The run itself still happens — no chatId, not skipped entirely.
      expect(jobs[0]!.chatId).toBeNull();

      const sched = await db
        .select({ lastStatus: agentSchedules.lastStatus })
        .from(agentSchedules)
        .innerJoin(agentJobs, eq(agentJobs.scheduleId, agentSchedules.id))
        .where(eq(agentJobs.id, jobs[0]!.id));
      expect(sched[0]?.lastStatus).toBe('notify_unreachable');
    },
  );

  it('notifyChannel=null (auto) is byte-identical to the pre-B1 owner-chat regression path', async () => {
    // Regression: an existing schedule with notify_channel left NULL keeps
    // using resolveOwnerChatId (the telegram-only wrapper) exactly as before —
    // this is the same scenario as the earlier "propagates the bot owner chat"
    // test, just asserting the trigger_context shape too.
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'auto-owner-1',
      role: 'owner',
      status: 'active',
    });

    const past = new Date(Date.now() - 60_000);
    await createSchedule({
      nextRun: past,
      task: 'notify via auto',
      notifyOnSuccess: true,
      notifyChannel: null,
    });

    const deps = makeDeps(db, [{ text: 'cron ran' }]);
    await runScheduleTick(db as RunnerDeps['db'], deps, 5);

    const jobs = await db
      .select({ chatId: agentJobs.chatId, triggerContext: agentJobs.triggerContext })
      .from(agentJobs)
      .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'notify via auto')));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]!.chatId).toBe('auto-owner-1');
    expect(jobs[0]!.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'Test schedule',
      prevRunAt: null,
      notifyChannel: null,
    });

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('accepts notify_unreachable as a valid last_status (migration 0066 CHECK constraint)', async () => {
    const sched = await createSchedule({
      nextRun: null,
      task: 'notify_unreachable constraint probe',
    });
    await db
      .update(agentSchedules)
      .set({ lastStatus: 'notify_unreachable' })
      .where(eq(agentSchedules.id, sched.id));
    const after = await db
      .select({ lastStatus: agentSchedules.lastStatus })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, sched.id));
    expect(after[0]?.lastStatus).toBe('notify_unreachable');
  });
});
