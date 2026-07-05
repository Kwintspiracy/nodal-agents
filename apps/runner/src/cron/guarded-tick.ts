// cron/guarded-tick.ts — runCronTickGuarded
//
// Shared re-entrancy guard + watchdog around runCronTick, used by BOTH the
// in-process ticker (ticker.ts) and the external-scheduler HTTP route
// (routes/cron.ts, used by Vercel cron / Fly scheduled tasks / any managed
// cron hitting POST /api/cron with CRON_TICKER_ENABLED=false).
//
// Finding R3 (audit2 concurrency review): before this, only the ticker had
// the M-7 re-entrancy guard — an external managed cron that fires faster
// than a slow tick completes was still exposed to the exact concurrent
// pile-up class of bug M-7 fixed for the in-process path. A SINGLE
// module-level `running` flag (shared by every caller, not one per entry
// point) closes that gap and also means the ticker and the route can never
// race each other into running two ticks at once in the (unusual but
// possible) deployment where both happen to be enabled.
//
// Finding R1 (audit2 concurrency review): M-7's guard + F-8's tool-call
// heartbeat together removed BOTH safety nets that used to catch a hung
// tick — before, an overlapping tick still ran (pile-up, but the loop wasn't
// dead) and the orphan reaper eventually failed a stuck job at 5min. Now
// `running=true` blocks every future call forever, and the heartbeat disarms
// the reaper — a `runCronTick` that never settles (e.g. a query stuck on a
// row lock; see packages/db/src/client.ts's `lock_timeout` /
// `idle_in_transaction_session_timeout` for the DB-level fix to the vector
// actually identified, finding R2) would permanently wedge every caller of
// this function until restart. `Promise.race` against `maxTickMs` forces
// `running` back to false even when the tick itself never resolves. The
// stuck tick's promise is deliberately LEFT to run/reject on its own time —
// every phase inside runCronTick is idempotent (see tick.ts's own docs), so
// an eventual late completion is harmless; abandoning it is strictly better
// than a cron that never runs again. A `.catch` is attached directly to the
// underlying promise (independent of the race) so a late rejection never
// surfaces as an unhandled rejection.

import { runCronTick } from './tick.ts';
import type { CronTickResult } from './tick.ts';
import type { RunnerDeps } from '../deps.ts';

// ─── GuardedTickResult ──────────────────────────────────────────────────────────

export interface GuardedTickResult extends CronTickResult {
  /**
   * True when this call did NOT run a tick because one was already in
   * flight (from either the ticker or the route) — every count is 0.
   */
  skipped: boolean;
}

const ZERO_RESULT: CronTickResult = {
  orphanJobsReset: 0,
  pendingRecovered: 0,
  stalePendingFailed: 0,
  orphansReset: 0,
  tasksUnblocked: 0,
  tasksExecuted: 0,
  schedulesFired: 0,
  rootsDelivered: 0,
  curatorStaled: 0,
  curatorArchived: 0,
  curatorReactivated: 0,
  curatorConsolidationDeferred: 0,
  curatorConsolidationRan: 0,
  retentionJobsDeleted: 0,
  retentionToolCallsDeleted: 0,
};

// Module-level — deliberately shared by every caller (ticker + HTTP route).
let running = false;

// ─── runCronTickGuarded ───────────────────────────────────────────────────────

/**
 * Run one cron tick, guarded against overlapping with another in-flight tick
 * (from any caller) and bounded by a watchdog so a hung tick can never wedge
 * every future call forever.
 *
 * @param deps           RunnerDeps (db + llmClient + registry)
 * @param maxTasksPerTick  Max tasks to execute in Phase 5 (default 5)
 * @param maxTickMs      Hard ceiling on a single tick's runtime, ms. Default
 *                        15 minutes.
 */
export async function runCronTickGuarded(
  deps: RunnerDeps,
  maxTasksPerTick = 5,
  maxTickMs = 15 * 60_000,
): Promise<GuardedTickResult> {
  if (running) {
    return { ...ZERO_RESULT, skipped: true };
  }

  running = true;
  let watchdogFired = false;

  const tickPromise = runCronTick(deps, maxTasksPerTick);
  // Independent of the race below — guarantees this promise is never left
  // unhandled, even if it settles long after the watchdog already reset
  // `running` (finding R1).
  tickPromise.catch((err) => {
    if (watchdogFired) {
      console.error('[cron] previously-stuck tick finally settled (after watchdog reset):', err);
    }
  });

  const watchdog = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      watchdogFired = true;
      resolve('timeout');
    }, maxTickMs);
    // Defensive — never let this internal timer be the reason the process
    // can't exit if everything else has already shut down.
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    const outcome = await Promise.race([tickPromise, watchdog]);
    if (outcome === 'timeout') {
      console.error(
        `[cron] tick exceeded ${maxTickMs}ms — a tick is stuck, forcing reset so callers keep working. ` +
          'The stuck call is abandoned (not joined) and left to settle on its own; every cron phase is idempotent.',
      );
      return { ...ZERO_RESULT, skipped: false };
    }
    return { ...outcome, skipped: false };
  } finally {
    running = false;
  }
}

/** Test-only: force the shared `running` flag back to a known state. */
export function _resetGuardedTickForTests(): void {
  running = false;
}
