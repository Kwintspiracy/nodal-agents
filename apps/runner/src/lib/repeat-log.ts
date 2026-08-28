// lib/repeat-log.ts — collapse a repeating failure into one line plus a count.
//
// Why this exists, measured on a real install: when Postgres goes away, every
// 30s tick logs the SAME failure from 17 independent places — five channel
// managers ("DB scan failed"), eleven cron phases ("… failed (tick
// continues)"), and the health probe ("DB ping failed"). One runner.log came
// out at 7 412 such lines out of 61 359 (12%), running right up to the last
// line.
//
// The damage is not disk, it is DIAGNOSIS. Log rotation caps each service at
// 20 MB, so a long outage evicts the earlier lines — the ones that said WHY
// the database went away — and leaves only the consequence repeated thousands
// of times. The log that would have explained the incident is destroyed by the
// incident's own noise.
//
// Contract: the FIRST occurrence is always logged in full, so nothing is ever
// silently swallowed (invariant #4 — fail loud). Repeats are counted and
// re-surfaced every REPEAT_EVERY occurrences with the running total. Recovery
// is logged too: a caller that reports success after failures gets one line
// naming how many there were, which is what turns "it is broken" into "it was
// broken for 43 ticks and came back".

/** Log the 1st failure, then one line per this many repeats. At a 30s tick, 20 ≈ every 10 minutes. */
const REPEAT_EVERY = 20;

/**
 * Cap on distinct keys tracked at once. Keys are code-site labels, not user
 * data, so the real cardinality is a few dozen; the bound (oldest-inserted
 * evicted first, same discipline as the webhook rate limiter) only exists so a
 * caller that ever builds a key from something unbounded cannot leak.
 */
const MAX_KEYS = 200;

interface FailureState {
  count: number;
  /**
   * What is failing, not just where. Suppression keyed on the site alone hid a
   * CHANGED error behind an old one: "connection refused" becoming "password
   * authentication failed" stayed invisible until the next 20th occurrence and
   * was then mislabelled as the same repeated failure — hiding, for ~10
   * minutes at a 30s cadence, exactly the line a reader needs. Found by codex
   * review on PR #42.
   */
  identity: string;
}

const failureCounts = new Map<string, FailureState>();

function evictOldestIfOverCapacity(): void {
  let excess = failureCounts.size - MAX_KEYS;
  const it = failureCounts.keys();
  while (excess > 0) {
    const oldest = it.next();
    if (oldest.done) break;
    failureCounts.delete(oldest.value);
    excess--;
  }
}

/**
 * Report a failure for `key`, logging only when it is worth a line.
 *
 * @param key      Stable identifier for the failing SITE (e.g. 'slack-manager:db-scan').
 * @param identity WHAT is failing — typically the error message. Cheap to
 *                 compute (it is evaluated on every call, unlike `render`).
 *                 When it changes, the new failure is logged immediately
 *                 instead of waiting for the next repeat threshold.
 * @param render  Builds the message. Only called when the line will actually
 *                be logged, so an expensive render costs nothing while
 *                suppressed. Receives the running failure count.
 * @param level   'warn' (default) or 'error'.
 */
export function logRepeatingFailure(
  key: string,
  identity: string,
  render: (count: number) => string,
  level: 'warn' | 'error' = 'warn',
): void {
  const previous = failureCounts.get(key);
  // A different reason is a NEW failure, not a repeat of the old one: log it at
  // once and restart the count, so its own repeats still collapse.
  const changed = previous !== undefined && previous.identity !== identity;
  const count = previous && !changed ? previous.count + 1 : 1;
  failureCounts.set(key, { count, identity });
  evictOldestIfOverCapacity();

  const shouldLog = count === 1 || count % REPEAT_EVERY === 0;
  if (!shouldLog) return;

  const message =
    count === 1
      ? render(count)
      : `${render(count)} [same failure repeated ${REPEAT_EVERY}× — ${count} in total; ` +
        'further repeats are suppressed until it changes or recovers]';

  if (level === 'error') console.error(message);
  else console.warn(message);
}

/**
 * Report that `key` is working again. Logs a recovery line ONLY if failures
 * had actually been recorded, so a healthy site that calls this on every tick
 * stays silent.
 */
export function reportRepeatingRecovery(key: string, render: (failures: number) => string): void {
  const state = failureCounts.get(key);
  if (!state) return;
  failureCounts.delete(key);
  console.warn(render(state.count));
}

/** Test-only: clear all tracked state between cases. */
export function _resetRepeatLogForTests(): void {
  failureCounts.clear();
}

/** Test-only: how many failures are currently recorded for a key. */
export function _repeatFailureCountForTests(key: string): number {
  return failureCounts.get(key)?.count ?? 0;
}
