// postmaster-pid.test.ts — regression for the orphan-Postgres DETECTION fix.
//
// `up` used to look for orphans by LISTENING PORT only. The orphan that
// actually hurts holds no port: a postmaster that died during startup, or is
// stuck mid-shutdown, has no socket left while its Win32 shared-memory section
// — keyed to the DATA DIR, not the port — is still attached. A port scan
// reports every port free, `up` sails past its pre-flight, and Postgres then
// dies on the opaque FATAL "pre-existing shared memory block is still in use"
// (live machine, 2026-08-20; a reboot did not clear it).
//
// These tests pin the data-dir probe that closes that blind spot, against real
// files and real PIDs — no mocks: the whole point is that the probe reads what
// Postgres actually writes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPostmasterPid,
  readPostmasterClaim,
  livePostmasterPid,
  resolvePgCtl,
  stopOrphanPostgres,
  processStartedAtMs,
  postgresProcessesForDataDir,
  unconfirmedReading,
} from '../lib/postgres.ts';

// PIDs this high aren't allocated on Windows or Linux in practice, so
// kill(pid, 0) throws ESRCH.
const DEAD_PID = 2_147_483_646;

let dataDir: string;

/**
 * Write a lockfile in the real shape Postgres uses: the PID on the first line,
 * then the data dir, the start timestamp, the port, and so on. The probe must
 * read the first line and ignore the rest.
 */
