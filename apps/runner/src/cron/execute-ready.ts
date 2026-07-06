// cron/execute-ready.ts — executeReadyTasks
// Claim up to `max` (default 5) ready tasks, create child jobs, and run them.
// Idempotency is enforced by a conditional UPDATE (status='todo') so two
// concurrent ticks can never claim the same task twice.

import { and, asc, desc, eq, inArray, notInArray, isNotNull } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { executeJob } from '../job/execute.ts';
import type { ExecuteJobResult } from '../job/execute.ts';
import type { RunnerDeps } from '../deps.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Priority ordering ────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// Root-job statuses that mean "don't spawn any more task-board children" — a
// cancelled/completed/failed root has no live work to fan out (B2 cancel-race).
const CANCELLED_OR_TERMINAL = new Set(['cancelled', 'completed', 'failed']);

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

    // Build task text, injecting the orchestration run's shared memory: the
    // results of all sibling tasks (same rootJobId) already done. This restores
    // — for the detached task-board model — what inline assign_ gave for free:
    // every sub-run sees what the others in this run have produced, not just its
    // explicit depends_on edges.
    const explicitDepIds = (task.dependsOn ?? []) as string[];
    const runMemory = task.rootJobId
      ? await loadRunMemory(db, task.rootJobId, task.id, explicitDepIds)
      : '';
    const taskText = buildTaskText(task, runMemory);

    // Invariant 8 (delegation depth): the create_task/task-board path must
    // feed the same guard as assign_*/inline delegation. task.rootJobId is the
    // CREATOR job's own id (create_task sets `rootJobId: ctx.jobId` — see
    // packages/orchestration/src/planner/task-tools.ts:116), and it's already
    // used below as this child's parentJobId. So the child's depth is the
    // creator's depth + 1 — the same recursion metric assign_* uses. Without
    // this, every task-board child defaulted to depth 0 forever, so a chain of
    // orchestrators using create_task instead of assign_* was never bounded by
    // the maxDelegationDepth guard in execute.ts.
    let childDepth = 0;
    if (task.rootJobId) {
      const [creatorRow] = await db
        .select({ delegationDepth: agentJobs.delegationDepth, status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, task.rootJobId))
        .limit(1);

      // Cancel-race guard (B2, audit followup): the candidate query filters
      // `todo`, and cancelJobAction now cascades `todo`→`cancelled` — but a task
      // this tick CLAIMED (`in_progress`) in the tiny window before the cancel
      // landed would still spawn a child here. If the root job is now terminal
      // (typically cancelled), don't spawn: mark the task cancelled and skip, so
      // "tick after cancel = 0 child spawned" holds even under that race.
      if (creatorRow && CANCELLED_OR_TERMINAL.has(creatorRow.status ?? '')) {
        await db
          .update(agentTasks)
          .set({ status: 'cancelled', result: 'root job cancelled', updatedAt: new Date() })
          .where(eq(agentTasks.id, task.id));
        continue;
      }

      childDepth = (creatorRow?.delegationDepth ?? 0) + 1;
    }

    // Create child job
    const jobRows = await db
      .insert(agentJobs)
      .values({
        entityId: task.entityId,
        agentId: task.assignedAgentId!,
        channel: 'task-board',
        task: taskText,
        parentJobId: task.rootJobId ?? undefined,
        delegationDepth: childDepth,
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

  // Run each task's job concurrently AND mark THAT task the moment ITS job
  // finishes — inside its own thunk, NOT after the whole batch. This is the
  // primary fix for the duplication bug: previously the task stayed
  // `in_progress` until the slowest sibling finished `Promise.allSettled`, and
  // the orphan reaper (resetOrphanedTasks Case B) re-ran any task whose job was
  // already terminal — re-executing completed work (live: Java posted to the
  // Cortex 3x because its task lingered in_progress ~12 min behind a slow
  // Sputnik). Marking per-job closes that window entirely.
  await Promise.allSettled(
    executions.map(async (exec) => {
      try {
        const result = await executeJob(exec.jobId as JobId, deps);
        await markTaskFromResult(db, exec.taskId, result);
      } catch {
        // executeJob threw — the job is already marked failed by its internal
        // handler. Mirror onto the task NOW so it never lingers in_progress.
        await db
          .update(agentTasks)
          .set({ status: 'blocked', result: 'job execution error', updatedAt: new Date() })
          .where(eq(agentTasks.id, exec.taskId));
      }
    }),
  );

  return executions.length;
}

// ─── markTaskFromResult ───────────────────────────────────────────────────────

/**
 * Mirror a finished job's outcome onto its task — promptly, the instant the job
 * returns. Terminal outcomes finalize the task (done / blocked); suspended
 * outcomes (approval / delegation / nested tasks) leave it `in_progress` because
 * a resume elsewhere will finish it.
 */
async function markTaskFromResult(
  db: AnyDrizzleDb,
  taskId: string,
  result: ExecuteJobResult,
): Promise<void> {
  if (result.status === 'completed') {
    await db
      .update(agentTasks)
      .set({ status: 'done', result: result.result, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  } else if (result.status === 'failed') {
    await db
      .update(agentTasks)
      .set({
        // Prefer the user-facing reason (e.g. a blocked agent's reason) over the
        // bare error code so the compiled task result explains WHY it stopped.
        status: 'blocked',
        result: result.result ?? result.error,
        updatedAt: new Date(),
      })
      .where(eq(agentTasks.id, taskId));
  } else if (result.status === 'cancelled') {
    await db
      .update(agentTasks)
      .set({ status: 'blocked', result: 'cancelled by user', updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }
  // awaiting_approval / awaiting_delegation / awaiting_tasks / already_handled:
  // leave the task in_progress — a resume path will finalize it later.
}

// ─── buildTaskText ────────────────────────────────────────────────────────────

/**
 * Build the task prompt text from title, description, and injected dep context.
 */
function buildTaskText(
  task: {
    title: string;
    description: string | null;
    context: unknown;
  },
  runMemory = '',
): string {
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

  // Orchestration run memory: results produced by sibling tasks of this same run.
  if (runMemory.trim()) {
    text += `\n\n## Shared memory from this run\nResults already produced by other agents working on this same request. Use them as context.\n\n${runMemory}`;
  }

  return text;
}

/** Max chars of run memory injected into a sub-task (keeps the prompt bounded). */
const RUN_MEMORY_BUDGET = 12_000;

/**
 * Load the orchestration run's shared memory for a starting sub-task: the
 * (title, result) of every sibling task in the same rootJobId that is already
 * `done` with a non-empty result, excluding the task itself. Oldest first,
 * truncated to a char budget. Empty string when there's nothing yet.
 */
async function loadRunMemory(
  db: AnyDrizzleDb,
  rootJobId: string,
  selfTaskId: string,
  excludeIds: string[] = [],
): Promise<string> {
  // Exclude the task itself AND its EXPLICIT deps (E2, audit followup): a
  // `done` dependency is already injected verbatim in `context.deps` /
  // "Data from previous steps", so also listing it here as shared-run memory
  // duplicates its (potentially large, unbounded) result in the same prompt.
  const excluded = [selfTaskId, ...excludeIds];
  const siblings = await db
    .select({ title: agentTasks.title, result: agentTasks.result, createdAt: agentTasks.createdAt })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.rootJobId, rootJobId),
        eq(agentTasks.status, 'done'),
        notInArray(agentTasks.id, excluded),
      ),
    )
    .orderBy(asc(agentTasks.createdAt));

  const sections: string[] = [];
  let used = 0;
  for (const s of siblings) {
    const body = (s.result ?? '').trim();
    if (!body) continue;
    const section = `### ${s.title}\n${body}`;
    if (used + section.length > RUN_MEMORY_BUDGET) {
      sections.push('### … (older results truncated)');
      break;
    }
    sections.push(section);
    used += section.length;
  }
  return sections.join('\n\n');
}
