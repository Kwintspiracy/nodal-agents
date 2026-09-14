// orphan-ownership.test.ts — regression for the incident of 2026-09-14 (#97).
//
// Starting a second, isolated stack killed the MAIN install's Postgres. Two
// defects, one line apart:
//
//   1. the ownership test accepted the embedded BINARY PATH as proof. Two
//      installs sharing one node_modules (a junctioned worktree) resolve to the
//      same path, so the probe claimed the other install's postmaster — pid
//      41956, listening on :25444 — and killed it;
//   2. every pid the process-table probe returned was printed next to
//      `config.ports.postgres`. Thirteen lines announced :25450 for processes
//      that had never listened on it.
//
// These cases run against rows shaped exactly like the ones WMI returns. They
// cannot run the probe itself — doing so on this machine means killing
// somebody's live database, which is the very bug — so the probe was split:
// the OS call stays in postgres.ts, the DECISION lives in orphans.ts and is
// what these tests hold.

import { describe, it, expect } from 'vitest';
import {
  classifyPostgresProcesses,
  measuredPort,
  formatForeignSkip,
  parseProcessRows,
  type PostgresProcessRow,
} from '../lib/orphans.ts';

const OURS = 'C:\\Users\\kwint\\AppData\\Local\\Temp\\wt-97\\.nodalai\\pg-data';
const THEIRS = 'C:\\Users\\kwint\\.nodalai\\pg-data';

/** The shared embedded binary — identical for both installs, which is the point. */
const BIN = 'C:/Users/kwint/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe';

function postmaster(pid: number, dataDir: string): PostgresProcessRow {
  return { pid, ppid: 1, commandLine: `"${BIN}" -D "${dataDir}"` };
}

function ioWorker(pid: number, parent: number): PostgresProcessRow {
  // The real shape, seen live on 2026-08-21: no data dir anywhere on the line.
  return { pid, ppid: parent, commandLine: `"${BIN}" --forkchild="io_worker" ${parent}` };
}

