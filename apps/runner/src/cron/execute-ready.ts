// cron/execute-ready.ts — executeReadyTasks
// Claim up to `max` (default 5) ready tasks, create child jobs, and run them.
// Idempotency is enforced by a conditional UPDATE (status='todo') so two
// concurrent ticks can never claim the same task twice.

import { and, asc, desc, eq, inArray, isNotNull } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { executeJob } from '../job/execute.ts';
import type { RunnerDeps } from '../deps.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Priority ordering ────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ─── executeReadyTasks ────────────────────────────────────────────────────────

/**
 * Find and execute up to `max` `todo` tasks whose dependencies are resolved.
 *
 * Per-task flow:
 * 1. Atomic claim: `UPDATE ... SET status='in_progress' WHERE status='todo'`
 *    Only the winner proceeds; concurrent tick loses and skips.
 * 2. Build task text from title + description + context.deps
 * 3. Insert a new `agent_jobs` row (channel='task-board', parentJobId=rootJobId)
 * 4. Link task.job_id → new job
 * 5. `await executeJob(jobId, deps)` — run the LLM loop inline
 * 6. After all Promise.allSettled: mark task done/failed to match job outcome
 *
 * @returns count of tasks that were claimed and executed
 */
export async function executeReadyTasks(
  db: AnyDrizzleDb,
  deps: RunnerDeps,
  max = 5,
): Promise<number> {
  // Find candidate tasks: todo + no unresolved deps
  // "no unresolved deps" means: depends_on is empty OR all deps are done
  // We query all `todo` tasks that have an assigned_agent_id, then claim atomically.
  // NOTE: pglite doesn't support FOR UPDATE SKIP LOCKED, so we use conditional UPDATE
  // as the idempotency mechanism (status check in WHERE clause).

  const candidates = await db
    .select({
      id: agentTasks.id,
      title: agentTasks.title,
      description: agentTasks.description,
      context: agentTasks.context,
      assignedAgentId: agentTasks.assignedAgentId,
      orchestratorId: agentTasks.orchestratorId,
      entityId: agentTasks.entityId,
      rootJobId: agentTasks.rootJobId,
      dependsOn: agentTasks.dependsOn,
      priority: agentTasks.priority,
      createdAt: agentTasks.createdAt,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.status, 'todo'), isNotNull(agentTasks.assignedAgentId)))
    .orderBy(desc(agentTasks.priority), asc(agentTasks.createdAt))
    .limit(max * 3); // Fetch more than needed since some may have unresolved deps

  // Filter to only those with all deps resolved (or no deps)
  const readyCandidates: typeof candidates = [];
  for (const task of candidates) {
    const deps_ = (task.dependsOn ?? []) as string[];
    if (deps_.length === 0) {
      readyCandidates.push(task);
    } else {
      // Check if all deps are done
      const depRows = await db
        .select({ id: agentTasks.id, status: agentTasks.status })
        .from(agentTasks)
        .where(inArray(agentTasks.id, deps_));

      if (depRows.length === deps_.length && depRows.every((d) => d.status === 'done')) {
        readyCandidates.push(task);
      }
    }
    if (readyCandidates.length >= max) break;
  }

  if (readyCandidates.length === 0) return 0;

  // Sort by priority desc, then created_at asc (stable within same priority)
  readyCandidates.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? 'medium'] ?? 1;
    const pb = PRIORITY_ORDER[b.priority ?? 'medium'] ?? 1;
    if (pa !== pb) return pa - pb; // lower number = higher priority
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });

  const toExecute = readyCandidates.slice(0, max);
  const workerId = Math.random().toString(36).slice(2, 10);

  // Claim atomically and create jobs
  type TaskExecution = {
    taskId: string;
    jobId: string;
    assignedAgentId: string;
    entityId: string;
    rootJobId: string | null;
  };

  const executions: TaskExecution[] = [];

  for (const task of toExecute) {
    // Atomic claim: only succeeds if task is still 'todo'
    const claimed = await db
      .update(agentTasks)
      .set({
        status: 'in_progress',
        lockedBy: workerId,
        lockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'todo')))
      .returning({ id: agentTasks.id });

    if (claimed.length === 0) {
      // Another concurrent tick already claimed this task — skip
      continue;
    }

    // Build task text
    const taskText = buildTaskText(task);

    // Create child job
    const jobRows = await db
      .insert(agentJobs)
      .values({
        entityId: task.entityId,
        agentId: task.assignedAgentId!,
        channel: 'task-board',
        task: taskText,
        parentJobId: task.rootJobId ?? undefined,
        status: 'pending',
        messages: [{ role: 'user', content: taskText }],
      })
      .returning({ id: agentJobs.id });

    const job = jobRows[0];
    if (!job) {
      // Job creation failed — reset task to todo
      await db
        .update(agentTasks)
        .set({ status: 'todo', lockedBy: null, lockedAt: null, updatedAt: new Date() })
        .where(eq(agentTasks.id, task.id));
      continue;
    }

    // Link task → job
    await db
      .update(agentTasks)
      .set({ jobId: job.id, updatedAt: new Date() })
      .where(eq(agentTasks.id, task.id));

    executions.push({
      taskId: task.id,
      jobId: job.id,
      assignedAgentId: task.assignedAgentId!,
      entityId: task.entityId,
      rootJobId: task.rootJobId ?? null,
    });
  }

  if (executions.length === 0) return 0;

  // Execute all jobs concurrently
  const results = await Promise.allSettled(
    executions.map(async (exec) => {
      const result = await executeJob(exec.jobId as JobId, deps);
      return { exec, result };
    }),
  );

  // Update task status based on job outcome
  for (const settled of results) {
    if (settled.status === 'rejected') {
      // executeJob itself threw — the job is already marked failed by the internal
      // error handler. The task will be reset by the next orphan-reset tick.
      continue;
    }

    const { exec, result } = settled.value;

    if (result.status === 'completed') {
      await db
        .update(agentTasks)
        .set({
          status: 'done',
          result: result.result,
          updatedAt: new Date(),
        })
        .where(eq(agentTasks.id, exec.taskId));
    } else if (result.status === 'failed') {
      await db
        .update(agentTasks)
        .set({
          status: 'blocked', // blocked = needs attention, can be retried
          // Prefer the user-facing reason (e.g. agent_blocked) over the bare
          // error code so the compiled task result explains WHY it stopped.
          result: result.result ?? result.error,
          updatedAt: new Date(),
        })
        .where(eq(agentTasks.id, exec.taskId));
    } else if (result.status === 'awaiting_approval') {
      // Leave in_progress — the approve endpoint will complete it
    } else if (result.status === 'awaiting_delegation') {
      // Leave in_progress — the delegation resume will complete it
    } else if (result.status === 'cancelled') {
      // User cancelled the job mid-flight via the dashboard. Mirror that on
      // the parent task so it doesn't sit forever as `in_progress`.
      await db
        .update(agentTasks)
        .set({
          status: 'blocked',
          result: 'cancelled by user',
          updatedAt: new Date(),
        })
        .where(eq(agentTasks.id, exec.taskId));
    }
    // 'already_handled' — status already correct, no-op
  }

  return executions.length;
}

