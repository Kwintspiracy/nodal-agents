// cron/reset-orphans.ts — resetOrphanedTasks + resetOrphanedJobs
// Two cleanup phases for state left behind by abrupt shutdown (Ctrl+C, crash,
// suspended laptop). Without these, the dashboard accumulates stuck rows that
// can never recover on their own.
//   - resetOrphanedTasks: tasks claimed but never executed → back to `todo`
//   - resetOrphanedJobs:  jobs in `processing` / `awaiting_delegation` with
//                         no recent activity → marked `failed`

import { and, eq, gte, inArray, isNull, lt, or } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

// ─── resetOrphanedTasks ───────────────────────────────────────────────────────

/**
 * Reset tasks that are `in_progress` but have no `job_id` and have been
 * stuck for more than `staleMinutes` minutes (default 5).
 *
 * This covers the case where the machine suspended between the atomic claim
 * (status → in_progress) and the job creation step. Without this reset those
 * tasks would be stuck forever.
 *
 * Also resets tasks whose linked job has already reached a terminal state
 * (completed / failed / cancelled) — the task board cron will re-evaluate
 * and either mark them done or re-run them.
 *
 * @returns count of tasks reset
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

  // Case B: in_progress where the linked job is in a terminal state
  // (job completed/failed/cancelled but task was never marked done — stale claim)
  // We do this with a subquery approach: find tasks in_progress whose job is terminal.
  //
  // Drizzle doesn't support a direct "WHERE job_id IN (SELECT id FROM agent_jobs WHERE status IN (...))"
  // in an UPDATE without raw SQL, so we select first, then update.
  const terminalJobRows = await db
    .select({ taskId: agentTasks.id })
    .from(agentTasks)
    .innerJoin(agentJobs, eq(agentTasks.jobId, agentJobs.id))
    .where(
      and(
        eq(agentTasks.status, 'in_progress'),
        // Job reached a terminal state — task was never cleaned up
        // We use a workaround: select tasks whose job is not in active states
      ),
    );

  // Re-check: filter only those whose job is in terminal state
  const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'];
  const terminalTaskIds: string[] = [];

  for (const row of terminalJobRows) {
    const jobRows = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .innerJoin(agentTasks, eq(agentJobs.id, agentTasks.jobId))
      .where(and(eq(agentTasks.id, row.taskId), eq(agentTasks.status, 'in_progress')))
      .limit(1);

    const jobStatus = jobRows[0]?.status;
    if (jobStatus && TERMINAL_JOB_STATUSES.includes(jobStatus)) {
      terminalTaskIds.push(row.taskId);
    }
  }

  let caseBCount = 0;
  if (terminalTaskIds.length > 0) {
    // Reset each one atomically (conditional update to avoid race)
    for (const taskId of terminalTaskIds) {
      const updated = await db
        .update(agentTasks)
        .set({
          status: 'todo',
          lockedBy: null,
          lockedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'in_progress')))
        .returning({ id: agentTasks.id });
      caseBCount += updated.length;
    }
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
    toReset.push(c.id);
  }

  if (toBump.length > 0) {
    await db.update(agentJobs).set({ updatedAt: new Date() }).where(inArray(agentJobs.id, toBump));
  }

  if (toReset.length > 0) {
    await db
      .update(agentJobs)
      .set({
        status: 'failed',
        error: 'orphan_job_reset',
        updatedAt: new Date(),
      })
      .where(inArray(agentJobs.id, toReset));
  }

  return toReset.length;
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
  const now = new Date();
  const result = await db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: 'stale_pending_abandoned',
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agentJobs.status, 'pending'), lt(agentJobs.updatedAt, cutoff)))
    .returning({ id: agentJobs.id });
  return result.length;
}
