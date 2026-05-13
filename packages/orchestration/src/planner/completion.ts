// planner/completion.ts — check if all tasks for a root_job_id are done
// Used by the cron/delivery layer to know when to compile and deliver results.

import { eq, and } from '@nodal-agents/db';
import { agentTasks } from '@nodal-agents/db';
import type { JobId, AnyDrizzleDb } from '../types';

// ─── checkRootJobComplete ─────────────────────────────────────────────────────

/**
 * Returns true when all tasks for a given root_job_id are in a terminal state
 * ('done', 'cancelled', or 'blocked').
 *
 * Returns false if:
 * - There are no tasks for this root_job_id (nothing was created yet)
 * - Any task is still 'todo' or 'in_progress'
 *
 * This is the trigger condition for `_deliver_compiled_task_results()`.
 */
export async function checkRootJobComplete(rootJobId: JobId, db: AnyDrizzleDb): Promise<boolean> {
  const taskRows = await db
    .select({ id: agentTasks.id, status: agentTasks.status })
    .from(agentTasks)
    .where(eq(agentTasks.rootJobId, rootJobId as string));

  if (taskRows.length === 0) {
    // No tasks created — nothing to deliver
    return false;
  }

  const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'blocked']);
  return taskRows.every((t: { id: string; status: string }) => TERMINAL_STATUSES.has(t.status));
}

// ─── getPendingTasksForRoot ───────────────────────────────────────────────────

/**
 * Get all non-terminal tasks for a root_job_id.
 * Used by cron to find tasks to execute this tick.
 */
export async function getPendingTasksForRoot(
  rootJobId: JobId,
  db: AnyDrizzleDb,
  maxTasks = 5,
): Promise<
  Array<{
    id: string;
    title: string;
    assignedAgentId: string | null;
    dependsOn: string[];
    context: unknown;
  }>
> {
  const rows = await db
    .select({
      id: agentTasks.id,
      title: agentTasks.title,
      assignedAgentId: agentTasks.assignedAgentId,
      dependsOn: agentTasks.dependsOn,
      context: agentTasks.context,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.rootJobId, rootJobId as string), eq(agentTasks.status, 'todo')))
    .limit(maxTasks);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    assignedAgentId: r.assignedAgentId,
    dependsOn: (r.dependsOn ?? []) as string[],
    context: r.context,
  }));
}