// ─── buildTaskText ────────────────────────────────────────────────────────────

/**
 * Build the task prompt text from title, description, and injected dep context.
 */
function buildTaskText(task: {
  title: string;
  description: string | null;
  context: unknown;
}): string {
  let text = task.title;

  if (task.description) {
    text += `\n\n${task.description}`;
  }

  const ctx = task.context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    const ctxObj = ctx as Record<string, unknown>;

    // Dep results injected by unblockReadyTasks
    const deps = ctxObj['deps'];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      const depEntries = Object.entries(deps as Record<string, string>);
      if (depEntries.length > 0) {
        const depSections = depEntries
          .map(([depId, result]) => `## Dep ${depId}\n${result}`)
          .join('\n\n');
        text += `\n\n## Data from previous steps\n${depSections}`;
      }
    }

    // Legacy from_dependencies format (ported from Python cron)
    const fromDeps = ctxObj['from_dependencies'];
    if (typeof fromDeps === 'string' && fromDeps.trim()) {
      text += `\n\n## Data from previous steps\n${fromDeps}`;
    }

    // Additional context fields
    const remaining = Object.entries(ctxObj).filter(
      ([k]) => k !== 'deps' && k !== 'from_dependencies',
    );
    if (remaining.length > 0) {
      text += `\n\n## Context\n${JSON.stringify(Object.fromEntries(remaining), null, 2)}`;
    }
  } else if (typeof ctx === 'string' && ctx.trim()) {
    text += `\n\n## Context\n${ctx}`;
  }

  return text;
}
