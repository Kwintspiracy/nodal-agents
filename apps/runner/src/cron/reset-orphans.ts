// cron/reset-orphans.ts — resetOrphanedTasks + resetOrphanedJobs
// Two cleanup phases for state left behind by abrupt shutdown (Ctrl+C, crash,
// suspended laptop). Without these, the dashboard accumulates stuck rows that
// can never recover on their own.
//   - resetOrphanedTasks: tasks claimed but never executed → back to `todo`
//   - resetOrphanedJobs:  jobs in `processing` / `awaiting_delegation` with
//                         no recent activity → marked `failed`

import { and, eq, gte, inArray, isNull, lt, or } from '@nodal-agents/db';
import { agentJobs, agentTasks, approvalRequests } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { sendTelegramMessage } from '@nodal-agents/delivery';
import { failJob } from '../job/state.ts';
import { resolveTelegramDeliveryTarget } from '../approvals/notify.ts';
import type { RunnerDeps } from '../deps.ts';

// User-facing failure notices for the cron reapers. These are the deliberate,
// minimal exceptions to invariant #2 that invariant #4 (no silent failures)
// requires: a job the reaper finalizes must never leave the user with nothing.
const ORPHAN_RESET_NOTICE =
  "⚠️ Cette tâche a été interrompue (le service a redémarré ou s'est arrêté en cours d'exécution) et n'a pas pu être terminée. Relancez-la si besoin.";
const STALE_PENDING_NOTICE =
  "⚠️ Cette tâche n'a jamais été prise en charge par un worker (démarrage manqué) et a été abandonnée. Relancez-la si besoin.";
const APPROVAL_EXPIRED_NOTICE =
  '⚠️ Cette action attendait votre approbation mais le délai a expiré sans réponse. La tâche a été arrêtée ; relancez-la si vous souhaitez la reprendre.';

/**
 * Best-effort: deliver a finalized job's failure notice to its Telegram chat so
 * the reaper's outcome is never silent (D1, audit followup). No-ops for jobs
 * with no bot/chat (dashboard/api/cron). A delivery failure only logs.
 */
