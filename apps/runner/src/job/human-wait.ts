// job/human-wait.ts — the time a run spends waiting for a PERSON, in process.
//
// A job's worked time (`total_duration_ms`, the one `max_run_hours` bounds)
// excludes its suspensions: a suspended job is not running. Some waits on a
// person happen without suspending: the approval grace window (Lot A1) and an
// MCP server's question during a call (0145). Measured here, they are taken
// out of the worked time the same way (Codex review pass 4 of #660): a person
// thinking for ten minutes must not stop a run that was nearly done.
//
// Overlapping waits (several questions at once) count once: the clock adds up
// the time during which at least one wait was open.

export interface HumanWaitClock {
  /** Run `wait`, counting its duration as time spent waiting for a person. */
  during<T>(wait: () => Promise<T>): Promise<T>;
  /** Time spent waiting so far, a wait still open included. */
  ms(): number;
}

export function createHumanWaitClock(now: () => number = Date.now): HumanWaitClock {
  let total = 0;
  let open = 0;
  let since = 0;
  return {
    async during<T>(wait: () => Promise<T>): Promise<T> {
      if (open === 0) since = now();
      open += 1;
      try {
        return await wait();
      } finally {
        open -= 1;
        if (open === 0) total += now() - since;
      }
    },
    ms(): number {
      return total + (open > 0 ? now() - since : 0);
    },
  };
}
