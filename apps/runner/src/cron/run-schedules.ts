// cron/run-schedules.ts — runScheduleTick
// Fire active agent_schedules whose next_run is due (NULL or <= now). For each
// fired schedule:
//   1. No-overlap pre-filter — skip if a live job for this schedule exists
//   2. Daily budget pre-filter — skip if today's cost rollup hit the ceiling
//   3. Atomic claim via conditional UPDATE (no FOR UPDATE SKIP LOCKED on pglite)
//   4. Insert agent_jobs row with channel='cron'
//   5. Execute inline via executeJob
//   6. Update last_status from job outcome
// Idempotent: two concurrent ticks can't fire the same schedule twice — the
// conditional UPDATE acts as the lock.

import { and, eq, isNull, lte, or, sql, desc, inArray } from '@nodal-agents/db';
import {
  agentSchedules,
  agentJobs,
  resolveOwnerChatId,
  resolveOwnerConversation,
  getBindingCredentials,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { resolveTimezone } from '@nodal-agents/shared';
import {
  getAdapter,
  resolveTransportChannel,
  listActiveChannelsForAgent,
} from '@nodal-agents/delivery';
import type { ChannelKind } from '@nodal-agents/delivery';
import { CronExpressionParser } from 'cron-parser';
import { executeJob, type ExecuteJobResult } from '../job/execute.ts';
import type { RunnerDeps } from '../deps.ts';
import type { JobId } from '@nodal-agents/orchestration';

// Job statuses that mean "this schedule already has a run in flight" — the
// no-overlap guard (F2, Event Triggers Brique 3).
const LIVE_JOB_STATUSES = ['pending', 'processing', 'awaiting_approval', 'awaiting_delegation'];

// A live job older than this is very likely stuck, not just long-running —
// escalate the log so it's noticed, but still skip: reaping stuck jobs is the
// job watchdog's (cron/reset-orphans.ts) job, not this guard's.
const STUCK_LIVE_JOB_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Best-effort: tell the bot OWNER a schedule's daily budget just tripped.
 * Failures are logged and swallowed — a notification failure must never block
 * the (already-persisted) budget hold. No-ops silently when the agent has no
 * registered owner or no bot token (dashboard-only schedule).
 */
async function notifyBudgetExhausted(
  db: AnyDrizzleDb,
  agentId: string,
  scheduleName: string,
  dailyBudgetUsd: number,
): Promise<void> {
  try {
    const ownerChatId = await resolveOwnerChatId(db, agentId);
    if (!ownerChatId) return;
    // S3: a cron trigger isn't itself a transport — resolveTransportChannel
    // defaults it to this agent's own active channel, falling back to
    // 'telegram' only when the agent has no active channel at all.
    const activeChannels = await listActiveChannelsForAgent(db, agentId);
    const channel = resolveTransportChannel('cron', activeChannels);
    const creds = await getBindingCredentials(db, agentId, channel);
    if (!creds) return;
    const adapter = getAdapter(channel);
    await adapter.sendText(
      creds,
      ownerChatId,
      `Schedule « ${scheduleName} » a atteint son budget quotidien (${dailyBudgetUsd.toFixed(2)} $) ` +
        `— runs suspendus jusqu'à demain. Ajustez le budget dans Automations si besoin.`,
    );
  } catch (err) {
    console.warn(
      `[runScheduleTick] failed to notify owner of budget_exhausted for agent ${agentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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
      name: agentSchedules.name,
      nextRun: agentSchedules.nextRun,
      // Captured BEFORE the claim UPDATE below overwrites it with `now` — this
      // is the schedule's PREVIOUS fire time, the deterministic cursor a
      // polling-watcher agent needs ("since when"). See trigger_context below.
      lastRun: agentSchedules.lastRun,
      // Per-schedule opt-in: deliver a success confirmation to the user.
      notifyOnSuccess: agentSchedules.notifyOnSuccess,
      // Explicit delivery target (e.g. "post to #team"), null for the common case.
      chatId: agentSchedules.chatId,
      // Explicit notify channel choice (B1), null = auto (first active channel
      // by priority, the historical behavior — see the chatId resolution below).
      notifyChannel: agentSchedules.notifyChannel,
      // Read BEFORE this tick's writes — "was it already budget_exhausted" is
      // the transition check the notify-once-per-day dedup relies on below.
      lastStatus: agentSchedules.lastStatus,
      dailyBudgetUsd: agentSchedules.dailyBudgetUsd,
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

  // Schedules whose EXPLICIT notify channel had no owner conversation at fire
  // time (F1's fail-loud rule: never silently fall back to another channel).
  // The run itself still proceeds — this only overrides the schedule's
  // lastStatus at the end of the tick so a delivery problem isn't masked by
  // an otherwise-successful run's 'success' status.
  const notifyUnreachableScheduleIds = new Set<string>();

  for (const sched of candidates.slice(0, max)) {
    if (!sched.task || !sched.entityId) continue;

    // F2 — no-overlap guard. A pre-filter, NOT a replacement for the atomic
    // claim below: it just refuses to even attempt claiming while a live job
    // for this schedule exists. The schedule stays due (next_run/last_run
    // untouched) — it fires on the first tick after the live job finishes.
    // Live incident 2026-07-11: tick N+1 fired while tick N's job for the same
    // schedule was still processing (stale next_run catch-up + a long run),
    // producing two concurrent instances of the same watcher.
    const [liveJob] = await db
      .select({ id: agentJobs.id, createdAt: agentJobs.createdAt })
      .from(agentJobs)
      .where(and(eq(agentJobs.scheduleId, sched.id), inArray(agentJobs.status, LIVE_JOB_STATUSES)))
      .orderBy(desc(agentJobs.createdAt))
      .limit(1);
    if (liveJob) {
      const ageMs = now.getTime() - (liveJob.createdAt?.getTime() ?? now.getTime());
      if (ageMs > STUCK_LIVE_JOB_MS) {
        console.warn(
          `[runScheduleTick] schedule "${sched.name}" (${sched.id}) skipped — live job ${liveJob.id} ` +
            `has been running for ${Math.round(ageMs / 60_000)}min (>2h, possibly stuck). Skipping this ` +
            `fire; the job watchdog owns stuck-job recovery, not this guard.`,
        );
      } else {
        console.warn(
          `[runScheduleTick] schedule "${sched.name}" (${sched.id}) skipped — live job ${liveJob.id} ` +
            `is still running (no-overlap guard).`,
        );
      }
      continue;
    }

    // F1 — daily budget guard. Rolled up BEFORE the claim: sum this
    // schedule's cost today (its own local day, in its cron timezone) and
    // refuse to fire once it's spent its ceiling. Live incident 2026-07-11: a
    // 5-min watcher schedule with no aggregate ceiling could burn up to
    // $576/day worst case at the per-job $2 cap. Left due (not claimed, not
    // touched) so the next day's rollup naturally lifts the hold — no cron
    // math needed to "resume tomorrow".
    const tz = resolveTimezone(sched.timezone);
    const [spentRow] = await db
      .select({ spent: sql<number>`COALESCE(SUM(${agentJobs.totalCostUsd}), 0)` })
      .from(agentJobs)
      .where(
        sql`${agentJobs.scheduleId} = ${sched.id} AND ${agentJobs.createdAt} >= (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
      );
    const spentToday = Number(spentRow?.spent ?? 0);
    if (spentToday >= sched.dailyBudgetUsd) {
      const wasExhausted = sched.lastStatus === 'budget_exhausted';
      await db
        .update(agentSchedules)
        .set({ lastStatus: 'budget_exhausted', updatedAt: now })
        .where(eq(agentSchedules.id, sched.id));
      // Notify once per day: only on the transition INTO budget_exhausted —
      // the day rolls over, last_status becomes success/failed/no_action
      // again, and the next trip re-notifies.
      if (!wasExhausted) {
        await notifyBudgetExhausted(db, sched.agentId, sched.name, sched.dailyBudgetUsd);
      }
      continue;
    }

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
    // (see `triggerWantsConfirmation` in execute.ts). An explicit schedule.chatId
    // (e.g. "post to #team") wins; otherwise fall back to the bot owner's 1:1 —
    // never the agent's last-seen chat, which a group message silently overwrites.
    //
    // B1 (notify-channel-choice): when the schedule chose an EXPLICIT channel,
    // the owner conversation is resolved ON THAT CHANNEL (resolveOwnerConversation,
    // channel-parametric) instead of the telegram-only resolveOwnerChatId wrapper
    // — choosing a channel LINKS chatId resolution to it, closing the structural
    // gap where the chatId and the delivery channel used to be resolved
    // independently. notifyChannel=null (auto) keeps the exact historical path.
    // Fail loud: if the chosen channel has no owner conversation yet, we do NOT
    // fall back to another channel — the job still fires (chatId stays null,
    // so it runs silently), and the schedule's lastStatus becomes
    // 'notify_unreachable' below instead of masking the problem as 'success'.
    let notifyChatId: string | null = null;
    if (sched.notifyOnSuccess) {
      if (sched.notifyChannel) {
        const channel = sched.notifyChannel as ChannelKind;
        notifyChatId = sched.chatId ?? (await resolveOwnerConversation(db, sched.agentId, channel));
        if (!notifyChatId) {
          notifyUnreachableScheduleIds.add(sched.id);
          console.error(
            `[runScheduleTick] schedule "${sched.name}" (${sched.id}) chose notify channel ` +
              `'${channel}' but has no owner conversation there yet (never DMed on that ` +
              `channel). Firing WITHOUT a delivery target — not falling back to another ` +
              `channel. lastStatus will read 'notify_unreachable'.`,
          );
        }
      } else {
        notifyChatId = sched.chatId ?? (await resolveOwnerChatId(db, sched.agentId)) ?? null;
      }
    }
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
        scheduleId: sched.id,
        triggerContext: {
          type: 'cron',
          scheduleName: sched.name,
          // L'id dans la provenance aussi : `schedule_id` ne survit pas à la
          // suppression de l'automatisation, la provenance si (passe 26).
          scheduleId: sched.id,
          prevRunAt: sched.lastRun ? sched.lastRun.toISOString() : null,
          notifyChannel: (sched.notifyChannel as ChannelKind | null) ?? null,
        },
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
    let lastStatus: 'success' | 'failed' | 'no_action' | 'notify_unreachable';
    if (notifyUnreachableScheduleIds.has(fire.scheduleId)) {
      // The run's own outcome is secondary here — the actionable signal for
      // the user is that their chosen notify channel couldn't be reached, so
      // this overrides an otherwise-'success' status rather than hiding it.
      lastStatus = 'notify_unreachable';
    } else if (result.status === 'completed') lastStatus = 'success';
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
