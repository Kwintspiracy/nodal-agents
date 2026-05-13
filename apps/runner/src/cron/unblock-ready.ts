// cron/unblock-ready.ts — unblockReadyTasks
// Find tasks where status='todo' AND depends_on is non-empty AND all deps are done.
// For each such task, inject dep results into context.deps and leave status as 'todo'
// (the executeReadyTasks phase will claim them next).

import { and, eq, inArray, isNotNull } from '@nodal-agents/db';
import { agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

// ─── unblockReadyTasks ────────────────────────────────────────────────────────

/**
 * For each `todo` task with non-empty `depends_on` where all deps are `done`:
 * 1. Read each dep's `result` column
 * 2. Merge into the task's `context.deps` as `{ [depId]: result }`
 * 3. Leave status as `todo` — executeReadyTasks will claim it on this tick
 *
 * Returns count of tasks unblocked (context updated).
 */
export async function unblockReadyTasks(db: AnyDrizzleDb): Promise<number> {
  // Find all `todo` tasks that have at least one dependency
  // (depends_on is not empty — we filter in-memory since array length check in SQL is verbose)
  const todoWithDeps = await db
    .select({
      id: agentTasks.id,
      dependsOn: agentTasks.dependsOn,
      context: agentTasks.context,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.status, 'todo'), isNotNull(agentTasks.dependsOn)));

  // Filter to only those with non-empty depends_on
  const candidateTasks = todoWithDeps.filter(
    (t) => Array.isArray(t.dependsOn) && (t.dependsOn as string[]).length > 0,
  );

  if (candidateTasks.length === 0) return 0;

  let unblocked = 0;

  for (const task of candidateTasks) {
    const depIds = task.dependsOn as string[];

    // Load all dep rows
    const depRows = await db
      .select({
        id: agentTasks.id,
        status: agentTasks.status,
        title: agentTasks.title,
        result: agentTasks.result,
      })
      .from(agentTasks)
      .where(inArray(agentTasks.id, depIds));

    // All deps must be 'done' (not just some of them)
    if (depRows.length !== depIds.length) continue; // some deps don't exist yet
    const allDone = depRows.every((d) => d.status === 'done');
    if (!allDone) continue;

    // Build dep results map
    const depResults: Record<string, string> = {};
    for (const dep of depRows) {
      depResults[dep.id] = dep.result ?? '';
    }

    // Merge into existing context
    const existingContext =
      typeof task.context === 'object' && task.context !== null
        ? (task.context as Record<string, unknown>)
        : {};

    const newContext: Record<string, unknown> = {
      ...existingContext,
      deps: depResults,
    };

    // Conditional update — only if still 'todo' (idempotency)
    const updated = await db
      .update(agentTasks)
      .set({
        context: newContext,
        updatedAt: new Date(),
      })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'todo')))
      .returning({ id: agentTasks.id });

    unblocked += updated.length;
  }

  return unblocked;
}
