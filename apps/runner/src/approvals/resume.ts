// approvals/resume.ts — the ONE way a job leaves `awaiting_approval`.
//
// Three callers reach this: a human decision (`resolve.ts`, dashboard or
// Telegram), and the TTL sweep (`cron/reset-orphans.ts`) that marks an
// unanswered request `expired`. They differ in WHAT they write on the
// approval row; they must not differ in how the job comes back, or an
// expired request would resume through a second, subtly different path.
//
// The flip is conditional on `awaiting_approval` (B1): a job cancelled while
// its approval sat open is terminal, and neither a late tap nor the sweep may
// resurrect it.

import { and, eq } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';

export type ApprovalResumeOutcome =
  /**
   * The usual path: the job was `awaiting_approval`, is now `pending`, and the
   * worker was triggered (when a `runnerEnv` was given).
   */
  | { resumed: 'worker' }
  /**
   * The job's OWN executeJob is already past `awaiting_approval` (grace-window
   * poll, or resumed by an earlier decision): it will see the row on its next
   * poll, so triggering a second runner here would race it.
   */
  | { resumed: 'in_process' }
  /** Terminal (cancelled / completed / failed) or gone: nothing to resume. */
  | { resumed: null; status: string | null };

/**
 * Bring a job back from `awaiting_approval` after the request it waited on was
 * written to a final status. The approval row itself is the caller's business
 * and must already be written: this only moves the job.
 *
 * `runnerEnv` is optional — a cron caller has none. The flip still lands, and
 * the tick's pending-job recovery phase is the fallback trigger (same pattern
 * as `reviveJobIfApprovalResolvedDuringSuspend`).
 */
export async function resumeJobAfterApprovalResolution(
  db: AnyDrizzleDb,
  jobId: string,
  runnerEnv?: RunnerEnv,
): Promise<ApprovalResumeOutcome> {
  const resumed = await db
    .update(agentJobs)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'awaiting_approval')))
    .returning({ id: agentJobs.id });

  if (resumed.length > 0) {
    if (runnerEnv) void triggerWorker(jobId, runnerEnv);
    return { resumed: 'worker' };
  }

  // Zero rows covers two very different cases — re-read to tell them apart.
  const [current] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if (current?.status === 'processing' || current?.status === 'pending') {
    return { resumed: 'in_process' };
  }
  return { resumed: null, status: current?.status ?? null };
}
