// postgres-auth-failure.test.ts — a wrong password is not a slow start.
//
// Found in the review of PR #114 (2026-09-16). `startAndWaitUntilReady` polls
// `connect()` every 500ms until it succeeds, and its one escape hatch — the
// `resolvedItself` branch, "the package saw its ready line, so the cluster is
// up even if this probe is refused" — CANNOT FIRE any more: #111 turned
// `logging_collector` on, the collector owns the postmaster's stderr, and the
// package's promise never settles. A refusal that no amount of waiting can fix
// therefore looked exactly like a cluster still starting: retried for 180
// seconds, then reported as a readiness timeout, leaving a live postmaster
// nobody held a handle on.
//
// So the error is CLASSIFIED. SQLSTATE class 28 is
// `invalid_authorization_specification` — 28000, and 28P01 for a bad password.
// Those fail loudly and immediately, and the cluster is stopped on the way out
// (invariant #4: no silent smart fallback, and no orphan left behind).

import { describe, it, expect, vi } from 'vitest';
import { isPostgresAuthFailure, startAndWaitUntilReady } from '../lib/postgres.ts';

/** An error exactly as `pg` raises it: a message plus a SQLSTATE `code`. */
function pgError(code: string, message = 'refused'): Error {
  return Object.assign(new Error(message), { code });
}

describe('isPostgresAuthFailure @cap:installer-et-demarrer/moteur', () => {
  it('recognises the two SQLSTATE codes a wrong password produces', () => {
    expect(isPostgresAuthFailure(pgError('28P01', 'password authentication failed'))).toBe(true);
    expect(isPostgresAuthFailure(pgError('28000', 'no pg_hba.conf entry'))).toBe(true);
  });

  it('leaves everything a cluster still starting can throw as a RETRY', () => {
    // ECONNREFUSED is the ordinary shape of "not listening yet", and 57P03
    // (cannot_connect_now) is the postmaster saying so in SQL. Treating either
    // as fatal would turn a slow boot into a failed one.
    expect(isPostgresAuthFailure(pgError('ECONNREFUSED'))).toBe(false);
    expect(isPostgresAuthFailure(pgError('57P03'))).toBe(false);
    expect(isPostgresAuthFailure(new Error('socket hang up'))).toBe(false);
    expect(isPostgresAuthFailure(undefined)).toBe(false);
    expect(isPostgresAuthFailure(null)).toBe(false);
    // Not a class-28 code, merely a string that starts with one.
    expect(isPostgresAuthFailure(pgError('28'))).toBe(false);
  });
});

describe('startAndWaitUntilReady @cap:installer-et-demarrer/moteur', () => {
  it('fails at the FIRST refusal on a bad password, and stops the cluster', async () => {
    const stop = vi.fn(async () => {});
    const connect = vi.fn(async () => {
      throw pgError('28P01', 'password authentication failed for user "nodalai"');
    });
    const started = Date.now();

    await expect(
      startAndWaitUntilReady({
        // The package's promise never settles once the collector owns stderr —
        // reproduced here by a promise that never resolves, which is the whole
        // reason the old fallback is dead.
        start: () => new Promise<void>(() => {}),
        stop,
        getPgClient: () => ({ connect, end: async () => {} }),
      }),
    ).rejects.toThrow(/authentication failed \(SQLSTATE 28P01\)/);

    // ONE probe, not 360 of them: the poll interval is 500ms and the deadline
    // is 180s, so anything that retried would show here.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    // `pg.stop()` runs `pg_ctl stop -m fast`. Without it the postmaster this
    // call started outlives the CLI that started it.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a refusal that waiting CAN fix', async () => {
    const stop = vi.fn(async () => {});
    let attempts = 0;
    const connect = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw pgError('ECONNREFUSED', 'connect ECONNREFUSED');
    });

    await startAndWaitUntilReady({
      start: () => new Promise<void>(() => {}),
      stop,
      getPgClient: () => ({ connect, end: async () => {} }),
    });

    expect(attempts).toBe(3);
    expect(stop).not.toHaveBeenCalled();
  });
});
