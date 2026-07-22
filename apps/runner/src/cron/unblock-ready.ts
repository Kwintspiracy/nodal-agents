// cron/unblock-ready.ts — unblockReadyTasks
// Find tasks where status='todo' AND depends_on is non-empty AND all deps are done.
// For each such task, inject dep results into context.deps and leave status as 'todo'
// (the executeReadyTasks phase will claim them next).
//
// A dependency that finished 'blocked' or 'cancelled' can never become 'done'
// — waiting for that would leave the dependent task in 'todo' forever, which
// in turn keeps the root job non-terminal forever (checkRootJobComplete
// requires every task to be terminal), so deliverCompletedRoots never fires:
// a silent stall (audit finding OR-4). We treat that case as
// resolved-failed and propagate the failure onto the dependent task instead.

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

  // Batch-load every dependency referenced by any candidate task in ONE query
  // (previously one `SELECT ... WHERE id IN (...)` per candidate — N+1, and
  // unlike executeReadyTasks this loop is unbounded: every `todo` task with
  // deps, not just the first `max`).
  const allDepIds = [...new Set(candidateTasks.flatMap((t) => t.dependsOn as string[]))];
  const depRowsById = new Map<
    string,
    { id: string; status: string; title: string; result: string | null }
  >();
  if (allDepIds.length > 0) {
    const allDepRows = await db
      .select({
        id: agentTasks.id,
        status: agentTasks.status,
        title: agentTasks.title,
        result: agentTasks.result,
      })
      .from(agentTasks)
      .where(inArray(agentTasks.id, allDepIds));
    for (const row of allDepRows) {
      depRowsById.set(row.id, row);
    }
  }

  let unblocked = 0;

  for (const task of candidateTasks) {
    const depIds = task.dependsOn as string[];

    // Load all dep rows (in-memory lookup against the batch load above)
    const depRows = depIds
      .map((id) => depRowsById.get(id))
      .filter(
        (d): d is { id: string; status: string; title: string; result: string | null } =>
          d !== undefined,
      );

    if (depRows.length !== depIds.length) {
      // A dependency ROW IS GONE. Deps are validated to exist at create_task
      // time (C1), so a missing one here means it was cascade-deleted (its agent
      // or entity was removed) — it will never come back. Terminalize this task
      // as `blocked` instead of leaving it `todo` forever (D4, audit followup):
      // otherwise the root job never becomes terminal and deliverCompletedRoots
      // never fires — a silent stall, exactly the class OR-4/this file guards.
      const foundIds = new Set(depRows.map((d) => d.id));
      const missing = depIds.filter((id) => !foundIds.has(id));
      const updated = await db
        .update(agentTasks)
        .set({
          status: 'blocked',
          result: `Blocked: ${
            missing.length > 1 ? 'dependencies were' : 'a dependency was'
          } removed before this task could run (${missing.join(', ')}).`,
          updatedAt: new Date(),
        })
        .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'todo')))
        .returning({ id: agentTasks.id });
      unblocked += updated.length;
      continue;
    }

    const stillPending = depRows.filter(
      (d) => d.status !== 'done' && d.status !== 'blocked' && d.status !== 'cancelled',
    );
    if (stillPending.length > 0) continue; // still waiting on at least one dep

    const failedDeps = depRows.filter((d) => d.status === 'blocked' || d.status === 'cancelled');
    if (failedDeps.length > 0) {
      // At least one dep is terminal-but-not-done and will never become
      // 'done' — this task can never legitimately run. Mark it blocked
      // (terminal) now rather than leave it in 'todo' forever.
      const reason = failedDeps.map((d) => `"${d.title}" (${d.status})`).join(', ');
      const updated = await db
        .update(agentTasks)
        .set({
          status: 'blocked',
          result: `Blocked: upstream dependenc${failedDeps.length > 1 ? 'ies' : 'y'} did not complete — ${reason}.`,
          updatedAt: new Date(),
        })
        .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'todo')))
        .returning({ id: agentTasks.id });
      unblocked += updated.length;
      continue;
    }

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
