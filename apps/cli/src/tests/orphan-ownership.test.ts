// orphan-ownership.test.ts — whose Postgres is this?
//
// The incident of 2026-09-14 (#97): starting a second, isolated stack killed
// the MAIN install's Postgres. Ownership was decided by the embedded BINARY
// PATH, and two installs sharing one node_modules — a junctioned worktree, the
// supported way to review a branch on Windows — resolve to the same path.
//
// Three passes of Codex review then found three more ways to attribute a
// foreign cluster, each a new spelling of the same mistake: the data dir as a
// substring of the command line, then as a bounded path, then the `-D`
// argument, then `-c data_directory=`. The third pass named the pattern rather
// than the next spelling — a process table cannot say whose a cluster is, since
// `postgresql.conf` can redirect `data_directory` and never appears on any
// command line.
//
// So the question is turned around, and these cases hold the new rule: the DATA
// DIRECTORY answers, the process table only confirms. `postmaster.pid` is
// written BY the postmaster that holds this directory — true by construction,
// not by resemblance.
//
// Rows here are shaped exactly like the ones WMI returns. The probe itself
// cannot run in a suite: doing so on this machine means killing somebody's live
// database, which is the very bug.

import { describe, it, expect } from 'vitest';
import {
  ownedPostgresPids,
  measuredPort,
  formatForeignSkip,
  parseProcessRows,
  type LockfileClaim,
  type PostgresProcessRow,
} from '../lib/orphans.ts';

const OURS = 'C:\\Users\\kwint\\AppData\\Local\\Temp\\wt-97\\.nodalai\\pg-data';

/** The shared embedded binary — identical for both installs, which is the point. */
const BIN = 'C:/Users/kwint/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe';

function postmaster(
  pid: number,
  dataDir: string,
  startedAt = 1_700_000_000_000,
): PostgresProcessRow {
  return { pid, ppid: 1, commandLine: `"${BIN}" -D "${dataDir}"`, startedAt };
}

function ioWorker(pid: number, parent: number, startedAt = 1_700_000_001_000): PostgresProcessRow {
  // The real shape, seen live on 2026-08-21: no data dir anywhere on the line.
  return {
    pid,
    ppid: parent,
    commandLine: `"${BIN}" --forkchild="io_worker" ${parent}`,
    startedAt,
  };
}

/** What our own lockfile claims, consistent with `postmaster()`'s default. */
const claims = (pid: number, startedAtSeconds: number | null = 1_700_000_000): LockfileClaim => ({
  pid,
  startedAtSeconds,
});

describe('ownedPostgresPids — the data directory answers', () => {
  it('owns the pid our lockfile names, and its workers', () => {
    const rows = [postmaster(8932, OURS), ioWorker(5856, 8932)];

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([8932, 5856]);
    expect(skipped).toEqual([]);
  });

  it('owns NOTHING when no lockfile claims this directory', () => {
    // The 2026-08-20 shape: a postmaster alive with its lockfile gone. The old
    // code guessed from the command line and could be right; it could also kill
    // a stranger, which it did. Refusing to guess is the trade, and it is here
    // on purpose rather than by omission.
    const rows = [postmaster(8932, OURS), ioWorker(5856, 8932)];

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: null });

    expect(owned).toEqual([]);
    expect(skipped.map((s) => s.pid)).toEqual([8932, 5856]);
    expect(skipped[0]?.reason).toContain('no postmaster.pid');
  });

  it('a command line naming our directory does not make a cluster ours', () => {
    // This is the whole reversal. The foreign postmaster carries our data dir on
    // its command line — exactly what every previous rule looked at — and it is
    // NOT ours, because our lockfile names someone else.
    const rows = [postmaster(8932, OURS), postmaster(41956, OURS)];

    const { owned } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([8932]);
  });

  it('refuses a RECYCLED pid: the process is younger than the start we recorded', () => {
    // A lockfile survives a crash and the OS hands its pid to something else.
    // No name, no path, no ancestry tells them apart. The creation date does.
    const rows = [postmaster(8932, OURS, 1_700_000_900_000)]; // fifteen minutes later

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([]);
    expect(skipped[0]?.reason).toContain('lockfile says');
  });

  it('accepts the small gap between the postmaster starting and writing its lockfile', () => {
    const rows = [postmaster(8932, OURS, 1_700_000_000_000 + 900)];

    expect(ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) }).owned).toEqual([8932]);
  });

  it('refuses when the lockfile names a pid that is not a live postgres', () => {
    const rows = [postmaster(41956, OURS)];

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([]);
    expect(skipped[0]?.reason).toContain('is not a live postgres');
  });

  it('owns NOTHING when the table could not be read — a claim alone is not proof', () => {
    // Pass-5 finding R1, and the test that used to demand the opposite. A
    // lockfile with nothing to confirm it is indistinguishable from a stale one
    // whose pid the OS has handed to a stranger. A caller that can date the pid
    // another way says so by handing a row for it (see `unconfirmedReading`);
    // a caller that cannot gets nothing.
    const { owned, skipped } = ownedPostgresPids({
      rows: [postmaster(8932, OURS)],
      tableRead: false,
      claim: claims(8932),
    });

    expect(owned).toEqual([]);
    expect(skipped[0]?.reason).toContain('could not be read');
  });

  it('a missing creation date REFUSES, it does not wave through', () => {
    // Pass-4 finding R2. The date check used to answer "unknowable, therefore
    // yes", which switched off the one guard that catches a recycled pid
    // exactly when the inputs were incomplete. Measured both ways then: a
    // foreign postmaster came back owned.
    const noDate: PostgresProcessRow = {
      pid: 8932,
      ppid: 1,
      commandLine: 'postgres',
      startedAt: undefined,
    };

    expect(
      ownedPostgresPids({ rows: [noDate], tableRead: true, claim: claims(8932) }).owned,
    ).toEqual([]);
    // And the other side: a lockfile too old to carry line 3.
    expect(
      ownedPostgresPids({
        rows: [postmaster(8932, OURS)],
        tableRead: true,
        claim: claims(8932, null),
      }).owned,
    ).toEqual([]);
  });

  it('a worker with no creation date is not adopted either', () => {
    const rows: PostgresProcessRow[] = [
      postmaster(8932, OURS),
      { pid: 5856, ppid: 8932, commandLine: 'postgres --forkchild', startedAt: undefined },
    ];

    expect(ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) }).owned).toEqual([8932]);
  });

  it('half a minute apart is a different generation, not a slow start', () => {
    // Pass-4 finding R3. The window was a minute, justified by "a slow disk" —
    // and the disk is not in the picture: line 3 is the postmaster's own start
    // time, recorded before the file is written. A minute was wide enough to
    // accept a pid recycled around that instant. Measured: 30 s was accepted.
    const rows = [postmaster(8932, OURS, 1_700_000_030_000)];

    expect(ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) }).owned).toEqual([]);
  });

  it('a worker of a FOREIGN postmaster is not adopted', () => {
    const rows = [postmaster(8932, OURS), postmaster(41956, OURS), ioWorker(7100, 41956)];

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([8932]);
    expect(skipped.map((s) => s.pid).sort((a, b) => a - b)).toEqual([7100, 41956]);
  });

  it('a parent that started AFTER its child is a recycled pid, not a parent', () => {
    // A foreign worker outlives its postmaster; the OS hands that freed pid to
    // OURS. The rows read as a family and the worker would be adopted.
    const rows = [postmaster(8932, OURS, 2_000_000), ioWorker(7100, 8932, 1_000_000)];

    const { owned } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932, 2_000) });

    expect(owned).toEqual([8932]);
  });

  it('a worker whose parent is not in the table is skipped, not guessed', () => {
    const rows = [postmaster(8932, OURS), ioWorker(7100, 999999)];

    const { owned, skipped } = ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) });

    expect(owned).toEqual([8932]);
    expect(skipped[0]?.reason).toContain('999999');
  });

  it('reaches a worker through an intermediate process of ours', () => {
    const rows = [
      postmaster(8932, OURS),
      ioWorker(5856, 8932),
      ioWorker(5857, 5856, 1_700_000_002_000),
    ];

    expect(ownedPostgresPids({ rows, tableRead: true, claim: claims(8932) }).owned).toEqual([
      8932, 5856, 5857,
    ]);
  });
});

