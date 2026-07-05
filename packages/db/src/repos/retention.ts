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
 * Finding F-7: on a large backlog, collecting every prunable job id and
 * passing them all to a single `inArray(...)` DELETE (and the `inArray(...)`
 * COUNT before it) can exceed Postgres's bind-parameter limit (~65535),
 * stalling retention permanently the moment the backlog crosses that size.
 * Batched instead: each iteration selects up to `batchSize` prunable ids,
 * counts + deletes just that batch (one transaction per batch, not one giant
 * transaction spanning the whole backlog), and loops until nothing prunable
 * remains. A batch smaller than `batchSize` means the backlog is cleared.
 *
 * @param db            Drizzle db instance (any driver).
 * @param retentionDays Number of days to keep. 0 or negative = no-op.
 * @param batchSize     Max job ids per DELETE. Default 1000 — comfortably
 *                       under the bind-parameter limit even counting the
 *                       tool_calls lookup's own `inArray` on the same ids.
 */
export async function pruneOldJobs(
  db: AnyDrizzleDb,
  retentionDays: number,
  batchSize = 1000,
): Promise<PruneResult> {
  if (retentionDays <= 0) {
    return { jobsDeleted: 0, toolCallsDeleted: 0 };
  }

  // Use make_interval so the interval is parameterised, not string-interpolated.
  // The cutoff expression: now() - make_interval(days => $retentionDays)
  const cutoffExpr = sql`now() - make_interval(days => ${retentionDays})`;

  let jobsDeleted = 0;
  let toolCallsDeleted = 0;

  for (;;) {
    // Find the job IDs to prune first so we can count their tool_calls.
    // We do this inside a transaction so the count and delete are atomic.
    const batch = await db.transaction(async (tx) => {
      // Collect one batch of prunable job ids — never the whole backlog.
      const prunableRows = await tx
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(
          sql`${agentJobs.status} IN ('completed','failed','cancelled')
              AND ${agentJobs.completedAt} < ${cutoffExpr}`,
        )
        .limit(batchSize);

      if (prunableRows.length === 0) {
        return null;
      }

      const jobIds = prunableRows.map((r) => r.id);

      // Count tool_calls before deletion (they'll cascade away with the jobs).
      const [tcCountRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(toolCalls)
        .where(inArray(toolCalls.jobId, jobIds));

      const batchToolCallsDeleted = tcCountRow?.n ?? 0;

      // Delete the jobs — cascades to tool_calls + approval_requests automatically.
      await tx.delete(agentJobs).where(inArray(agentJobs.id, jobIds));

      return { jobsDeleted: jobIds.length, toolCallsDeleted: batchToolCallsDeleted };
    });

    if (batch === null) break;

    jobsDeleted += batch.jobsDeleted;
    toolCallsDeleted += batch.toolCallsDeleted;

    // A partial batch (fewer rows than requested) means there's nothing left
    // to prune — stop instead of issuing one more (empty) round-trip.
    if (batch.jobsDeleted < batchSize) break;
  }

  return { jobsDeleted, toolCallsDeleted };
}
