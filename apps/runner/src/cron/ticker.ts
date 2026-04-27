// cron/ticker.ts — startCronTicker
// In-process setInterval that fires runCronTick every `intervalMs` (default 120s).
// Used by server.ts to run the cron loop without an external cron scheduler.
// Cloud deployments can disable this (CRON_TICKER_ENABLED=false) and use their
// own managed cron hitting POST /api/cron instead.

import { runCronTick } from './tick.ts';
import type { RunnerDeps } from '../deps.ts';

// ─── TickerHandle ─────────────────────────────────────────────────────────────

export interface TickerHandle {
  stop: () => void;
}

// ─── startCronTicker ──────────────────────────────────────────────────────────

/**
 * Start the in-process cron ticker.
 *
 * @param deps        RunnerDeps passed to each tick
 * @param opts.intervalMs  Tick interval in ms (default 120_000 = 2 min)
 * @param opts.onError     Called on tick error (default: console.warn + continue)
 * @returns           TickerHandle — call `.stop()` on shutdown
 */
export function startCronTicker(
  deps: RunnerDeps,
  opts: {
    intervalMs?: number;
    onError?: (e: unknown) => void;
  } = {},
): TickerHandle {
  const intervalMs = opts.intervalMs ?? 120_000;
  const onError =
    opts.onError ??
    ((e: unknown) => {
      console.warn('[cron] tick error (will retry next interval):', e);
    });

  const intervalId = setInterval(() => {
    // Fire and forget — errors are caught and logged, next tick will retry
    runCronTick(deps).catch(onError);
  }, intervalMs);

  return {
    stop() {
      clearInterval(intervalId);
    },
  };
}
