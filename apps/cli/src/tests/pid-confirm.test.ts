// pid-confirm.test.ts — the rules that decide whether a recorded pid may be
// signalled (issue #100).
//
// Every case here is a way a number in `~/.nodalai/pids/processes.json` can
// stop naming the process we recorded, and the assertion is always the same
// shape: the refusal, and WHICH refusal. The code matters as much as the
// verdict — "we did not kill it" and "we did not kill it because the process
// table never answered" send a reader to two different places.
//
// Pure functions, real inputs, no mocks: the probe these serve cannot run in a
// suite without killing somebody's processes, which is exactly why the decision
// was extracted from it.

import { describe, it, expect } from 'vitest';
import {
  confirmRecordedPid,
  confirmTree,
  formatRefusal,
  type Confirmation,
  type LiveProcess,
} from '../lib/pid-confirm.ts';

const TICK = '638000000000000000';
const OTHER_TICK = '638999999999999999';

const ours: LiveProcess = { pid: 4242, startedAt: TICK, name: 'node.exe' };
const recorded = { pid: 4242, startedAt: TICK, name: 'node.exe' };

/** The refusal code, or 'KILLABLE'. Keeps every assertion one line. */
function verdict(c: Confirmation): string {
  return c.killable ? 'KILLABLE' : c.code;
}

describe('confirmRecordedPid @cap:installer-et-demarrer/moteur', () => {
  it('lets through a pid whose tick and executable both still match', () => {
    expect(
      verdict(
        confirmRecordedPid({
          recorded,
          live: ours,
          tableRead: true,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('KILLABLE');
  });

  it('refuses a pid the OS handed to a different generation', () => {
    // The ordinary recycled pid: same number, same executable even, different
    // creation tick. This is the one `sweepRecordedChildren` already caught;
    // the case is here so the rule cannot be lost when the rest moves.
    const c = confirmRecordedPid({
      recorded,
      live: { ...ours, startedAt: OTHER_TICK },
      tableRead: true,
      ownedPostgresPids: new Set(),
    });
    expect(verdict(c)).toBe('PID_RECYCLED');
    expect(formatRefusal(c as Extract<Confirmation, { killable: false }>)).toContain(
      'KILL_REFUSED code=PID_RECYCLED',
    );
  });

  it('refuses a pid now carried by a different executable', () => {
    // A tick can coincide — two processes created in the same 100ns window is
    // absurd, but a pid file restored from a backup, or a tick field that came
    // back empty, makes the comparison vacuous. The binary is the second proof.
    expect(
      verdict(
        confirmRecordedPid({
          recorded,
          live: { ...ours, name: 'chrome.exe' },
          tableRead: true,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('BINARY_CHANGED');
  });

  it('refuses a postgres our data dir does not claim, even with a perfect record', () => {
    // THE case of #100: the pid arrives through the non-postgres path, where
    // `ownedPgPids` was never consulted, and takes a `taskkill /T`. Both the
    // tick and the recorded name agree here — nothing but the ownership rule
    // stands between this pid and a SIGKILL.
    expect(
      verdict(
        confirmRecordedPid({
          recorded: { pid: 41956, startedAt: TICK, name: 'postgres.exe' },
          live: { pid: 41956, startedAt: TICK, name: 'postgres.exe' },
          tableRead: true,
          ownedPostgresPids: new Set([999]),
        }),
      ),
    ).toBe('FOREIGN_POSTGRES');
  });

  it('lets through a postgres the data dir DOES claim', () => {
    expect(
      verdict(
        confirmRecordedPid({
          recorded: { pid: 41956, startedAt: TICK, name: 'postgres.exe' },
          live: { pid: 41956, startedAt: TICK, name: 'postgres.exe' },
          tableRead: true,
          ownedPostgresPids: new Set([41956]),
        }),
      ),
    ).toBe('KILLABLE');
  });

  it('refuses a bare number — a pid file written before any identity was recorded', () => {
    // `runner` and `web` were stored as plain integers. There is nothing here
    // to compare, so there is nothing to conclude, so nothing is killed.
    expect(
      verdict(
        confirmRecordedPid({
          recorded: { pid: 4242 },
          live: ours,
          tableRead: true,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('IDENTITY_NOT_RECORDED');
  });

  it('refuses when the process table did not answer, rather than trusting the record', () => {
    // "The table was empty" and "nothing is running" look alike and are not the
    // same fact. The old sweep treated them alike by accident — every lookup
    // missed, every record was skipped, in silence.
    expect(
      verdict(
        confirmRecordedPid({
          recorded,
          live: undefined,
          tableRead: false,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('TABLE_UNREADABLE');
  });

  it('reports a pid absent from a table that DID answer as simply gone', () => {
    expect(
      verdict(
        confirmRecordedPid({
          recorded,
          live: undefined,
          tableRead: true,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('PID_GONE');
  });

  it('matches the executable name case-insensitively', () => {
    // Get-CimInstance and Get-WmiObject are two different sources; a casing
    // difference between them must not read as a recycled pid.
    expect(
      verdict(
        confirmRecordedPid({
          recorded: { pid: 4242, startedAt: TICK, name: 'Node.exe' },
          live: { pid: 4242, startedAt: TICK, name: 'NODE.EXE' },
          tableRead: true,
          ownedPostgresPids: new Set(),
        }),
      ),
    ).toBe('KILLABLE');
  });
});

describe('confirmTree @cap:installer-et-demarrer/moteur', () => {
  const root = {
    recorded,
    live: ours,
    tableRead: true,
    ownedPostgresPids: new Set<number>(),
  };

  it('allows taskkill /T over a tree of our own processes', () => {
    const v = confirmTree(
      root,
      [
        { pid: 11, startedAt: TICK, name: 'node.exe' },
        { pid: 12, startedAt: TICK, name: 'cmd.exe' },
      ],
      new Set(),
    );
    expect(v.treeKillAllowed).toBe(true);
    expect(v.foreign).toEqual([]);
    expect(v.killable.map((m) => m.pid)).toEqual([11, 12]);
  });

  it('vetoes taskkill /T when a foreign Postgres sits in the tree', () => {
    // `/T` kills every member without ever saying what they were. A service we
    // started can have started a cluster against ANOTHER data directory, and
    // that cluster must survive the shutdown of its parent.
    const stranger = { pid: 41956, startedAt: TICK, name: 'postgres.exe' };
    const v = confirmTree(
      root,
      [{ pid: 11, startedAt: TICK, name: 'node.exe' }, stranger],
      new Set(),
    );
    expect(v.treeKillAllowed).toBe(false);
    expect(v.foreign).toEqual([stranger]);
    // …and the rest of the tree is still reachable, one pid at a time.
    expect(v.killable.map((m) => m.pid)).toEqual([11]);
  });

  it('keeps /T when the Postgres in the tree is one we can claim', () => {
    const v = confirmTree(
      root,
      [{ pid: 41956, startedAt: TICK, name: 'postgres.exe' }],
      new Set([41956]),
    );
    expect(v.treeKillAllowed).toBe(true);
    expect(v.foreign).toEqual([]);
  });

  it('vetoes /T when the root itself cannot be confirmed', () => {
    const v = confirmTree(
      { ...root, live: { ...ours, startedAt: OTHER_TICK } },
      [{ pid: 11, startedAt: TICK, name: 'node.exe' }],
      new Set(),
    );
    expect(v.treeKillAllowed).toBe(false);
    expect(verdict(v.root)).toBe('PID_RECYCLED');
  });
});
