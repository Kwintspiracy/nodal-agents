// planner/dependencies.ts — dependency validation for task board tasks
// Validates that depends_on references exist and contain no cycles.

import { eq, inArray } from '@nodalai/db';
import { agentTasks } from '@nodalai/db';
import { OrchestrationError } from '../errors.js';
import type { TaskId, AnyDrizzleDb } from '../types.js';

// ─── validateDependencies ─────────────────────────────────────────────────────

/**
 * Validate that all dependency task IDs in `taskIds` exist in the DB,
 * and that they form no cycles (direct or transitive).
 *
 * Throws OrchestrationError with code:
 *   - 'missing_dependency' if any referenced task ID does not exist
 *   - 'cycle_detected'     if adding these dependencies would create a cycle
 *
 * @param newTaskId   The ID of the task being created (not yet in DB)
 * @param dependsOn   The depends_on array from the create_task input
 * @param db          Drizzle DB handle
 */
export async function validateDependencies(
  newTaskId: TaskId,
  dependsOn: TaskId[],
  db: AnyDrizzleDb,
): Promise<void> {
  if (dependsOn.length === 0) return;

  // 1. Check all referenced IDs exist
  const foundRows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(inArray(agentTasks.id, dependsOn as string[]));

  const foundIds = new Set(foundRows.map((r: { id: string }) => r.id));
  const missing = dependsOn.filter((id) => !foundIds.has(id as string));

  if (missing.length > 0) {
    throw new OrchestrationError(
      'missing_dependency',
      `Task ${newTaskId} depends on non-existent tasks: ${missing.join(', ')}`,
    );
  }

  // 2. Cycle detection via DFS
  // Build adjacency map for existing tasks in this set + their deps
  const allIds = [...dependsOn];
  const taskRows = await db
    .select({ id: agentTasks.id, dependsOn: agentTasks.dependsOn })
    .from(agentTasks)
    .where(inArray(agentTasks.id, allIds as string[]));

  // adjacency: taskId → [deps...]
  const graph = new Map<string, string[]>();

  // Add the new task's edges (newTaskId → dependsOn)
  graph.set(newTaskId as string, dependsOn as string[]);

  // Add existing tasks' edges
  for (const row of taskRows as Array<{ id: string; dependsOn: string[] | null }>) {
    graph.set(row.id, (row.dependsOn ?? []) as string[]);
  }

  // DFS cycle detection: detect if newTaskId is reachable from any of its deps
  // (which would mean: dep → ... → newTaskId → dep = cycle)
  const hasCycle = detectCycle(graph);
  if (hasCycle) {
    throw new OrchestrationError(
      'cycle_detected',
      `Task ${newTaskId} creates a dependency cycle with: ${dependsOn.join(', ')}`,
    );
  }
}

// ─── detectCycle ──────────────────────────────────────────────────────────────

/**
 * DFS-based cycle detection on the dependency graph.
 * Returns true if any cycle is found.
 */
function detectCycle(graph: Map<string, string[]>): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true; // back edge = cycle
    if (visited.has(nodeId)) return false; // already processed, no cycle from here

    visited.add(nodeId);
    inStack.add(nodeId);

    const deps = graph.get(nodeId) ?? [];
    for (const dep of deps) {
      if (dfs(dep)) return true;
    }

    inStack.delete(nodeId);
    return false;
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      if (dfs(nodeId)) return true;
    }
  }

  return false;
}

// ─── checkAllDepsResolved ─────────────────────────────────────────────────────

/**
 * Check whether all dependencies for a given task are in 'done' status.
 * Used by the cron tick to unblock tasks whose deps have all completed.
 *
 * @param taskId  Task to check
 * @param db      Drizzle DB handle
 * @returns       true if all deps are done (or task has no deps)
 */
export async function checkAllDepsResolved(taskId: TaskId, db: AnyDrizzleDb): Promise<boolean> {
  const taskRows = await db
    .select({ dependsOn: agentTasks.dependsOn })
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId as string))
    .limit(1);

  const task = (taskRows as Array<{ dependsOn: string[] | null }>)[0];
  if (!task) return false;

  const deps = (task.dependsOn ?? []) as string[];
  if (deps.length === 0) return true;

  const depRows = await db
    .select({ id: agentTasks.id, status: agentTasks.status })
    .from(agentTasks)
    .where(inArray(agentTasks.id, deps));

  return (depRows as Array<{ id: string; status: string }>).every((d) => d.status === 'done');
}
