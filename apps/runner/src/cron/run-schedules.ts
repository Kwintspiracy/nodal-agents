// cron/run-schedules.ts — runScheduleTick
// Fire active agent_schedules whose next_run is due (NULL or <= now). For each
// fired schedule:
//   1. Atomic claim via conditional UPDATE (no FOR UPDATE SKIP LOCKED on pglite)
//   2. Insert agent_jobs row with channel='cron'
//   3. Execute inline via executeJob
//   4. Update last_status from job outcome
// Idempotent: two concurrent ticks can't fire the same schedule twice — the
// conditional UPDATE acts as the lock.

import { and, eq, isNull, lte, or } from '@nodal-agents/db';
import { agentSchedules, agentJobs, agents } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { CronExpressionParser } from 'cron-parser';
import { executeJob } from '../job/execute.ts';
import type { RunnerDeps } from '../deps.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── runScheduleTick ──────────────────────────────────────────────────────────

/**
 * Fire up to `max` due schedules.
 * @returns count of schedules that were claimed and fired
 */
export async function runScheduleTick(
  db: AnyDrizzleDb,
  deps: RunnerDeps,
  max = 5,
): Promise<number> {
  const now = new Date();

  const candidates = await db
    .select({
      id: agentSchedules.id,
      entityId: agentSchedules.entityId,
      agentId: agentSchedules.agentId,
      cronExpr: agentSchedules.cronExpr,
      task: agentSchedules.task,
      nextRun: agentSchedules.nextRun,
      // The agent's last-seen Telegram chat is the default delivery target for
      // cron-fired jobs (no per-schedule chat UI yet). Populated by the
      // inbound poller on every DM; null until the user has DM'd the bot once.
      agentLastSeenChatIdTelegram: agents.lastSeenChatIdTelegram,
    })
    .from(agentSchedules)
    .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
    .where(
      and(
        eq(agentSchedules.active, true),
        or(isNull(agentSchedules.nextRun), lte(agentSchedules.nextRun, now)),
      ),
    )
    .limit(max * 2);

  if (candidates.length === 0) return 0;

  type ScheduledFire = {
    scheduleId: string;
    jobId: string;
  };

  const fires: ScheduledFire[] = [];

  for (const sched of candidates.slice(0, max)) {
    if (!sched.task || !sched.entityId) continue;

    let newNextRun: Date;
    try {
      const interval = CronExpressionParser.parse(sched.cronExpr, { currentDate: now });
      newNextRun = interval.next().toDate();
    } catch {
      // Bad cron expression — mark failed, skip. Don't keep retrying every tick.
      // The user must edit the schedule (which recomputes next_run).
      await db
        .update(agentSchedules)
        .set({
          lastRun: now,
          lastStatus: 'failed',
          // Push next_run far out so we don't keep evaluating this row.
          nextRun: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
          updatedAt: now,
        })
        .where(eq(agentSchedules.id, sched.id));
      continue;
    }

    // Atomic claim — same predicate as the SELECT, so concurrent ticks can't both win.
    const claimed = await db
      .update(agentSchedules)
      .set({
        lastRun: now,
        nextRun: newNextRun,
        lastStatus: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentSchedules.id, sched.id),
          eq(agentSchedules.active, true),
          or(isNull(agentSchedules.nextRun), lte(agentSchedules.nextRun, now)),
        ),
      )
      .returning({ id: agentSchedules.id });

    if (claimed.length === 0) continue; // Concurrent tick won

    // Cron-fired jobs default their `chatId` to the agent's last-seen Telegram
    // chat. This puts the delivery intent in the job row at INSERT time
    // (matching the data-driven semantics: chat_id != null = "deliver to this
    // chat on Telegram"). Until per-schedule UI ships, every cron fire on an
    // agent with a Telegram bot will reach the user on Telegram by default.
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: sched.entityId,
        agentId: sched.agentId,
        channel: 'cron',
        chatId: sched.agentLastSeenChatIdTelegram ?? null,
        task: sched.task,
        status: 'pending',
        messages: [{ role: 'user', content: sched.task }],
      })
      .returning({ id: agentJobs.id });

    if (!job) {
      await db
        .update(agentSchedules)
        .set({ lastStatus: 'failed', updatedAt: new Date() })
        .where(eq(agentSchedules.id, sched.id));
      continue;
    }

    fires.push({ scheduleId: sched.id, jobId: job.id });
  }

  if (fires.length === 0) return 0;

  const results = await Promise.allSettled(
    fires.map(async (fire) => {
      const result = await executeJob(fire.jobId as JobId, deps);
      return { fire, result };
    }),
  );

  for (const settled of results) {
    if (settled.status === 'rejected') {
      // executeJob threw — job is already marked failed by its internal handler.
      // Reflect on the schedule row.
      // We don't know which schedule raised, so this branch is rare; the
      // settled.value path covers normal flow.
      continue;
    }
    const { fire, result } = settled.value;
    let lastStatus: 'success' | 'failed' | 'no_action';
    if (result.status === 'completed') lastStatus = 'success';
    else if (result.status === 'failed') lastStatus = 'failed';
    else lastStatus = 'no_action'; // awaiting_approval / awaiting_delegation

    await db
      .update(agentSchedules)
      .set({ lastStatus, updatedAt: new Date() })
      .where(eq(agentSchedules.id, fire.scheduleId));
  }

  return fires.length;
}
