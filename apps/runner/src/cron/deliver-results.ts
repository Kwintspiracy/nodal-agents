// cron/deliver-results.ts — deliverCompletedRoots
// For each root_job_id whose tasks are all terminal (done/failed/cancelled),
// compile results, call delivery stub, mark root job completed, and stamp a
// delivery_done flag so the same root is never delivered twice.
//
// Idempotency: we check delivered_at on root job (completedAt is set when
// we deliver). A second tick finds the root job already completed and skips.

import { and, eq, isNotNull, isNull } from '@nodalai/db';
import { agentJobs, agentTasks } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import { checkRootJobComplete } from '@nodalai/orchestration';
import type { JobId } from '@nodalai/orchestration';
import { deliverResult } from '../job/delivery-stub.ts';

// ─── deliverCompletedRoots ────────────────────────────────────────────────────

/**
 * Bug from legacy (inject_delegation.wrong_status): task results were silently
 * lost because delivery was only triggered on the parent job completing, but
 * planner tasks run async AFTER the parent job completes. This function finds
 * all root jobs whose tasks have all finished and delivers the compiled result.
 *
 * Idempotency: each root job is delivered at most once. The root job's
 * `completedAt` column is used as the delivery-done flag — if it's already
 * set, we skip. The update is conditional (`WHERE completed_at IS NULL`) to
 * prevent double-delivery under concurrent ticks.
 *
 * @returns count of root jobs delivered
 */
export async function deliverCompletedRoots(db: AnyDrizzleDb): Promise<number> {
  // Find distinct root_job_ids that have at least one task and haven't been delivered
  const rootJobCandidates = await db
    .selectDistinct({ rootJobId: agentTasks.rootJobId })
    .from(agentTasks)
    .where(isNotNull(agentTasks.rootJobId));

  if (rootJobCandidates.length === 0) return 0;

  let delivered = 0;

  for (const row of rootJobCandidates) {
    const rootJobId = row.rootJobId!;

    // Check if root job already delivered (completedAt is set)
    const rootJobRows = await db
      .select({
        id: agentJobs.id,
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        channel: agentJobs.channel,
        chatId: agentJobs.chatId,
        agentId: agentJobs.agentId,
        entityId: agentJobs.entityId,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJobId))
      .limit(1);

    const rootJob = rootJobRows[0];
    if (!rootJob) continue; // root job doesn't exist (orphaned tasks)
    if (rootJob.completedAt !== null) continue; // already delivered

    // Check if all tasks for this root are in terminal states
    const complete = await checkRootJobComplete(rootJobId as JobId, db);
    if (!complete) continue;

    // Load all task results to compile
    const taskRows = await db
      .select({
        id: agentTasks.id,
        title: agentTasks.title,
        status: agentTasks.status,
        result: agentTasks.result,
      })
      .from(agentTasks)
      .where(eq(agentTasks.rootJobId, rootJobId));

    const compiledResult = compileTaskResults(taskRows);

    // Atomic claim: only deliver if root job completedAt is still NULL
    // This prevents double-delivery under concurrent ticks (invariant from spec).
    const claimed = await db
      .update(agentJobs)
      .set({
        status: 'completed',
        result: compiledResult,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentJobs.id, rootJobId),
          isNull(agentJobs.completedAt), // gate: only one tick wins
        ),
      )
      .returning({ id: agentJobs.id });

    if (claimed.length === 0) {
      // Another concurrent tick won the race — skip delivery
      continue;
    }

    // Deliver via the stub (Brique 15 will implement Telegram/email)
    await deliverResult({
      channel: rootJob.channel ?? 'internal',
      chatId: rootJob.chatId ?? null,
      result: compiledResult,
      jobId: rootJobId,
      agentId: rootJob.agentId ?? null,
      entityId: rootJob.entityId ?? null,
    });

    delivered++;
  }

  return delivered;
}

// ─── compileTaskResults ───────────────────────────────────────────────────────

/**
 * Concatenate task results with their titles as section headers.
 * Done tasks show their result; failed/blocked tasks show the error.
 */
function compileTaskResults(
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    result: string | null;
  }>,
): string {
  if (tasks.length === 0) return '';

  return tasks
    .map((t) => {
      const statusTag = t.status === 'done' ? '' : ` [${t.status}]`;
      const body = t.result?.trim() ?? '';
      return `## ${t.title}${statusTag}\n${body || '(no result)'}`;
    })
    .join('\n\n---\n\n');
}
