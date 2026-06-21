// repos/retention.ts — DB retention: prune old terminal agent_jobs
//
// OFF by default (retentionDays = 0). Called each cron tick when
// RETENTION_DAYS > 0 in the runner env.
//
// FK behaviour when deleting agent_jobs rows:
//   tool_calls.job_id          → ON DELETE CASCADE  (deleted automatically)
//   approval_requests.job_id   → ON DELETE CASCADE  (deleted automatically)
//   chat_messages.job_id       → ON DELETE SET NULL (messages kept, link cleared)
//   agent_tasks.job_id         → ON DELETE SET NULL (tasks kept, link cleared)
//
// Because both tool_calls and approval_requests cascade, a single DELETE on
// agent_jobs is sufficient — no explicit child-delete needed. We COUNT
// tool_calls before the delete so we can return a meaningful metric.

import { sql, inArray } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agentJobs, toolCalls } from '../schema/index.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PruneResult {
  jobsDeleted: number;
  toolCallsDeleted: number;
}

// ─── pruneOldJobs ─────────────────────────────────────────────────────────────

/**
 * Delete terminal agent_jobs (completed / failed / cancelled) whose
 * completed_at is older than `retentionDays` days.
 *
 * Returns the count of pruned jobs and their associated tool_calls.
 *
 * @param db            Drizzle db instance (any driver).
 * @param retentionDays Number of days to keep. 0 or negative = no-op.
 */
export async function pruneOldJobs(db: AnyDrizzleDb, retentionDays: number): Promise<PruneResult> {
  if (retentionDays <= 0) {
    return { jobsDeleted: 0, toolCallsDeleted: 0 };
  }

  // Use make_interval so the interval is parameterised, not string-interpolated.
  // The cutoff expression: now() - make_interval(days => $retentionDays)
  const cutoffExpr = sql`now() - make_interval(days => ${retentionDays})`;

  // Find the job IDs to prune first so we can count their tool_calls.
  // We do this inside a transaction so the count and delete are atomic.
  return db.transaction(async (tx) => {
    // Collect prunable job ids
    const prunableRows = await tx
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        sql`${agentJobs.status} IN ('completed','failed','cancelled')
            AND ${agentJobs.completedAt} < ${cutoffExpr}`,
      );

    if (prunableRows.length === 0) {
      return { jobsDeleted: 0, toolCallsDeleted: 0 };
    }

    const jobIds = prunableRows.map((r) => r.id);

    // Count tool_calls before deletion (they'll cascade away with the jobs).
    const [tcCountRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(toolCalls)
      .where(inArray(toolCalls.jobId, jobIds));

    const toolCallsDeleted = tcCountRow?.n ?? 0;

    // Delete the jobs — cascades to tool_calls + approval_requests automatically.
    await tx.delete(agentJobs).where(inArray(agentJobs.id, jobIds));

    return { jobsDeleted: jobIds.length, toolCallsDeleted };
  });
}