function writePostmasterPid(pid: number): void {
  writeFileSync(
    join(dataDir, 'postmaster.pid'),
    `${pid}\n${dataDir}\n1755600000\n25432\n/tmp\nlocalhost\n  5432001         0\nready   \n`,
    'utf-8',
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nodalai-pgdata-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('readPostmasterPid', () => {
  it('returns null when there is no lockfile', () => {
    expect(readPostmasterPid(dataDir)).toBeNull();
  });

  it('reads the PID from the first line of a real-shaped lockfile', () => {
    writePostmasterPid(31415);
    expect(readPostmasterPid(dataDir)).toBe(31415);
  });

  it('returns null on a corrupt lockfile rather than guessing', () => {
    writeFileSync(join(dataDir, 'postmaster.pid'), 'not-a-pid\n/tmp\n', 'utf-8');
    expect(readPostmasterPid(dataDir)).toBeNull();
  });

  it('returns null on a non-positive PID', () => {
    writePostmasterPid(0);
    expect(readPostmasterPid(dataDir)).toBeNull();
  });
});

describe('livePostmasterPid', () => {
  it('returns null when there is no lockfile', () => {
    expect(livePostmasterPid(dataDir)).toBeNull();
  });

  it('returns null when the recorded PID is dead — that is a STALE lockfile', () => {
    writePostmasterPid(DEAD_PID);
    // The lockfile is readable...
    expect(readPostmasterPid(dataDir)).toBe(DEAD_PID);
    // ...but nothing is running, so there is no orphan to clean up.
    expect(livePostmasterPid(dataDir)).toBeNull();
  });

  it('reports a LIVE recorded PID — the orphan a port scan cannot see', () => {
    // This is the whole fix. The current process is alive and listening on
    // nothing at all, which is precisely the shape of the orphan postmaster
    // that made `up` fail: detectable by data dir, invisible by port.
    writePostmasterPid(process.pid);
    expect(livePostmasterPid(dataDir)).toBe(process.pid);
  });
});

describe('readPostmasterPid — the lockfile must be OURS', () => {
  // Codex review of PR #98, finding C3. A stale lockfile is not just stale: the
  // pid it records can since have been handed to somebody else's process, and
  // `up` hands that pid straight to SIGKILL. Line 2 of the file is the data
  // directory the postmaster was started with, and checking it costs nothing —
  // it catches a lockfile copied, restored from a backup, or left by another
  // cluster. It does not prove the pid was not recycled; the process table does
  // that, and `up` now asks it first.
  it('refuses a lockfile written for a DIFFERENT data directory', () => {
    writeFileSync(
      join(dataDir, 'postmaster.pid'),
      `${process.pid}\n${join(dataDir, 'somewhere-else')}\n1755600000\n25432\n`,
      'utf-8',
    );

    expect(readPostmasterPid(dataDir)).toBeNull();
    expect(livePostmasterPid(dataDir)).toBeNull();
  });

  it('accepts the same directory written with the other separators', () => {
    // Separators are interchangeable on Windows only, and case has its own case
    // below. Mixing both into one assertion made a CORRECT Linux implementation
    // fail (pass-9 finding R4).
    const other =
      process.platform === 'win32' ? dataDir.split('\\').join('/').toUpperCase() : dataDir;
    writeFileSync(
      join(dataDir, 'postmaster.pid'),
      `${process.pid}\n${other}\n1755600000\n25432\n`,
      'utf-8',
    );

    expect(readPostmasterPid(dataDir)).toBe(process.pid);
  });

  it('folds case only where the filesystem does', () => {
    // Pass-8 finding R1. Folding case everywhere made `/srv/PG/data` and
    // `/srv/pg/data` one directory — two different clusters on any
    // case-sensitive filesystem, and the check exists to tell them apart.
    // Windows really is case-insensitive, so there the other spelling is the
    // SAME directory and must still be accepted.
    const shouted = dataDir.toUpperCase();
    writeFileSync(
      join(dataDir, 'postmaster.pid'),
      `${process.pid}
${shouted}
1755600000
25432
`,
      'utf-8',
    );

    const expected = process.platform === 'win32' ? process.pid : null;
    expect(readPostmasterClaim(dataDir)?.pid ?? null).toBe(expected);
  });

  it('accepts a lockfile too short to carry the directory — nothing that worked stops', () => {
    writeFileSync(join(dataDir, 'postmaster.pid'), `${process.pid}\n`, 'utf-8');

    expect(readPostmasterPid(dataDir)).toBe(process.pid);
  });
});

describe('readPostmasterClaim — line 3 is the guard, so it is READ', () => {
  // Pass-4 question 9: nothing asserted the value taken off disk, so replacing
  // it with null would have escaped every assertion and switched the
  // recycled-pid guard off in production while the suite stayed green.
  it('reads the postmaster start time, in epoch seconds', () => {
    writePostmasterPid(31415);

    expect(readPostmasterClaim(dataDir)).toEqual({ pid: 31415, startedAtSeconds: 1755600000 });
  });

  it('says so when the lockfile is too short to carry it', () => {
    writeFileSync(
      join(dataDir, 'postmaster.pid'),
      `${process.pid}
${dataDir}
`,
      'utf-8',
    );

    expect(readPostmasterClaim(dataDir)).toEqual({ pid: process.pid, startedAtSeconds: null });
  });
});

describe('processStartedAtMs — dating ONE pid, without a process table', () => {
  // Pass-5 finding R1. Where no process table can be read, liveness was taken
  // for confirmation — and a stale lockfile on a recycled pid looks exactly
  // like our own postmaster under that rule. The OS can date a single pid
  // cheaply; asking it is what closes the hole without giving up cleanup.
  const onLinux = process.platform === 'linux';

  it.runIf(onLinux)('dates this very process to when it actually started', () => {
    const started = processStartedAtMs(process.pid);

    expect(started).not.toBeNull();
    // A function answering `Date.now()` is wrong by exactly the process's age,
    // so this only discriminates once that age exceeds the two-second window
    // the guard allows. ASSERTING that age failed a correct implementation on a
    // fast targeted run (pass-9 finding R4); the vitest process is seconds old
    // in any full run, and when it is not, this case simply proves less rather
    // than reporting a defect that is not there.
    // A 24-hour window would also accept `Date.now()` — that is, a function
    // that reads nothing and answers "now" (pass-6 finding R4). Node knows how
    // long IT has been running, so the answer is checked against that, within
    // the same two seconds the ownership guard itself allows.
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs(started! - expected)).toBeLessThan(2_000);
  });

  it.runIf(onLinux)('says nothing about a pid that does not exist', () => {
    expect(processStartedAtMs(DEAD_PID)).toBeNull();
  });

  it.skipIf(onLinux)('says nothing on a platform it cannot read', () => {
    // Windows answers through the WMI probe instead; this path is the fallback
    // for hosts with neither, and it must refuse rather than guess.
    expect(processStartedAtMs(process.pid)).toBeNull();
  });
});

describe('postgresProcessesForDataDir — the fallback wants TWO proofs', () => {
  // Where no process table can be read, the lockfile's claim is confirmed by
  // asking the OS about that one pid: which directory it runs out of, and when
  // it started. Both must hold.
  //
  // Pass-7 finding R3 rewrote these: the earlier version expected ownership
  // whenever the pid could be DATED, which a mutation answering `Date.now()`
  // also satisfied. What is asserted now is the agreement itself.

  it('owns nothing when the recorded start time disagrees, cwd or no cwd', () => {
    // Pass-8 finding R4: the earlier version of this case ran with a cwd that
    // did NOT match, so the clock-free proof refused first and the time check
    // was never reached — removing it left the test green. The test process
    // moves INTO the data directory here, so the start time is the only thing
    // left to refuse on.
    const before = process.cwd();
    try {
      process.chdir(dataDir);
      writeFileSync(
        join(dataDir, 'postmaster.pid'),
        `${process.pid}
${dataDir}
1
25432
`,
        'utf-8',
      );

      expect(unconfirmedReading(dataDir).owned).toEqual([]);
    } finally {
      process.chdir(before);
    }
  });

  it.runIf(process.platform === 'linux')(
    'owns the pid when BOTH proofs hold — the case the refusals are measured against',
    () => {
      const before = process.cwd();
      try {
        process.chdir(dataDir);
        const started = processStartedAtMs(process.pid);
        expect(started).not.toBeNull();
        writeFileSync(
          join(dataDir, 'postmaster.pid'),
          `${process.pid}
${dataDir}
${Math.round(started! / 1000)}
25432
`,
          'utf-8',
        );

        expect(unconfirmedReading(dataDir).owned).toEqual([process.pid]);
      } finally {
        process.chdir(before);
      }
    },
  );

  it('owns nothing when the process does not run out of our data directory', () => {
    // This test process runs from the repo, not from `dataDir` — so even with
    // a start time written to agree exactly, the clock-free proof refuses. It
    // is the case a wound-back wall clock cannot fake.
    const started = processStartedAtMs(process.pid) ?? Date.now();
    writeFileSync(
      join(dataDir, 'postmaster.pid'),
      `${process.pid}
${dataDir}
${Math.round(started / 1000)}
25432
`,
      'utf-8',
    );

    const reading = unconfirmedReading(dataDir);

    expect(reading.read).toBe(false);
    expect(reading.owned).toEqual([]);
  });

  it('owns nothing when the lockfile names a dead pid', async () => {
    writePostmasterPid(DEAD_PID);

    expect((await postgresProcessesForDataDir(dataDir)).owned).toEqual([]);
  });
});

describe('resolvePgCtl', () => {
  // Codex review of PR #98, pass 2, finding R3. `stopOrphanPostgres` used to
  // build an `EmbeddedPostgres` handle and call `.stop()`, and the comment said
  // that signals pg_ctl. It does not: in the installed package, `stop()` opens
  // with `if (!this.process) return;`, and a handle that never started a
  // cluster has no process. The call did nothing, the function reported
  // success, and the caller went on to SIGKILL the postmaster — leaking the
  // shared-memory section the graceful stop exists to release.
  //
  // `pg_ctl` is now run directly, so the path to it has to be REAL. This test
  // is the one that would have caught the silent no-op: it asserts a file on
  // disk, not an intention.
  it('finds the pg_ctl that ships with the embedded cluster', async () => {
    const binary = await resolvePgCtl();

    expect(
      binary,
      'pg_ctl must resolve to a real file or the graceful stop is a lie',
    ).not.toBeNull();
    expect(existsSync(binary!)).toBe(true);
    expect(binary!.split('\\').join('/')).toMatch(/@embedded-postgres\/.+\/native\/bin\/pg_ctl/);
  });
});

describe('stopOrphanPostgres — it stops the pid we DECIDED', () => {
  // Codex review of PR #98, pass 3, finding R2. `pg_ctl stop` re-reads
  // `postmaster.pid` and signals whatever pid it finds there — it checks no
  // data directory and knows nothing of what we decided. A stale or copied
  // lockfile naming a FOREIGN postmaster therefore got that postmaster shut
  // down, bypassing every ownership guard in this file. It is not called at all
  // unless the pid it would re-read is the one we settled on.
  /**
   * The refusal has to be distinguishable from `pg_ctl` merely failing — both
   * return false. Only the CODE says which happened, so that is what is read:
   * asserting the boolean alone let a mutation that removed the guard pass.
   */
  async function stopAndCapture(decided: number): Promise<{ ok: boolean; err: string }> {
    let err = '';
    const write = process.stderr.write.bind(process.stderr);
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
        err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
      });
    try {
      return { ok: await stopOrphanPostgres(decided, dataDir), err };
    } finally {
      spy.mockRestore();
    }
  }

  it('refuses when the lockfile names a pid other than the decided one', async () => {
    writePostmasterPid(31415);

    const { ok, err } = await stopAndCapture(999_999);

    expect(ok).toBe(false);
    expect(err).toContain('PG_CTL_SKIPPED_LOCKFILE_MISMATCH decided=999999 lockfile=31415');
    // And pg_ctl was never reached: no failure of its own is reported.
    expect(err).not.toContain('PG_CTL_STOP_FAILED');
  });

  it('refuses when there is no lockfile at all — nothing to re-read, nothing to signal', async () => {
    const { ok, err } = await stopAndCapture(31415);

    expect(ok).toBe(false);
    expect(err).toContain('PG_CTL_SKIPPED_LOCKFILE_MISMATCH decided=31415 lockfile=null');
  });

  // As root, `pg_ctl` is never reached — it refuses to run there, so the code
  // declines before spawning it. Asserting that it RAN would then fail for a
  // correct reason, which is a bad test, not a bug.
  const asRoot =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('calls pg_ctl when the lockfile names exactly the pid we decided', async () => {
    writePostmasterPid(31415);

    const { err } = await stopAndCapture(31415);

    // The directory is not a real cluster, so pg_ctl refuses — which is the
    // proof that it RAN. The mismatch guard did not fire.
    expect(err).not.toContain('PG_CTL_SKIPPED');
    expect(err).toContain('PG_CTL_STOP_FAILED');
  });

  it.runIf(asRoot)('declines to call pg_ctl at all when running as root', async () => {
    writePostmasterPid(31415);

    const { ok, err } = await stopAndCapture(31415);

    expect(ok).toBe(false);
    expect(err).toContain('PG_CTL_SKIPPED_ROOT');
  });
});
