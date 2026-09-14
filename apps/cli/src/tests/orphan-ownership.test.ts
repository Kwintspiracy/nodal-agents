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

  it('an io_worker of OUR postmaster is ours', () => {
    const rows = [postmaster(8932, OURS), ioWorker(5856, 8932)];

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