async function notifyJobFailure(db: AnyDrizzleDb, jobId: string, notice: string): Promise<void> {
  try {
    const target = await resolveTelegramDeliveryTarget(db as unknown as RunnerDeps['db'], jobId);
    if (!target) return;
    await sendTelegramMessage({ botToken: target.botToken, chatId: target.chatId, text: notice });
  } catch (err) {
    console.warn(
      `[reset-orphans] failed to deliver failure notice for job ${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ─── resetOrphanedTasks ───────────────────────────────────────────────────────

/**
 * Reset tasks that are `in_progress` but have no `job_id` and have been
 * stuck for more than `staleMinutes` minutes (default 5).
 *
 * This covers the case where the machine suspended between the atomic claim
 * (status → in_progress) and the job creation step. Without this reset those
 * tasks would be stuck forever.
 *
 * Also FINALIZES tasks whose linked job has already reached a terminal state
 * (completed / failed / cancelled) but were never marked — mirrors the job
 * outcome onto the task (done / blocked). It must NEVER reset such a task to
 * `todo`: re-running a task whose job already completed re-executes successful
 * work (live: the same agent posted to its MCP endpoint 3x). With the per-job marking
 * in executeReadyTasks this is now a rare safety net (genuine crash between job
 * finish and task mark), not the common path.
 *
 * @returns count of tasks reset/finalized
 */
export async function resetOrphanedTasks(db: AnyDrizzleDb, staleMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  // Case A: in_progress with no job_id, locked_at older than cutoff
  const caseA = await db
    .update(agentTasks)
    .set({
      status: 'todo',
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTasks.status, 'in_progress'),
        isNull(agentTasks.jobId),
        or(isNull(agentTasks.lockedAt), lt(agentTasks.lockedAt, cutoff)),
      ),
    )
    .returning({ id: agentTasks.id });

  // Case B: in_progress tasks whose linked job has already reached a terminal
  // state but were never marked. Mirror the job outcome onto the task — done if
  // the job completed, blocked if it failed/cancelled — NEVER reset to 'todo'
  // (which re-runs already-completed work). Pull the job status + result in one
  // join, then finalize each terminal one with a conditional UPDATE.
  const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'];
  const inProgressTasks = await db
    .select({
      taskId: agentTasks.id,
      jobStatus: agentJobs.status,
      jobResult: agentJobs.result,
      jobError: agentJobs.error,
    })
    .from(agentTasks)
    .innerJoin(agentJobs, eq(agentTasks.jobId, agentJobs.id))
    .where(eq(agentTasks.status, 'in_progress'));

  let caseBCount = 0;
  for (const t of inProgressTasks) {
    if (!t.jobStatus || !TERMINAL_JOB_STATUSES.includes(t.jobStatus)) continue;
    const taskStatus = t.jobStatus === 'completed' ? 'done' : 'blocked';
    const taskResult =
      t.jobStatus === 'completed'
        ? (t.jobResult ?? '')
        : (t.jobResult ?? t.jobError ?? 'job ended without a result');
    const updated = await db
      .update(agentTasks)
      .set({
        status: taskStatus,
        result: taskResult,
        lockedBy: null,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(agentTasks.id, t.taskId), eq(agentTasks.status, 'in_progress')))
      .returning({ id: agentTasks.id });
    caseBCount += updated.length;
  }

  return caseA.length + caseBCount;
}

// ─── resetOrphanedJobs ────────────────────────────────────────────────────────

/**
 * Mark as `failed` any job stuck in `processing` or `awaiting_delegation`
 * whose `updated_at` is older than `staleMinutes` minutes (default 5).
 *
 * Covers Ctrl+C / crash / laptop-suspend during execution: the runner died
 * mid-loop and nothing else will ever advance these rows, so they pile up in
 * the dashboard. Marking them `failed` (not `cancelled`) is intentional — the
 * job started, then state was lost; that's a failure outcome.
 *
 * Both `processing → failed` and `awaiting_delegation → failed` are valid
 * transitions (see job/state.ts VALID_TRANSITIONS).
 *
 * IMPORTANT: a parent in `awaiting_delegation` whose sub-job is still alive
 * (not in a terminal state) is NOT orphaned — it's legitimately waiting.
 * Caught live on job `58e38faa` whose Summarizer sub-job took 7.5 min for
 * a deep research. Without this guard the parent gets nuked at the 5-min
 * mark even though everything is working fine. For those rows we bump
 * `updated_at` so the staleness timer restarts (next tick re-evaluates).
 *
 * @returns count of jobs actually reset (not bumped)
 */
export async function resetOrphanedJobs(db: AnyDrizzleDb, staleMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  // 1. Find candidate stale jobs (current criteria — same as before).
  const candidates = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      pendingDelegation: agentJobs.pendingDelegation,
    })
    .from(agentJobs)
    .where(
      and(
        inArray(agentJobs.status, ['processing', 'awaiting_delegation']),
        lt(agentJobs.updatedAt, cutoff),
      ),
    );

  // Sub-job statuses that mean "still alive, parent is legitimately waiting".
  // Anything else (completed/failed/cancelled or missing row) means the parent
  // is truly orphaned — its child won't ever resume it.
  const ACTIVE_SUBJOB_STATUSES = [
    'pending',
    'processing',
    'awaiting_delegation',
    'awaiting_approval',
    'awaiting_tasks',
  ];

  const toReset: string[] = [];
  const toBump: string[] = [];

  for (const c of candidates) {
    if (c.status === 'awaiting_delegation') {
      const pending = c.pendingDelegation as { subJobId?: string } | null;
      const subId = pending?.subJobId;
      if (subId) {
        const [sub] = await db
          .select({ status: agentJobs.status })
          .from(agentJobs)
          .where(eq(agentJobs.id, subId))
          .limit(1);
        if (sub && ACTIVE_SUBJOB_STATUSES.includes(sub.status ?? '')) {
          // Sub still running — parent waits legitimately. Skip the reset
          // AND bump updated_at so the next cron tick doesn't immediately
          // re-evaluate this row (avoids burning a select per tick on every
          // long-running delegation).
          toBump.push(c.id);
          continue;
        }
      }
    }

    // A planner orchestrator that fanned out via create_task sits in
    // `processing` while its task board runs — and gets NO heartbeat once it
    // hands off. If it still has outstanding (non-terminal) tasks rooted at it,
    // it is legitimately waiting, NOT orphaned. Reaping it here would be fatal:
    // the reap stamps completed_at, and deliverCompletedRoots (gated on
    // completed_at IS NULL) would then skip the fan-in forever, leaving the
    // parent stuck `failed`. Bump instead — same as the awaiting_delegation
    // guard. (Live: parent 7aa6ad96 reaped at the 5-min mark while its 4 tasks
    // still ran.)
    const [outstandingTask] = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(
        and(eq(agentTasks.rootJobId, c.id), inArray(agentTasks.status, ['todo', 'in_progress'])),
      )
      .limit(1);
    if (outstandingTask) {
      toBump.push(c.id);
      continue;
    }

    toReset.push(c.id);
  }

  if (toBump.length > 0) {
    await db.update(agentJobs).set({ updatedAt: new Date() }).where(inArray(agentJobs.id, toBump));
  }

  // Finalize each via failJob rather than one blanket UPDATE (D1/D2, audit
  // followup). failJob is (a) conditional on the row NOT being terminal, so a
  // job that legitimately finished between the snapshot above and now is NOT
  // clobbered from completed→failed (D2 — the old bulk UPDATE keyed only on id),
  // and (b) fills the user-facing `result` with an explanation so the outcome is
  // never silent (D1). Then deliver that notice to the job's channel.
  let reset = 0;
  for (const jobId of toReset) {
    const landed = await failJob(
      db,
      jobId,
      'orphan_job_reset',
      undefined,
      undefined,
      ORPHAN_RESET_NOTICE,
    );
    if (landed) {
      reset += 1;
      await notifyJobFailure(db, jobId, ORPHAN_RESET_NOTICE);
    }
  }

  return reset;
}

// ─── pending recovery ─────────────────────────────────────────────────────────

/**
 * Find `pending` jobs within the "stuck-but-still-relevant" age window
 * and return their IDs for the caller to drive through executeJob.
 *
 * Why this exists: the Telegram poller (and other job creators) call
 * `triggerWorker(jobId)` fire-and-forget over HTTP to `/api/worker`.
 * That fetch has a `.catch(() => {})` swallow — any transient failure
 * (runner mid-restart, port held by a stale-zombie process on Windows
 * see `feedback_windows_process_tree_kill`, network blip) drops the
 * job into `pending` forever because nothing else periodically claims
 * stale pending rows.
 *
 * Observed live (2026-05-26, job e846a3e1): the user sent a Telegram
 * message, the poller inserted the row, the triggerWorker fetch hit a
 * zombie runner on port 3001 instead of the live one, fetch silently
 * failed, job sat pending for 3+ minutes with no recovery path.
 *
 * Age bounds matter:
 *   - Lower (default 30s): pending → processing should normally happen
 *     within ~50ms of insert; anything older than 30s is almost
 *     certainly a missed trigger and worth a recovery attempt.
 *   - Upper (default 5min, same as `resetOrphanedJobs`): older pending
 *     rows are abandoned, NOT recovered. Silently waking up a 4-day-old
 *     task because the user typed it before the runner zombie-locked
 *     would be a horror-show UX (live miss 2026-05-26, job 03cd4304
 *     created 4 days earlier and silently resurrected by an earlier
 *     version of this recovery). Caller passes those to
 *     `failStalePendingJobs` below to mark them failed instead.
 *
 * We DON'T touch the row here — the caller passes each id to
 * executeJob, which atomically claims via `claimJob` (status flip with
 * WHERE), so two concurrent ticks can't double-execute the same job.
 */
export async function findPendingJobsToRecover(
  db: AnyDrizzleDb,
  staleSecondsLower = 30,
  staleSecondsUpper = 5 * 60,
): Promise<string[]> {
  const lowerCutoff = new Date(Date.now() - staleSecondsLower * 1000);
  const upperCutoff = new Date(Date.now() - staleSecondsUpper * 1000);
  // `updated_at` (not `created_at`) so jobs bumped back to pending by
  // resumeDelegated / approval / self-chain reset are evaluated against
  // their LAST touch, not their original insert.
  // `updated_at < lowerCutoff` = older than 30s ago.
  // `updated_at >= upperCutoff` = NOT older than 5min ago.
  const rows = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(
      and(
        eq(agentJobs.status, 'pending'),
        lt(agentJobs.updatedAt, lowerCutoff),
        gte(agentJobs.updatedAt, upperCutoff),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Mark `pending` jobs older than `staleSeconds` as failed with a
 * dedicated error code, so they don't sit forever in the DB as junk and
 * — more importantly — don't get silently resurrected by recovery on a
 * later boot. Threshold matches `resetOrphanedJobs`: anything stuck >5min
 * past its last update is abandoned, full stop.
 *
 * The error code is distinct from `orphan_job_reset` (which is for
 * processing/awaiting jobs) so the dashboard can tell users "this job
 * was never picked up by a worker" vs "this job started but the runner
 * crashed mid-flight" — different remediation.
 */
export async function failStalePendingJobs(
  db: AnyDrizzleDb,
  staleSeconds = 5 * 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleSeconds * 1000);
  // Select the candidates, then finalize each via failJob so the user gets a
  // `result` explanation AND a channel notice — never a silent abandon (D1).
  // failJob's non-terminal guard also protects against a job that flipped out of
  // pending between this select and the write.
  const stale = await db
    .select({ id: agentJobs.id })
    .from(agentJobs)
    .where(and(eq(agentJobs.status, 'pending'), lt(agentJobs.updatedAt, cutoff)));

  let failed = 0;
  for (const { id } of stale) {
    const landed = await failJob(
      db,
      id,
      'stale_pending_abandoned',
      undefined,
      undefined,
      STALE_PENDING_NOTICE,
    );
    if (landed) {
      failed += 1;
      await notifyJobFailure(db, id, STALE_PENDING_NOTICE);
    }
  }
  return failed;
}

// ─── approval TTL ───────────────────────────────────────────────────────────────

/**
 * Expire pending approvals whose TTL (`expires_at`, default now + 1h) has passed
 * and finalize the jobs waiting on them (D3, audit followup). The column was set
 * at creation but NOTHING ever acted on it, so an approval no one answered left
 * its job stuck in `awaiting_approval` forever. Marks the approval `expired`,
 * fails the still-waiting job with a user-facing notice, and delivers it.
 *
 * @returns count of jobs failed for an expired approval
 */
export async function expireStaleApprovals(db: AnyDrizzleDb): Promise<number> {
  const now = new Date();
  const expired = await db
    .update(approvalRequests)
    .set({ status: 'expired', resolvedAt: now, resolvedBy: 'system:ttl_expired' })
    .where(and(eq(approvalRequests.status, 'pending'), lt(approvalRequests.expiresAt, now)))
    .returning({ jobId: approvalRequests.jobId });

  let failed = 0;
  for (const { jobId } of expired) {
    // Only finalize a job that is STILL awaiting this approval — never touch one
    // that already moved on (approved elsewhere, cancelled, completed). failJob's
    // own non-terminal guard is the backstop; this keeps us from failing a live
    // `pending`/`processing` job that merely had a stale approval row.
    const [job] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId))
      .limit(1);
    if (job?.status !== 'awaiting_approval') continue;

    const landed = await failJob(
      db,
      jobId,
      'approval_expired',
      undefined,
      undefined,
      APPROVAL_EXPIRED_NOTICE,
    );
    if (landed) {
      failed += 1;
      await notifyJobFailure(db, jobId, APPROVAL_EXPIRED_NOTICE);
    }
  }
  return failed;
}
