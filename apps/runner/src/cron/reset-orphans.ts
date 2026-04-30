// cron/reset-orphans.ts — resetOrphanedTasks + resetOrphanedJobs
// Two cleanup phases for state left behind by abrupt shutdown (Ctrl+C, crash,
// suspended laptop). Without these, the dashboard accumulates stuck rows that
// can never recover on their own.
//   - resetOrphanedTasks: tasks claimed but never executed → back to `todo`
//   - resetOrphanedJobs:  jobs in `processing` / `awaiting_delegation` with
//                         no recent activity → marked `failed`

import { and, eq, inArray, isNull, lt, or } from '@nodalai/db';
import { agentJobs, agentTasks } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';

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
 * @returns count of jobs reset
 */
export async function resetOrphanedJobs(db: AnyDrizzleDb, staleMinutes = 5): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  const updated = await db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: 'orphan_job_reset',
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(agentJobs.status, ['processing', 'awaiting_delegation']),
        lt(agentJobs.updatedAt, cutoff),
      ),
    )
    .returning({ id: agentJobs.id });

  return updated.length;
}
