// cron/tick.ts — runCronTick
// Orchestrates the cron phases in order:
//   1. resetOrphanedJobs    — fail jobs stuck in processing/awaiting_delegation
//   2. recoverPendingJobs   — re-execute pending jobs whose triggerWorker fetch
//                             silently failed (see findPendingJobsToRecover docs)
//   3. resetOrphanedTasks   — recover in_progress tasks with no job
//   4. unblockReadyTasks    — inject dep results for tasks whose deps are done
//   5. executeReadyTasks    — claim and run up to 5 ready tasks
//   6. runScheduleTick      — fire active agent_schedules whose next_run is due.
//                             Fire-and-forget from here (see note at the call
//                             site, audit finding #20): a schedule that kicks
//                             off a long-running orchestrator must not stall
//                             phases 7/8 for everyone else.
//   7. deliverCompletedRoots — compile and deliver results for finished root jobs

import {
  resetOrphanedJobs,
  resetOrphanedTasks,
  expireStaleApprovals,
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
  approvalsExpired: number;
  orphansReset: number;
  tasksUnblocked: number;
  tasksExecuted: number;
  /**
   * Best-effort. Schedule firing is decoupled from the rest of the tick (audit
   * finding #20, see runCronTick) so this only counts schedules whose
   * runScheduleTick call happened to resolve before the tick built this
   * result — a slow-firing schedule that's still running when the tick
   * returns is NOT counted here (it will still complete, just outside this
   * tick's accounting).
   */
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

// ─── guardPhase ───────────────────────────────────────────────────────────────

/**
 * Run one cron phase in isolation: a throw is caught, logged, and swallowed
 * so it can never take down the rest of the tick. Returns `fallback` when
 * `fn` throws.
 *
 * Audit finding H-2: a previous fix (commit 3cc2789) only guarded
 * deliverCompletedRoots and runCuratorTick, leaving phases 1/3/4/5 as bare
 * `await`s — a throw from ANY of those still propagated out of
 * runCronTick and skipped every phase after it (schedules, delivery,
 * curator, retention), silently, every 120s. This helper closes that gap
 * for every phase that fits its shape (see the pending-recovery loop below
 * for the one phase that doesn't and is guarded explicitly instead).
 */
async function guardPhase<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[cron] ${label} failed (tick continues):`, err);
    return fallback;
  }
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
 * Phase 6 (schedules) is the one exception: it is fire-and-forget, not
 * sequenced — a long-running schedule must not stall phase 7 or the curator
 * (audit finding #20). See the call site below for the full rationale.
 *
 * @param deps  RunnerDeps (db + llmClient + registry)
 * @param maxTasksPerTick  Max tasks to execute in Phase 5 (default 5)
 */
export async function runCronTick(deps: RunnerDeps, maxTasksPerTick = 5): Promise<CronTickResult> {
  const orphanJobsReset = await guardPhase(
    'resetOrphanedJobs',
    () => resetOrphanedJobs(deps.db),
    0,
  );

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
  //
  // Guarded explicitly (doesn't fit guardPhase's shape): the per-item
  // `void executeJob(...).catch()` fire-and-forget is already isolated
  // per job, but the `findPendingJobsToRecover` query itself can still
  // throw — if it does, `pendingRecovered` stays 0 and the tick continues.
  let pendingRecovered = 0;
  try {
    const pendingIds = await findPendingJobsToRecover(deps.db);
    for (const id of pendingIds) {
      void executeJob(id as JobId, deps).catch((err) => {
        console.warn('[cron] pending recovery failed for', id, err);
      });
    }
    pendingRecovered = pendingIds.length;
  } catch (err) {
    console.warn('[cron] findPendingJobsToRecover failed (tick continues):', err);
  }
  const stalePendingFailed = await guardPhase(
    'failStalePendingJobs',
    () => failStalePendingJobs(deps.db),
    0,
  );

  // Expire approvals whose TTL passed and finalize the jobs waiting on them
  // (D3) — otherwise an unanswered approval leaves its job in awaiting_approval
  // forever.
  const approvalsExpired = await guardPhase(
    'expireStaleApprovals',
    () => expireStaleApprovals(deps.db),
    0,
  );

  const orphansReset = await guardPhase('resetOrphanedTasks', () => resetOrphanedTasks(deps.db), 0);
  const tasksUnblocked = await guardPhase('unblockReadyTasks', () => unblockReadyTasks(deps.db), 0);
  // Phase 5 stays INDEPENDENT of Phase 4's success — do NOT gate it on
  // `tasksUnblocked` or skip it when unblockReadyTasks threw. Two reasons:
  // (1) executeReadyTasks re-checks dep readiness itself (execute-ready.ts:77,
  //     all deps 'done') AND injects each done sibling's result via loadRunMemory
  //     (execute-ready.ts:333, keyed on rootJobId), so a dependent task still
  //     sees its dependency outputs even if Phase 4 didn't populate context.deps
  //     this tick — the only loss is the "## Data from previous steps" framing,
  //     not the data (audit H-2 review, adversarial axe 2).
  // (2) Coupling Phase 5 to Phase 4 would reintroduce a stall: a permanent
  //     unblockReadyTasks failure would then also freeze no-dep task execution
  //     forever — strictly worse than the cosmetic framing degradation above.
  const tasksExecuted = await guardPhase(
    'executeReadyTasks',
    () => executeReadyTasks(deps.db, deps, maxTasksPerTick),
    0,
  );

  // Fire-and-forget, same shape as the pending-recovery phase above (line
  // ~87): a schedule whose fired job runs a long orchestrator (observed live:
  // an 8min planner fan-out) must not stall phase 7 (deliverCompletedRoots) or
  // the curator for the rest of THIS tick (audit finding #20). Before this fix
  // `await runScheduleTick(...)` sat directly in the blocking path, so every
  // other root job's delivery — and the curator's memory maintenance — waited
  // on that one slow schedule, and because ticker.ts's setInterval keeps
  // firing every 120s regardless, ticks piled up concurrently behind it.
  //
  // The atomic claim inside runScheduleTick (conditional UPDATE on
  // agent_schedules) is untouched and still the idempotency guard — an
  // overlapping call from the next tick still can't double-fire the same
  // schedule.
  //
  // schedulesFired below is therefore best-effort: it only reflects a count
  // if runScheduleTick happens to resolve before this function returns, and
  // stays 0 otherwise. That's honest (the tick genuinely doesn't know yet by
  // the time it hands its result back), not a fallback value pretending
  // certainty.
  let schedulesFired = 0;
  void runScheduleTick(deps.db, deps, maxTasksPerTick)
    .then((count) => {
      schedulesFired = count;
    })
    .catch((err) => {
      console.warn('[cron] runScheduleTick failed (tick continues):', err);
    });

  // deliverCompletedRoots already fail-isolates PER ROOT internally (a bad
  // synthesis/telegram-send/maybeResumeParent for one root is caught and
  // logged there, see deliver-results.ts), but a failure BEFORE that loop
  // (e.g. the initial findUndeliveredRootJobIds query) would still throw
  // uncaught and take down the rest of this tick — same class of bug as the
  // curator one below. Guarded the same way, same reasoning: delivery/
  // retention must never depend on each other's health.
  let rootsDelivered = 0;
  try {
    rootsDelivered = await deliverCompletedRoots(deps.db);
  } catch (err) {
    console.warn('[cron] deliverCompletedRoots failed (tick continues):', err);
  }

  // The curator (Phase 1 lifecycle SQL + Phase 2 LLM passes) must never be
  // able to crash the rest of the tick — retention (below) and every phase
  // ABOVE this line already ran and their effects are committed; only the
  // curator's own bookkeeping would be skipped for this tick. Caught the
  // live bug this guards against: a raw Date interpolated into a `sql`
  // fragment in transitionMemoryLifecycle (packages/memory/src/curator.ts)
  // threw ERR_INVALID_ARG_TYPE against real Postgres (pglite's tests never
  // caught it) and took the whole tick down every 120s.
  let curatorResult: Awaited<ReturnType<typeof runCuratorTick>> = {
    staled: 0,
    archived: 0,
    reactivated: 0,
    consolidationDeferred: 0,
    consolidationRan: 0,
    memoryArchived: 0,
    memoryCurationRan: 0,
  };
  try {
    curatorResult = await runCuratorTick(deps.db, deps);
  } catch (err) {
    console.warn('[cron] runCuratorTick failed (tick continues):', err);
  }

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
    approvalsExpired,
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
