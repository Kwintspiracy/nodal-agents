// reflection/throttle.ts — per-entity rolling-hour rate limit for the reflection
// pass.
//
// The reflection pass is fire-and-forget and costs an LLM call, so a burst of
// completed jobs for one entity must not trigger a burst of reflection calls.
// We cap it to N passes per entity per rolling hour.
//
// In-memory / process-local by design: reflection runs inside the runner
// process as a side-effect of job completion (it does NOT create its own job
// rows we could COUNT in the DB). A process-local sliding window of recent
// pass timestamps per entity is the minimal, dependency-free mechanism — the
// same "intra-run guard" shape the executor uses elsewhere. A runner restart
// resets the window, which is acceptable for a cost guard on an opt-in feature.

const WINDOW_MS = 60 * 60 * 1000; // one rolling hour

/** Per-entity ascending list of recent reflection-pass start timestamps (ms). */
const entityPassTimestamps = new Map<string, number[]>();

/** Drop timestamps older than the rolling window from an entity's list. */
function prune(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  // Timestamps are appended in time order, so find the first still-fresh index.
  let i = 0;
  while (i < timestamps.length && timestamps[i]! <= cutoff) i += 1;
  return i === 0 ? timestamps : timestamps.slice(i);
}

/**
 * Atomically check-and-reserve a reflection slot for an entity.
 *
 * Returns true and records the pass (consuming a slot) when the entity is under
 * `maxPerHour` in the trailing hour; returns false without recording when the
 * cap is already reached. Combining the check and the reservation in one call
 * makes the throttle safe against the rapid back-to-back completions that are
 * exactly what it exists to bound.
 *
 * `maxPerHour <= 0` disables reflection entirely (always false).
 */
export function tryReserveReflectionSlot(
  entityId: string,
  maxPerHour: number,
  now: number = Date.now(),
): boolean {
  if (maxPerHour <= 0) return false;
  const pruned = prune(entityPassTimestamps.get(entityId) ?? [], now);
  if (pruned.length >= maxPerHour) {
    // Persist the pruned list so the window stays bounded even when capped.
    entityPassTimestamps.set(entityId, pruned);
    return false;
  }
  pruned.push(now);
  entityPassTimestamps.set(entityId, pruned);
  return true;
}

/** Reset all throttle state — test-only. */
export function _resetReflectionThrottle(): void {
  entityPassTimestamps.clear();
}
