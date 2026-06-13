// cron/tick.ts — runCronTick
// Orchestrates the cron phases in order:
//   1. resetOrphanedJobs    — fail jobs stuck in processing/awaiting_delegation
//   2. recoverPendingJobs   — re-execute pending jobs whose triggerWorker fetch
//                             silently failed (see findPendingJobsToRecover docs)
//   3. resetOrphanedTasks   — recover in_progress tasks with no job
//   4. unblockReadyTasks    — inject dep results for tasks whose deps are done
//   5. executeReadyTasks    — claim and run up to 5 ready tasks
//   6. runScheduleTick      — fire active agent_schedules whose next_run is due
//   7. deliverCompletedRoots — compile and deliver results for finished root jobs

import {
  resetOrphanedJobs,
  resetOrphanedTasks,
  findPendingJobsToRecover,
  failStalePendingJobs,
} from './reset-orphans.ts';
import { unblockReadyTasks } from './unblock-ready.ts';
import { executeReadyTasks } from './execute-ready.ts';
import { runScheduleTick } from './run-schedules.ts';
import { deliverCompletedRoots } from './deliver-results.ts';
import { runCuratorTick } from './run-curator.ts';
import { pruneOldJobs } from '@nodal-agents/db';
import { env } from '../env.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';

// ─── CronTickResult ───────────────────────────────────────────────────────────

export interface CronTickResult {
  orphanJobsReset: number;
  pendingRecovered: number;
  stalePendingFailed: number;
  orphansReset: number;
  tasksUnblocked: number;
  tasksExecuted: number;
  schedulesFired: number;
  rootsDelivered: number;
  curatorStaled: number;
  curatorArchived: number;
  curatorReactivated: number;
  curatorConsolidationDeferred: number;
  curatorConsolidationRan: number;
  retentionJobsDeleted: number;
  retentionToolCallsDeleted: number;
}

// ─── runCronTick ──────────────────────────────────────────────────────────────

/**
 * Run a single cron tick.
 * All phases are idempotent — two concurrent ticks produce the same outcome
 * as one tick (no double-execution, no double-delivery).
 *
 * Phases run sequentially so that:
 * - Phase 2 (recover) catches Telegram/dashboard/API jobs whose triggerWorker
 *   fetch failed (Windows port-clash zombie, transient network) BEFORE the
 *   orphan reset has a chance to flag them as failed
 * - Phase 4 (unblock) can benefit from Phase 1 (orphan reset) having freed tasks
 * - Phase 5 (execute) picks up tasks just unblocked by Phase 4
 * - Phase 7 (deliver) sees results from tasks completed by Phase 5
 *
 * @param deps  RunnerDeps (db + llmClient + registry)
 * @param maxTasksPerTick  Max tasks to execute in Phase 5 (default 5)
 */
export async function runCronTick(deps: RunnerDeps, maxTasksPerTick = 5): Promise<CronTickResult> {
  const orphanJobsReset = await resetOrphanedJobs(deps.db);

  // Recover stale pending jobs by driving them through executeJob in this
  // process. We deliberately call executeJob directly (no HTTP roundtrip
  // to /api/worker) so a zombie sibling holding the same port on Windows
  // can't intercept the trigger — same machine, same node process, no
  // possibility of the request landing in the wrong runner. Each call is
  // fire-and-forget so a long LLM loop doesn't block the rest of the
  // tick; executeJob has its own internal error handling that ensures
  // every path persists a final status (completed / failed / cancelled /
  // awaiting_*) before returning.
  //
  // The age window (30s — 5min) is narrow on purpose. Anything older
  // than 5min is handled by `failStalePendingJobs` right below: those
  // are abandoned tasks the user has moved on from, and silently
  // resurrecting a 4-day-old request would create surprise jobs the
  // user has no context for (caught live 2026-05-26, job 03cd4304).
  const pendingIds = await findPendingJobsToRecover(deps.db);
  for (const id of pendingIds) {
    void executeJob(id as JobId, deps).catch((err) => {
      console.warn('[cron] pending recovery failed for', id, err);
    });
  }
  const pendingRecovered = pendingIds.length;
  const stalePendingFailed = await failStalePendingJobs(deps.db);

  const orphansReset = await resetOrphanedTasks(deps.db);
  const tasksUnblocked = await unblockReadyTasks(deps.db);
  const tasksExecuted = await executeReadyTasks(deps.db, deps, maxTasksPerTick);
  const schedulesFired = await runScheduleTick(deps.db, deps, maxTasksPerTick);
  const rootsDelivered = await deliverCompletedRoots(deps.db);
  const curatorResult = await runCuratorTick(deps.db, deps);

  // ─── Retention phase (OFF by default, opt-in via RETENTION_DAYS > 0) ─────────
  // Prune terminal jobs older than RETENTION_DAYS days. Runs LAST so it never
  // interferes with in-flight jobs that completed earlier in this same tick.
  // Errors are caught and logged — a retention failure must never crash the tick.
  let retentionJobsDeleted = 0;
  let retentionToolCallsDeleted = 0;
  // Read RETENTION_DAYS defensively: the env proxy calls parseEnv(), which throws
  // when DATABASE_URL is absent (test envs that never set process.env). Mirror
  // resolveCuratorEnv's fallback — an unresolvable env means retention stays OFF.
  let retentionDays = 0;
  try {
    retentionDays = env.RETENTION_DAYS;
  } catch {
    retentionDays = 0;
  }
  if (retentionDays > 0) {
    try {
      const pruned = await pruneOldJobs(deps.db, retentionDays);
      retentionJobsDeleted = pruned.jobsDeleted;
      retentionToolCallsDeleted = pruned.toolCallsDeleted;
      if (pruned.jobsDeleted > 0) {
        console.log(
          `[retention] pruned ${pruned.jobsDeleted} jobs / ${pruned.toolCallsDeleted} tool_calls (older than ${retentionDays}d)`,
        );
      }
    } catch (err) {
      console.error('[retention] pruneOldJobs failed (tick continues):', err);
    }
  }

  return {
    orphanJobsReset,
    pendingRecovered,
    stalePendingFailed,
    orphansReset,
    tasksUnblocked,
    tasksExecuted,
    schedulesFired,
    rootsDelivered,
    curatorStaled: curatorResult.staled,
    curatorArchived: curatorResult.archived,
    curatorReactivated: curatorResult.reactivated,
    curatorConsolidationDeferred: curatorResult.consolidationDeferred,
    curatorConsolidationRan: curatorResult.consolidationRan,
    retentionJobsDeleted,
    retentionToolCallsDeleted,
  };
}
