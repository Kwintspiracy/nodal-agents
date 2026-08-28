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
import { runSkillUpdateCheckTick, type SkillUpdateCheckTickEnv } from './run-skill-update-check.ts';
import { pruneJobMediaFiles } from './prune-media.ts';
import { pruneOldJobs } from '@nodal-agents/db';
import { workspacesRoot } from '../lib/workspaces-root.ts';
import { env } from '../env.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../deps.ts';
import {
  errorIdentity,
  renderError,
  logRepeatingFailure,
  reportRepeatingRecovery,
} from '../lib/repeat-log.ts';

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
  skillUpdatesChecked: number;
  skillUpdatesFound: number;
  retentionJobsDeleted: number;
  retentionToolCallsDeleted: number;
}

/**
 * Monotonic sequence for the fire-and-forget schedule phase.
 *
 * runScheduleTick is deliberately not awaited (a slow schedule must not stall
 * delivery or the curator — audit finding #20), so invocations from
 * overlapping ticks can settle OUT OF ORDER. An old, slow success landing
 * after a newer failure would clear that failure and announce a recovery that
 * never happened, and the next real failure would then read as a fresh
 * incident. Only the latest invocation may touch the repeating-failure state
 * (found by codex review, PR #42).
 */
let scheduleTickSeq = 0;

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
    const result = await fn();
    // A phase that was failing and now works says so once, with the count —
    // silent for a phase that was already healthy.
    reportRepeatingRecovery(
      `cron:${label}`,
      (failures) => `[cron] ${label} recovered after ${failures} failed tick(s)`,
    );
    return result;
  } catch (err) {
    // Eleven phases run behind this helper, every 30s. When the database goes
    // away they all fail at once, forever, and used to write eleven identical
    // lines per tick — 12% of a real runner.log, evicting via rotation the
    // earlier lines that explained the outage. The first failure of each phase
    // is still logged in full; the repeats are counted.
    logRepeatingFailure(
      `cron:${label}`,
      errorIdentity(err),
      () => `[cron] ${label} failed (tick continues): ${renderError(err)}`,
    );
    return fallback;
  }
}

/**
 * Resolve the skill-update-check env slice defensively, same pattern as
 * resolveCuratorEnv (run-curator.ts) and the RETENTION_DAYS read below: the
 * module-level `env` proxy throws on access when DATABASE_URL is absent
 * (some test environments never set process.env), and this phase must still
 * be safely callable (with sane defaults) in that case.
 */
