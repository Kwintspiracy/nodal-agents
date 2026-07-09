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
import { agentSchedules, agentJobs, resolveOwnerChatId } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { CronExpressionParser } from 'cron-parser';
import { executeJob, type ExecuteJobResult } from '../job/execute.ts';
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
      timezone: agentSchedules.timezone,
      task: agentSchedules.task,
      nextRun: agentSchedules.nextRun,
      // Per-schedule opt-in: deliver a success confirmation to the user.
      notifyOnSuccess: agentSchedules.notifyOnSuccess,
      // Explicit delivery target (e.g. "post to #team"), null for the common case.
      chatId: agentSchedules.chatId,
    })
    .from(agentSchedules)
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
      // Evaluate the cron in the schedule's own timezone (null = server-local,
      // for legacy rows). This is what keeps "9am" firing at 9am in the user's
      // zone regardless of where the runner is hosted.
      const interval = CronExpressionParser.parse(sched.cronExpr, {
        currentDate: now,
        tz: sched.timezone ?? undefined,
      });
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

    // chat_id carries the delivery intent (chat_id != null = "confirm to this
    // chat"). We set it ONLY when the schedule opted into a success confirmation
    // (notify_on_success); otherwise the cron runs silently. A non-null chat_id
    // on a cron job makes the runner force the agent to deliver before finishing
    // (see `cronWantsConfirmation` in execute.ts). An explicit schedule.chatId
    // (e.g. "post to #team") wins; otherwise fall back to the bot owner's 1:1 —
    // never the agent's last-seen chat, which a group message silently overwrites.
    const notifyChatId = sched.notifyOnSuccess
      ? (sched.chatId ?? (await resolveOwnerChatId(db, sched.agentId)) ?? null)
      : null;
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: sched.entityId,
        agentId: sched.agentId,
        channel: 'cron',
        chatId: notifyChatId,
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
      try {
        const result = await executeJob(fire.jobId as JobId, deps);
        return { fire, result };
      } catch (err) {
        // executeJob threw (e.g. a re-thrown fatal like MessageStructureError /
        // QuotaExhaustedError that bypasses the in-loop failJob). Convert it to a
        // failed outcome HERE — preserving which schedule raised — so the schedule
        // is marked failed below instead of left with last_status=null. Mirrors
        // execute-ready.ts's per-task catch.
        console.error('[runScheduleTick] executeJob threw for schedule', fire.scheduleId, err);
        const result: ExecuteJobResult = {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
        return { fire, result };
      }
    }),
  );

  for (const settled of results) {
    // Throws are caught above (every entry resolves); keep the guard only for an
    // unexpected rejection of the map callback itself.
    if (settled.status === 'rejected') continue;
    const { fire, result } = settled.value;
    let lastStatus: 'success' | 'failed' | 'no_action';
    if (result.status === 'completed') lastStatus = 'success';
    else if (result.status === 'failed') lastStatus = 'failed';
    else if (result.status === 'cancelled') lastStatus = 'failed';
    else lastStatus = 'no_action'; // awaiting_approval / awaiting_delegation

    await db
      .update(agentSchedules)
      .set({ lastStatus, updatedAt: new Date() })
      .where(eq(agentSchedules.id, fire.scheduleId));
  }

  return fires.length;
}