describe('classifyPostgresProcesses', () => {
  it('two installs sharing node_modules: only OUR postmaster is owned', () => {
    const rows = [postmaster(8932, OURS), postmaster(41956, THEIRS)];

    const { owned, skipped } = classifyPostgresProcesses(rows, OURS);

    expect(owned).toEqual([8932]);
    expect(skipped.map((s) => s.pid)).toEqual([41956]);
  });

  it('a NEIGHBOUR whose data dir merely starts with ours is not ours', () => {
    // The incident of 2026-09-14 came from proving ownership with a substring.
    // The fix replaced one substring (the binary path) with another (the data
    // dir), and a sibling install one suffix away — pg-data / pg-data2, or a
    // pg-data.bak kept beside it — walked straight back through the same door:
    // its postmaster AND its workers were claimed, and `up` kills what it
    // claims.
    const voisin = `${OURS}2`;
    const rows = [postmaster(8932, OURS), postmaster(41956, voisin), ioWorker(7100, 41956)];

    const { owned, skipped } = classifyPostgresProcesses(rows, OURS);

    expect(owned).toEqual([8932]);
    expect(skipped.map((s) => s.pid)).toEqual([41956, 7100]);
  });

  it('a data dir written with a trailing separator names the same cluster', () => {
    const rows = [postmaster(8932, OURS)];

    expect(classifyPostgresProcesses(rows, OURS + '\\').owned).toEqual([8932]);
  });

  // Codex review of this PR, findings C1, C2 and C5. The path boundary added
  // in 527c5148 accepted `/` and a space as the end of the argument — neither
  // ends an argument — and it had LOST the tab the old `includes` accepted.
  // Four foreign data dirs were still claimed, and ours could stop being
  // recognised. What `-D` names is now read as an argument, and compared whole.
  const foreign = (pid: number, commandLine: string): PostgresProcessRow => ({
    pid,
    ppid: 1,
    commandLine,
  });
  const US = 'C:/install/pg-data';

  it('a data dir NEXT TO ours is not ours, in any of the shapes found', () => {
    for (const cmd of [
      `postgres.exe -D "${US}/other"`, // a sub-directory
      `postgres.exe -D "${US} backup"`, // a name that merely starts the same
      `postgres.exe -D "${US}/../foreign"`, // a climb back out
      `postgres.exe -D "${US}2"`,
      `postgres.exe -D "${US}.bak"`,
    ]) {
      expect(classifyPostgresProcesses([foreign(101, cmd)], US).owned, cmd).toEqual([]);
    }
  });

  it('our path somewhere OTHER than behind -D does not make the cluster ours', () => {
    // C2: the cluster lives elsewhere, only its external PID file sits with us.
    const cmd = `postgres.exe -D C:/foreign -c external_pid_file="${US}/foreign.pid"`;

    expect(classifyPostgresProcesses([foreign(201, cmd)], US).owned).toEqual([]);
  });

  it('our postmaster is recognised however the argument is written', () => {
    for (const cmd of [
      `postgres.exe -D "${US}"`, // quoted
      `postgres.exe -D ${US}`, // bare
      `postgres.exe -D ${US}\t-p 5432`, // C5: separated by a tab
      `postgres.exe -D"${US}"`, // glued
      `postgres.exe --pgdata="${US}"`, // the long form
      `postgres.exe --pgdata ${US}`,
    ]) {
      expect(classifyPostgresProcesses([foreign(301, cmd)], US).owned, cmd).toEqual([301]);
    }
  });

  it('the LAST -D wins, as PostgreSQL itself does', () => {
    // Codex review of this PR, pass 2, finding R1. `-D` is read with getopt:
    // each occurrence overwrites the previous, so the server uses the LAST one.
    // Taking the first meant claiming a cluster whose real data dir is
    // somewhere else — and killing it — while refusing our own in the mirror
    // case.
    expect(
      classifyPostgresProcesses([foreign(101, `postgres.exe -D ${US} -D C:/foreign`)], US).owned,
    ).toEqual([]);
    expect(
      classifyPostgresProcesses([foreign(102, `postgres.exe -D C:/foreign -D ${US}`)], US).owned,
    ).toEqual([102]);
  });

  it('-c data_directory overrides -D, so it decides', () => {
    // Codex review of this PR, pass 2, finding R2. `data_directory` is a
    // configuration setting, and a setting beats the command-line default: the
    // server runs against IT, not against `-D`.
    expect(
      classifyPostgresProcesses(
        [foreign(201, `postgres.exe -D ${US} -c data_directory=C:/foreign`)],
        US,
      ).owned,
    ).toEqual([]);
    expect(
      classifyPostgresProcesses(
        [foreign(202, `postgres.exe -D C:/foreign -c data_directory=${US}`)],
        US,
      ).owned,
    ).toEqual([202]);
  });

  it('an io_worker of OUR postmaster is ours', () => {
    const rows = [postmaster(8932, OURS), ioWorker(5856, 8932)];

    expect(classifyPostgresProcesses(rows, OURS).owned).toEqual([8932, 5856]);
  });

  it('a parent that started AFTER its supposed child is a recycled pid, not a parent', () => {
    // Codex review of this PR, finding C4. A foreign worker outlives its
    // postmaster; the OS hands that freed pid to OUR postmaster. The rows then
    // read as a family, and the worker — someone else's — is adopted and
    // killed. Nothing in a pid says which generation it belongs to, but a
    // creation date does: a parent cannot start after its own child.
    const rows: PostgresProcessRow[] = [
      { pid: 8932, ppid: 1, commandLine: `"${BIN}" -D "${OURS}"`, startedAt: 2_000 },
      {
        pid: 7100,
        ppid: 8932,
        commandLine: `"${BIN}" --forkchild="io_worker" 8932`,
        startedAt: 1_000,
      },
    ];

    const { owned, skipped } = classifyPostgresProcesses(rows, OURS);

    expect(owned).toEqual([8932]);
    expect(skipped.map((s) => s.pid)).toEqual([7100]);
  });

  it('a worker older than nothing keeps its parent when the dates agree', () => {
    const rows: PostgresProcessRow[] = [
      { pid: 8932, ppid: 1, commandLine: `"${BIN}" -D "${OURS}"`, startedAt: 1_000 },
      {
        pid: 5856,
        ppid: 8932,
        commandLine: `"${BIN}" --forkchild="io_worker" 8932`,
        startedAt: 2_000,
      },
    ];

    expect(classifyPostgresProcesses(rows, OURS).owned).toEqual([8932, 5856]);
  });

  it('an io_worker of the FOREIGN postmaster is not ours, whatever binary it runs', () => {
    const rows = [postmaster(8932, OURS), postmaster(41956, THEIRS), ioWorker(7100, 41956)];

    const { owned, skipped } = classifyPostgresProcesses(rows, OURS);

    expect(owned).toEqual([8932]);
    expect(skipped.map((s) => s.pid).sort((a, b) => a - b)).toEqual([7100, 41956]);
  });

  it('a worker whose parent is not in the table at all is skipped, not guessed', () => {
    const rows = [ioWorker(7100, 999999)];

    const { owned, skipped } = classifyPostgresProcesses(rows, OURS);

    expect(owned).toEqual([]);
    expect(skipped[0]?.reason).toContain('999999');
  });

  it('matches the data dir across slash styles and case', () => {
    const rows: PostgresProcessRow[] = [
      { pid: 42, ppid: 1, commandLine: `"${BIN}" -D "${OURS.toUpperCase().replace(/\\/g, '/')}"` },
    ];

    expect(classifyPostgresProcesses(rows, OURS).owned).toEqual([42]);
  });

  it('a corrupt parent chain does not loop forever', () => {
    const rows: PostgresProcessRow[] = [
      { pid: 10, ppid: 11, commandLine: 'postgres.exe --forkchild="io_worker" 11' },
      { pid: 11, ppid: 10, commandLine: 'postgres.exe --forkchild="io_worker" 10' },
    ];

    expect(classifyPostgresProcesses(rows, OURS).owned).toEqual([]);
  });

  it('reports the refusal with a machine code, not a sentence', () => {
    const { skipped } = classifyPostgresProcesses([postmaster(41956, THEIRS)], OURS);

    const line = formatForeignSkip(skipped[0]!);

    expect(line).toMatch(/^ORPHAN_PROBE_FOREIGN_POSTGRES_SKIPPED pid=41956 reason=\S/);
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

describe('parseProcessRows', () => {
  // The Codex review of this PR pointed at a hole, and it was real: nothing
  // tested the parsing, because it lived inside the probe and the probe cannot
  // run in a suite. The shape below is a VERBATIM line from the real command,
  // taken by running it on this machine — note the pipes inside the command
  // line itself, which is why only the first three separators are cut.
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
