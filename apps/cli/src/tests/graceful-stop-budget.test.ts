// graceful-stop-budget.test.ts — `down` stops waiting, it does not wait forever.
//
// Measured on GitHub's Linux runner, 2026-09-16, twice: after a backend was
// killed from outside, `pg_ctl stop -m fast` did not return within 60 seconds
// while the postmaster worked through the crash recovery that kill provoked.
// The test suite showed it first (`Hook timed out in 120000ms`), but the
// product has the same shape: `down` awaited `pg.stop()` with no deadline at
// all, so the same cluster state would leave a user's terminal sitting there
// with no output and no way to know what it was waiting for.
//
// What is bounded is the WAIT, never the stop: `pg_ctl` is a process and it
// keeps going either way. Past the budget `down` says so and falls through to
// the re-probe it already had — the part that decides what to claim, and that
// already has the right words for a Postgres still up, force-kill command
// included, printed only for a pid it confirmed.

import { describe, it, expect, vi } from 'vitest';
import { stopWithinBudget } from '../commands/down.ts';

describe('stopWithinBudget @cap:installer-et-demarrer/moteur', () => {
  it('gives up on a stop that never returns, instead of hanging', async () => {
    // The 2026-09-16 cluster: recovering, and not answering pg_ctl.
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const began = Date.now();

    await expect(stopWithinBudget({ stop }, 150)).resolves.toBe(false);

    expect(Date.now() - began).toBeLessThan(5_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('reports a stop that returned inside the budget', async () => {
    await expect(stopWithinBudget({ stop: async () => {} }, 5_000)).resolves.toBe(true);
  });

  it('counts a stop that THREW as an answer, not as a timeout', async () => {
    // `pg_ctl` refusing is a real answer and the caller's re-probe knows what
    // to do with it. Reporting it as "did not finish in time" would send the
    // reader looking for a slow shutdown that never happened.
    const stop = async (): Promise<void> => {
      throw new Error('pg_ctl: could not send stop signal');
    };
    await expect(stopWithinBudget({ stop }, 5_000)).resolves.toBe(true);
  });
});
