// cron/ticker.ts — startCronTicker
// In-process setInterval that fires runCronTick every `intervalMs` (default 120s).
// Used by server.ts to run the cron loop without an external cron scheduler.
// Cloud deployments can disable this (CRON_TICKER_ENABLED=false) and use their
// own managed cron hitting POST /api/cron instead.

import { runCronTickGuarded } from './guarded-tick.ts';
import { seedDefaultLlmKey } from '../bootstrap/seed-llm-key.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// ─── TickerHandle ─────────────────────────────────────────────────────────────

export interface TickerHandle {
  stop: () => void;
}

// ─── startCronTicker ──────────────────────────────────────────────────────────

/**
 * Start the in-process cron ticker.
 *
 * Re-entrancy + watchdog are NOT implemented here — they live in
 * `guarded-tick.ts`'s `runCronTickGuarded`, shared with the HTTP
 * `/api/cron` route (`routes/cron.ts`) so an in-process ticker and an
 * external managed cron can never race each other into overlapping ticks
 * either (finding R3, audit2 concurrency review).
 *
 * @param deps        RunnerDeps passed to each tick
 * @param opts.intervalMs  Tick interval in ms (default 120_000 = 2 min)
 * @param opts.onError     Called on tick error (default: console.warn + continue)
 * @param opts.maxTickMs   Hard ceiling on a single tick's runtime, ms
 *                          (default 15 min) — see guarded-tick.ts (finding R1)
 * @returns           TickerHandle — call `.stop()` on shutdown
 */
export function startCronTicker(
  deps: RunnerDeps,
  opts: {
    intervalMs?: number;
    onError?: (e: unknown) => void;
    /**
     * RunnerEnv lets the tick attempt a lazy `seedDefaultLlmKey` retry on
     * each interval. Needed in local-auth mode where the entity isn't
     * created until the first user signs up — which usually happens
     * AFTER the runner boots, so the boot-time seed call sees 0
     * entities and skips. The tick re-checks every interval and seeds
     * once the user appears. Idempotent: subsequent ticks return
     * immediately when the key is already in place.
     */
    runnerEnv?: RunnerEnv;
    maxTickMs?: number;
  } = {},
): TickerHandle {
  const intervalMs = opts.intervalMs ?? 120_000;
  const maxTickMs = opts.maxTickMs;
  const onError =
    opts.onError ??
    ((e: unknown) => {
      console.warn('[cron] tick error (will retry next interval):', e);
    });

  const intervalId = setInterval(() => {
    // Fire and forget — errors are caught and logged, next tick will retry.
    // runCronTickGuarded handles re-entrancy (M-7/R3) and the stuck-tick
    // watchdog (R1) internally, shared with the /api/cron route.
    runCronTickGuarded(deps, 5, maxTickMs)
      .then((result) => {
        if (result.skipped) {
          console.warn('[cron] tick skipped — previous tick still running (would have overlapped)');
        }
      })
      .catch(onError);

    if (opts.runnerEnv) {
      seedDefaultLlmKey(deps.db, opts.runnerEnv).catch((e) => {
        console.warn('[cron] lazy LLM seed retry failed (will retry next interval):', e);
      });
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(intervalId);
    },
  };
}
