// cron/tick.ts — runCronTick
// Orchestrates the cron phases in order:
//   1. resetOrphanedJobs    — fail jobs stuck in processing/awaiting_delegation
//   2. resetOrphanedTasks   — recover in_progress tasks with no job
//   3. unblockReadyTasks    — inject dep results for tasks whose deps are done
//   4. executeReadyTasks    — claim and run up to 5 ready tasks
//   5. deliverCompletedRoots — compile and deliver results for finished root jobs

import { resetOrphanedJobs, resetOrphanedTasks } from './reset-orphans.ts';
import { unblockReadyTasks } from './unblock-ready.ts';
import { executeReadyTasks } from './execute-ready.ts';
import { deliverCompletedRoots } from './deliver-results.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// ─── CronTickResult ───────────────────────────────────────────────────────────

export interface CronTickResult {
  orphanJobsReset: number;
  orphansReset: number;
  tasksUnblocked: number;
  tasksExecuted: number;
  rootsDelivered: number;
}

// ─── runCronTick ──────────────────────────────────────────────────────────────

/**
 * Run a single cron tick.
 * All phases are idempotent — two concurrent ticks produce the same outcome
 * as one tick (no double-execution, no double-delivery).
 *
 * Phases run sequentially so that:
 * - Phase 2 (unblock) can benefit from Phase 1 (orphan reset) having freed tasks
 * - Phase 3 (execute) picks up tasks just unblocked by Phase 2
 * - Phase 4 (deliver) sees results from tasks completed by Phase 3
 *
 * @param deps  RunnerDeps (db + llmClient + registry)
 * @param maxTasksPerTick  Max tasks to execute in Phase 3 (default 5)
 */
export async function runCronTick(
  deps: RunnerDeps,
  maxTasksPerTick = 5,
  env?: Pick<RunnerEnv, 'TELEGRAM_BOT_TOKEN'>,
): Promise<CronTickResult> {
  const orphanJobsReset = await resetOrphanedJobs(deps.db);
  const orphansReset = await resetOrphanedTasks(deps.db);
  const tasksUnblocked = await unblockReadyTasks(deps.db);
  const tasksExecuted = await executeReadyTasks(deps.db, deps, maxTasksPerTick);
  const rootsDelivered = await deliverCompletedRoots(deps.db, env);

  return { orphanJobsReset, orphansReset, tasksUnblocked, tasksExecuted, rootsDelivered };
}
