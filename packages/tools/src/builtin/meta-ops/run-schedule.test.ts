// meta-ops/run-schedule.test.ts — unit tests for the run_schedule tool.
// Uses a real pglite in-memory DB via @nodal-agents/db/test-utils.
// Asserts on the real agent_jobs row inserted — never call counts.
//
// Delivery rule under test (2026-07-09): an unsolicited push (here, a schedule
// run triggered via run_schedule) goes to the bot OWNER's 1:1, never a stale
// agents.last_seen_chat_id_telegram (which a group message silently
// overwrites) — unless the schedule carries an explicit chat_id target.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSchedules, agentJobs, telegramAllowedChats, agents, eq, and } from '@nodal-agents/db';
import type { ToolContext } from '../../types';
import { runScheduleTool } from './run-schedule';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

function makeCtx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
  };
}

async function createSchedule(overrides: {
  name: string;
  notifyOnSuccess?: boolean;
  chatId?: string | null;
}) {
  const [row] = await db
    .insert(agentSchedules)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      type: 'cron',
      name: overrides.name,
      cronExpr: '0 9 * * *',
      task: 'Do the thing',
      active: true,
      nextRun: null,
      notifyOnSuccess: overrides.notifyOnSuccess ?? false,
      chatId: overrides.chatId ?? null,
    })
    .returning();
  return row!;
}

async function lastJobFor(name: string) {
  const jobs = await db
    .select({ id: agentJobs.id, chatId: agentJobs.chatId, channel: agentJobs.channel })
    .from(agentJobs)
    .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'Do the thing')));
  // Isolate by insertion order — most recent row for this test's call.
  void name;
  return jobs[jobs.length - 1];
}

describe('run_schedule', () => {
  it('notify_on_success + no explicit chat_id + a registered owner → job.chatId = owner chat', async () => {
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'owner-111',
      role: 'owner',
      status: 'active',
    });
    await createSchedule({ name: 'run-sched-owner', notifyOnSuccess: true });

    const result = await runScheduleTool.execute({ name: 'run-sched-owner' }, makeCtx());
    expect(result.ok).toBe(true);

    const job = await lastJobFor('run-sched-owner');
    expect(job).toBeDefined();
    expect(job!.channel).toBe('cron');
    expect(job!.chatId).toBe('owner-111');

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('an explicit schedule.chat_id wins over the registered owner', async () => {
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'owner-222',
      role: 'owner',
      status: 'active',
    });
    await createSchedule({
      name: 'run-sched-explicit',
      notifyOnSuccess: true,
      chatId: 'team-group-999',
    });

    const result = await runScheduleTool.execute({ name: 'run-sched-explicit' }, makeCtx());
    expect(result.ok).toBe(true);

    const job = await lastJobFor('run-sched-explicit');
    expect(job!.chatId).toBe('team-group-999');

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('notify_on_success=false → chat_id stays null (silent), even with a registered owner', async () => {
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: 'owner-333',
      role: 'owner',
      status: 'active',
    });
    await createSchedule({ name: 'run-sched-silent', notifyOnSuccess: false });

    const result = await runScheduleTool.execute({ name: 'run-sched-silent' }, makeCtx());
    expect(result.ok).toBe(true);

    const job = await lastJobFor('run-sched-silent');
    expect(job!.chatId).toBeNull();

    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  });

  it('no registered owner + no explicit chat_id → chat_id stays null (no leak to a stale last-seen chat)', async () => {
    // Pollute last-seen to prove it is never consulted.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: 'stale-444' })
      .where(eq(agents.id, seed.agentId));
    await createSchedule({ name: 'run-sched-no-owner', notifyOnSuccess: true });

    const result = await runScheduleTool.execute({ name: 'run-sched-no-owner' }, makeCtx());
    expect(result.ok).toBe(true);

    const job = await lastJobFor('run-sched-no-owner');
    expect(job!.chatId).toBeNull();

    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });

  it('returns ok:false when no schedule with that name exists', async () => {
    const result = await runScheduleTool.execute({ name: 'no-such-schedule' }, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('no-such-schedule');
  });

  it('returns ok:false when the schedule has no task', async () => {
    await db.insert(agentSchedules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      type: 'cron',
      name: 'run-sched-no-task',
      cronExpr: '0 9 * * *',
      task: null,
      active: true,
      nextRun: null,
    });
    const result = await runScheduleTool.execute({ name: 'run-sched-no-task' }, makeCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error).toContain('run-sched-no-task');
  });

  // ─── Event Triggers, Brique 1: schedule_id + trigger_context ────────────────

  it('stamps a manually-fired job with schedule_id and trigger_context carrying the CURRENT last_run', async () => {
    const priorRun = new Date(Date.now() - 30 * 60_000); // 30min ago
    const sched = await createSchedule({ name: 'run-sched-trigger-ctx' });
    await db
      .update(agentSchedules)
      .set({ lastRun: priorRun })
      .where(eq(agentSchedules.id, sched.id));

    const result = await runScheduleTool.execute({ name: 'run-sched-trigger-ctx' }, makeCtx());
    expect(result.ok).toBe(true);

    const jobs = await db
      .select({
        scheduleId: agentJobs.scheduleId,
        triggerContext: agentJobs.triggerContext,
        channel: agentJobs.channel,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'Do the thing')));
    const job = jobs[jobs.length - 1]!;
    expect(job.channel).toBe('cron');
    expect(job.scheduleId).toBe(sched.id);
    expect(job.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'run-sched-trigger-ctx',
      prevRunAt: priorRun.toISOString(),
    });
  });

  it('trigger_context.prevRunAt is null when the schedule has never run', async () => {
    const sched = await createSchedule({ name: 'run-sched-trigger-ctx-first' });
    expect(sched.lastRun).toBeNull();

    const result = await runScheduleTool.execute(
      { name: 'run-sched-trigger-ctx-first' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);

    const jobs = await db
      .select({ scheduleId: agentJobs.scheduleId, triggerContext: agentJobs.triggerContext })
      .from(agentJobs)
      .where(and(eq(agentJobs.agentId, seed.agentId), eq(agentJobs.task, 'Do the thing')));
    const job = jobs[jobs.length - 1]!;
    expect(job.scheduleId).toBe(sched.id);
    expect(job.triggerContext).toEqual({
      type: 'cron',
      scheduleName: 'run-sched-trigger-ctx-first',
      prevRunAt: null,
    });
  });
});