describe('formatForeignSkip', () => {
  it('reports a refusal as a CODE with its pid, never a sentence', () => {
    const line = formatForeignSkip({ pid: 41956, reason: 'ancestry=1 does not reach 8932' });

    expect(line).toMatch(/^ORPHAN_PROBE_FOREIGN_POSTGRES_SKIPPED pid=41956 reason=\S/);
  });
});

describe('parseProcessRows', () => {
  // The review pointed at a hole, and it was real: nothing tested the parsing,
  // because it lived inside a probe that cannot run in a suite. The shape below
  // is a VERBATIM line from the real command, taken by running it on this
  // machine — note the pipes inside the command line itself, which is why only
  // the first three separators are cut.
  const REAL =
    '55768|45420|1789376176154|powershell -NoProfile -Command "Get-CimInstance ' +
    'Win32_Process -Filter \\"Name=\'postgres.exe\'\\" | ForEach-Object { $ms | 0 }"';

  it('keeps the command line whole, pipes and all', () => {
    const [row] = parseProcessRows(REAL);

    expect(row?.pid).toBe(55768);
    expect(row?.ppid).toBe(45420);
    expect(row?.startedAt).toBe(1_789_376_176_154);
    expect(row?.commandLine).toBe(REAL.slice(REAL.indexOf('powershell')));
  });

  it('drops a line that does not carry the three separators', () => {
    // A truncated or continued line used to be half-read, and the review made
    // one into a pid classified as ours. Half a row is not a row.
    expect(parseProcessRows('999|1|C:/install/pg-data"')).toEqual([]);
    expect(parseProcessRows('not a row at all')).toEqual([]);
    expect(parseProcessRows('')).toEqual([]);
  });

  it('leaves the date out when the process table did not give one', () => {
    const [row] = parseProcessRows('42|1|0|postgres.exe -D "C:/x"');

    expect(row?.startedAt).toBeUndefined();
    expect(row?.commandLine).toBe('postgres.exe -D "C:/x"');
  });

  it('reads an empty command line — another user’s process, access denied', () => {
    const [row] = parseProcessRows('101|1|0|');

    expect(row).toEqual({ pid: 101, ppid: 1, commandLine: '' });
  });
});

describe('measuredPort', () => {
  const listeners = [
    { name: 'web', port: 3000, pid: 111 },
    { name: 'postgres', port: 25450, pid: 222 },
  ];

  it('gives a pid the port it was OBSERVED on', () => {
    expect(measuredPort(222, listeners)).toBe(25450);
  });

  it('gives no port to a pid that listens on none of our ports', () => {
    // pid 41956 was the other install's postmaster on :25444 — a port this
    // config never mentions. It must not be stamped with ours.
    expect(measuredPort(41956, listeners)).toBeNull();
  });

  it('gives no port when nothing was measured at all', () => {
    expect(measuredPort(222, [])).toBeNull();
  });
});