function resolveSkillUpdateCheckEnv(): SkillUpdateCheckTickEnv {
  try {
    return {
      SKILL_UPDATE_CHECK_INTERVAL_HOURS: env.SKILL_UPDATE_CHECK_INTERVAL_HOURS,
      SKILL_UPDATE_CHECK_BATCH_SIZE: env.SKILL_UPDATE_CHECK_BATCH_SIZE,
    };
  } catch {
    return { SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24, SKILL_UPDATE_CHECK_BATCH_SIZE: 10 };
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
    // Mirrors guardPhase's recovery call. Without it the counter for this key
    // never resets, so a LATER outage would have its first 19 failures
    // suppressed with no recovery marker in between — the suppression would
    // outlive the incident it was created for. Found by codex review on PR #42.
    reportRepeatingRecovery(
      'cron:findPendingJobsToRecover',
      (failures) => `[cron] findPendingJobsToRecover recovered after ${failures} failed tick(s)`,
    );
  } catch (err) {
    logRepeatingFailure(
      'cron:findPendingJobsToRecover',
      errorIdentity(err),
      () => `[cron] findPendingJobsToRecover failed (tick continues): ${renderError(err)}`,
    );
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
  const scheduleSeq = ++scheduleTickSeq;
  void runScheduleTick(deps.db, deps, maxTasksPerTick)
    .then((count) => {
      schedulesFired = count;
      // Only the latest invocation may CLEAR the failure state (see the
      // catch below for why the failure path is deliberately not guarded).
      if (scheduleSeq !== scheduleTickSeq) return;
      reportRepeatingRecovery(
        'cron:runScheduleTick',
        (failures) => `[cron] runScheduleTick recovered after ${failures} failed tick(s)`,
      );
    })
    .catch((err) => {
      // NO sequence guard here, deliberately. A stale SUCCESS must not clear
      // newer failure state, but a stale FAILURE is still a real failure. A
      // single schedule can legitimately run for minutes against a 30s
      // interval, so invocations overlap continuously and every one of them is
      // already superseded by the time it rejects — guarding this path made
      // EVERY schedule failure silent (found by codex review, PR #42, as a P1
      // against the guard added one pass earlier).
      // Same collapsing as guardPhase — these three phases keep their own
      // try/catch for the reasons documented above, but a database outage
      // makes them fail every tick just the same. Missing them would leave
      // three lines per tick growing the log linearly, which is the very
      // thing this change exists to stop (found by codex review, PR #42).
      logRepeatingFailure(
        'cron:runScheduleTick',
        errorIdentity(err),
        () => `[cron] runScheduleTick failed (tick continues): ${renderError(err)}`,
      );
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
    reportRepeatingRecovery(
      'cron:deliverCompletedRoots',
      (failures) => `[cron] deliverCompletedRoots recovered after ${failures} failed tick(s)`,
    );
  } catch (err) {
    // Same collapsing as guardPhase — these three phases keep their own
    // try/catch for the reasons documented above, but a database outage
    // makes them fail every tick just the same. Missing them would leave
    // three lines per tick growing the log linearly, which is the very
    // thing this change exists to stop (found by codex review, PR #42).
    logRepeatingFailure(
      'cron:deliverCompletedRoots',
      errorIdentity(err),
      () => `[cron] deliverCompletedRoots failed (tick continues): ${renderError(err)}`,
    );
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
    reportRepeatingRecovery(
      'cron:runCuratorTick',
      (failures) => `[cron] runCuratorTick recovered after ${failures} failed tick(s)`,
    );
  } catch (err) {
    // Same collapsing as guardPhase — these three phases keep their own
    // try/catch for the reasons documented above, but a database outage
    // makes them fail every tick just the same. Missing them would leave
    // three lines per tick growing the log linearly, which is the very
    // thing this change exists to stop (found by codex review, PR #42).
    logRepeatingFailure(
      'cron:runCuratorTick',
      errorIdentity(err),
      () => `[cron] runCuratorTick failed (tick continues): ${renderError(err)}`,
    );
  }

  // Community skill update-check — throttled per-skill (last_update_check_at),
  // see run-skill-update-check.ts for the rate-limit/throttle rationale.
  // Guarded like every other phase: a failure here must never take down
  // retention (below) or anything already committed above.
  const skillUpdateResult = await guardPhase(
    'runSkillUpdateCheckTick',
    () => runSkillUpdateCheckTick(deps.db, resolveSkillUpdateCheckEnv()),
    { checked: 0, updatesFound: 0, notFound: 0, errored: 0, rateLimited: false },
  );

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
        console.warn(
          `[retention] pruned ${pruned.jobsDeleted} jobs / ${pruned.toolCallsDeleted} tool_calls (older than ${retentionDays}d)`,
        );

        // Sweep any inbound media (Telegram photos, Discord attachments) the
        // just-pruned jobs left behind under the shared workspace — pruneOldJobs
        // (packages/db) only deletes the DB row; it never touches the
        // filesystem (only the runner owns workspace paths). Left unswept,
        // disk usage grows unbounded even though retention is "on". Best-effort
        // per file (a locked file must not fail this phase) but loud —
        // failures are console.warn'd inside pruneJobMediaFiles.
        try {
          const media = await pruneJobMediaFiles(workspacesRoot(), pruned.deletedJobIds);
          if (media.filesDeleted > 0) {
            console.warn(
              `[retention] deleted ${media.filesDeleted} orphaned media file(s) for pruned jobs`,
            );
          }
        } catch (err) {
          console.error('[retention] pruneJobMediaFiles failed (tick continues):', err);
        }
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
    skillUpdatesChecked: skillUpdateResult.checked,
    skillUpdatesFound: skillUpdateResult.updatesFound,
    retentionJobsDeleted,
    retentionToolCallsDeleted,
  };
}
