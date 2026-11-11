// kill-tree-refusal.test.ts — what `killPidTree` does when the fresh reading
// disagrees with the record, or when there is no reading at all.
//
// The hole this closes (review of PR #114, 2026-09-16). `killPidTree` already
// judged the tree — a foreign postgres among the members vetoed `taskkill /T`
// — but the ROOT fell through to an unconditional `taskkill /F /PID <root>` in
// the very same branch, including the two cases where the reading had just said
// the root must not be touched:
//
//   · the process table did not answer at all (`tableRead` false) about a pid
//     read back from `processes.json`: nothing confirmed that number, and the
//     old code killed on it anyway — precisely the claim the pull request makes
//     it no longer makes. A pid the caller holds a live HANDLE to is the other
//     case, and it keeps the old reach: there the handle IS the identity;
//   · the table answered and DISOWNED the root: the pid now carries another
//     executable, or another generation of the same one. Windows hands a freed
//     number to the next process that asks, and the caller's confirmation was
//     taken against an EARLIER reading than this one.
//
// Everything real is mocked at the `execa` boundary, which is where both the
// process-table query and every `taskkill` go through. So the assertions are on
// the actual argument arrays a real Windows would have received, and no live
// process is signalled by this file — `isPidAlive` uses signal 0, which kills
// nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { killPidTree, ProcessReading } from '../lib/processes.ts';
import type { RecordedProcess } from '../lib/pid-confirm.ts';

/**
 * What a caller holding a record hands over: the record, and the reading it
 * was confirmed on — taken here exactly as `down` takes it, through the mocked
 * table, so the FIRST table of a sequence is the caller's reading (#1046).
 */
async function proofOf(recorded: RecordedProcess) {
  return { recorded, reading: await ProcessReading.take() };
}

const mockExeca = vi.mocked(execa);

/** A row in the exact shape `readProcessTableWin` parses: pid|ppid|ticks|name. */
interface Row {
  pid: number;
  ppid: number;
  ticks: string;
  name: string;
}

const ROOT = 999_001;
const TICK_RECORDED = '638000000000000000';
const TICK_OTHER = '638999999999999999';

/** A member that must really be alive, or the sweep skips it before execa. */
const LIVE_MEMBER = process.pid;

/** The line separator WMI emits. Assembled here so no shell can eat it. */
const EOL = String.fromCharCode(13, 10);

let originalPlatform: PropertyDescriptor | undefined;
let stderrLines: string[];
let restoreStderr: () => void;

/** Drive the mocked process table, and record every taskkill argument array. */
function tableReturns(rows: Row[]): void {
  const stdout = rows.map((r) => `${r.pid}|${r.ppid}|${r.ticks}|${r.name}`).join('\r\n');
  mockExeca.mockImplementation(((file: string) => {
    if (file === 'powershell') {
      return Promise.resolve({ stdout, stderr: '', exitCode: 0, timedOut: false });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
  }) as unknown as typeof execa);
}

/**
 * Drive SUCCESSIVE readings: the Nth process-table query gets the Nth table,
 * and the last one repeats. `killPidTree` reads the table twice — once to walk
 * the tree, once to re-confirm the members just before signalling them — and
 * what happens BETWEEN those two readings is the whole subject of the cases
 * that use this.
 *
 * One entry is consumed per powershell call, not per snapshot: a reading that
 * comes back empty falls through to the second query, so an unreadable table
 * costs two entries.
 */
function tableSequence(tables: readonly Row[][]): void {
  let call = 0;
  mockExeca.mockImplementation(((file: string) => {
    if (file === 'powershell') {
      const rows = tables[Math.min(call, tables.length - 1)] ?? [];
      call += 1;
      const stdout = rows.map((r) => `${r.pid}|${r.ppid}|${r.ticks}|${r.name}`).join(EOL);
      return Promise.resolve({ stdout, stderr: '', exitCode: 0, timedOut: false });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
  }) as unknown as typeof execa);
}

/** Every `taskkill` invocation, as (file, args) pairs. */
function taskkills(): string[][] {
  return mockExeca.mock.calls
    .filter((c) => c[0] === 'taskkill')
    .map((c) => (c[1] as string[]).slice());
}

beforeEach(() => {
  vi.clearAllMocks();
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  // The whole branch under test is the Windows one. The table it reads is
  // mocked, so the OS underneath is irrelevant — and the Linux CI job must run
  // these cases, not skip them.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  stderrLines = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, 'write');
  spy.mockImplementation(((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write);
  restoreStderr = () => {
    spy.mockRestore();
    void original;
  };
});

afterEach(() => {
  restoreStderr();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

describe('killPidTree — the root is not signalled unproven @cap:installer-et-demarrer/moteur', () => {
  it('signals NOTHING for a RECORDED pid when the process table could not be read', async () => {
    // An empty answer is not an empty machine. `readProcessTableWin` returns an
    // empty map, `tableRead` is false, and nothing below has been confirmed.
    tableReturns([]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(
      ROOT,
      new Set(),
      await proofOf({ pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED }),
    );

    expect(taskkills()).toEqual([]);
    const said = stderrLines.join('');
    expect(said).toContain('KILL_REFUSED code=TABLE_UNREADABLE');
    expect(said).toContain(String(ROOT));
  });

  it('still reaches a LIVE HANDLE when the table does not answer, and says so', async () => {
    // The other half of the same rule. `killProcessTree(child)` holds the
    // process it spawned seconds ago; there is nothing to confirm, and a
    // machine whose WMI will not answer — GitHub's Windows runner, for one —
    // must still be able to stop its own children.
    tableReturns([]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set());

    expect(taskkills()).toEqual([['/F', '/PID', String(ROOT)]]);
    const said = stderrLines.join('');
    expect(said).toContain('KILL_UNCONFIRMED code=TABLE_UNREADABLE');
    expect(said).not.toContain('KILL_REFUSED');
  });

  it('spares a recycled root and still kills the members the same reading vouched for', async () => {
    // The number is alive, and it is somebody else's: recorded as node.exe,
    // the table now reports chrome.exe.
    tableReturns([
      { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'chrome.exe' },
      { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' },
    ]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(
      ROOT,
      new Set(),
      await proofOf({ pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED }),
    );

    // The root: never, under any form — neither `/T` nor alone.
    expect(taskkills().some((args) => args.includes(String(ROOT)))).toBe(false);
    // The member: observed as a descendant in THIS reading, so it is killed.
    expect(taskkills()).toEqual([['/F', '/PID', String(LIVE_MEMBER)]]);
    expect(stderrLines.join('')).toContain('KILL_REFUSED code=BINARY_CHANGED');
  });

  it('spares a root whose generation changed, by the creation tick alone', async () => {
    tableReturns([{ pid: ROOT, ppid: 4, ticks: TICK_OTHER, name: 'node.exe' }]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(
      ROOT,
      new Set(),
      await proofOf({ pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED }),
    );

    expect(taskkills()).toEqual([]);
    expect(stderrLines.join('')).toContain('KILL_REFUSED code=PID_RECYCLED');
  });

  it('kills the tree in one `/T` when the reading AGREES with the record', async () => {
    tableReturns([
      { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' },
      { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' },
    ]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(
      ROOT,
      new Set(),
      await proofOf({ pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED }),
    );

    expect(taskkills()[0]).toEqual(['/T', '/F', '/PID', String(ROOT)]);
    expect(stderrLines.join('')).not.toContain('KILL_REFUSED');
  });

  it('spares a root whose RECORD is a bare number, proving nothing', async () => {
    // A `processes.json` written before #100 carries pids and no identity.
    // `confirmRecordedPid` answers IDENTITY_NOT_RECORDED, and the number is
    // then signalled anyway unless that verdict is spent — which is the hole
    // this closes. No caller does it today; the next one would have.
    tableReturns([
      { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' },
      { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' },
    ]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf({ pid: ROOT }));

    expect(taskkills().some((args) => args.includes(String(ROOT)))).toBe(false);
    expect(taskkills()).toEqual([['/F', '/PID', String(LIVE_MEMBER)]]);
    expect(stderrLines.join('')).toContain('KILL_REFUSED code=IDENTITY_NOT_RECORDED');
  });

  it('still kills a root the caller holds a handle to, with no record to compare', async () => {
    // `killProcessTree(child)` has no record and needs none: the handle IS the
    // identity. `IDENTITY_NOT_RECORDED` must not become a refusal here, or
    // every spawned child would survive its own shutdown — the same verdict as
    // the case above, read the other way because the caller is not the same.
    tableReturns([{ pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' }]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set());

    expect(taskkills()).toEqual([['/F', '/PID', String(ROOT)]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('killPidTree — the members are re-read before they are signalled @cap:installer-et-demarrer/moteur', () => {
  // Review pass 3 of #114. Between the reading that walks the tree and the kills
  // that follow sits the ROOT kill, which takes as long as taskkill takes — and
  // Windows hands a freed number to the next process that asks. The root was
  // already held to a fresh reading; its children were not.
  const ROOT_ROW: Row = { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' };
  const MEMBER_ROW: Row = { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' };
  const RECORD = { pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED };

  it('spares a member the second reading no longer recognises', async () => {
    // Same number, another process: recycled while the root was being killed.
    tableSequence([[ROOT_ROW, MEMBER_ROW], [{ ...MEMBER_ROW, name: 'chrome.exe' }]]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf(RECORD));

    expect(taskkills()).toEqual([['/T', '/F', '/PID', String(ROOT)]]);
    expect(stderrLines.join('')).toContain('KILL_REFUSED code=BINARY_CHANGED');
  });

  it('spares a member whose generation changed under the same name', async () => {
    tableSequence([[ROOT_ROW, MEMBER_ROW], [{ ...MEMBER_ROW, ticks: TICK_OTHER }]]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf(RECORD));

    expect(taskkills().some((args) => args.includes(String(LIVE_MEMBER)))).toBe(false);
    expect(stderrLines.join('')).toContain('KILL_REFUSED code=PID_RECYCLED');
  });

  it('says nothing about a member that is simply gone', async () => {
    // The root kill usually takes the tree with it. That is the ordinary case,
    // not a refusal, and it must not print one.
    tableSequence([[ROOT_ROW, MEMBER_ROW], [ROOT_ROW]]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf(RECORD));

    expect(taskkills().some((args) => args.includes(String(LIVE_MEMBER)))).toBe(false);
    expect(stderrLines.join('')).not.toContain('KILL_REFUSED');
  });

  it('sweeps the members on the earlier reading when the table will not answer twice', async () => {
    // A reading DID happen and it established these pids as descendants of a
    // process we proved ours. Refusing on the failure of a SECOND look would
    // throw that away and leave the workers this sweep exists to catch running
    // for good — the ones `/T` missed.
    tableSequence([[ROOT_ROW, MEMBER_ROW], [], []]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf(RECORD));

    expect(taskkills()).toContainEqual(['/F', '/PID', String(LIVE_MEMBER)]);
    expect(stderrLines.join('')).toContain('KILL_UNCONFIRMED code=TABLE_UNREADABLE');
  });

  it('kills the member the second reading still vouches for', async () => {
    tableSequence([
      [ROOT_ROW, MEMBER_ROW],
      [ROOT_ROW, MEMBER_ROW],
    ]);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), await proofOf(RECORD));

    expect(taskkills()).toContainEqual(['/F', '/PID', String(LIVE_MEMBER)]);
    expect(stderrLines.join('')).not.toContain('KILL_REFUSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('killPidTree — one reading held across a shutdown (#1046) @cap:installer-et-demarrer/moteur', () => {
  // `down` and `up`'s orphan cleanup now hand the SAME reading to each kill they
  // make. These cases are about what that reading may still vouch for after an
  // earlier kill of the same shutdown: see the three rules of `ProcessReading`.
  const ROOT_ROW: Row = { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' };
  const MEMBER_ROW: Row = { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' };
  const RECORD = { pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED };
  const SECOND = 999_002;
  const SECOND_ROW: Row = { pid: SECOND, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' };
  const SECOND_RECORD = { pid: SECOND, name: 'node.exe', startedAt: TICK_RECORDED };

  it('never vouches for a pid an earlier kill of the same shutdown signalled', async () => {
    // The member was killed with the first tree. Its number is free; the held
    // reading still lists the old row, and every later look times out. A later
    // kill aimed at that number must find nothing, not the old row.
    tableSequence([[ROOT_ROW, MEMBER_ROW], []]);
    const { reading } = await proofOf(RECORD);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), { recorded: RECORD, reading });
    const before = taskkills().length;
    await killPidTree(LIVE_MEMBER, new Set(), {
      recorded: { pid: LIVE_MEMBER, name: 'node.exe', startedAt: TICK_RECORDED },
      reading,
    });

    expect(taskkills().slice(before)).toEqual([]);
    // Gone, not unreadable: the reading answered, it just no longer lists it.
    expect(stderrLines.join('')).not.toContain('KILL_REFUSED code=TABLE_UNREADABLE');
  });

  it('judges the next root on a later reading that answered, not on the first', async () => {
    // The first kill's second look answers, and in it the SECOND root's number
    // now carries another generation: recycled meanwhile. The held reading is
    // that later one, so the second root is refused on it.
    tableSequence([
      [ROOT_ROW, MEMBER_ROW, SECOND_ROW],
      [MEMBER_ROW, { ...SECOND_ROW, ticks: TICK_OTHER }],
    ]);
    const { reading } = await proofOf(RECORD);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), { recorded: RECORD, reading });
    await killPidTree(SECOND, new Set(), { recorded: SECOND_RECORD, reading });

    expect(taskkills().some((args) => args.includes(String(SECOND)))).toBe(false);
    expect(stderrLines.join('')).toContain(`KILL_REFUSED code=PID_RECYCLED pid ${SECOND}`);
  });

  it('a reading emptied by its own strikes is still a reading that answered', async () => {
    // Every row it had was spent. That is "gone", never "the table did not
    // answer": the second would read as a refusal of a pid nothing refused.
    tableSequence([[ROOT_ROW], []]);
    const { reading } = await proofOf(RECORD);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), { recorded: RECORD, reading });
    const before = taskkills().length;
    await killPidTree(ROOT, new Set(), { recorded: RECORD, reading });

    expect(reading.answered).toBe(true);
    expect(taskkills().slice(before)).toEqual([]);
    expect(stderrLines.join('')).not.toContain('TABLE_UNREADABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('killPidTree — the table is read again only when a member is still alive (#1046) @cap:installer-et-demarrer/moteur', () => {
  // The root kill usually takes the whole tree with it, and a dead member has
  // nothing left to confirm. Liveness is asked without the table (signal 0); an
  // alive member still gets the full re-read and the identity check.
  const ROOT_ROW: Row = { pid: ROOT, ppid: 4, ticks: TICK_RECORDED, name: 'node.exe' };
  const MEMBER_ROW: Row = { pid: LIVE_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'node.exe' };
  /** A number no process carries: past every pid range Windows or Linux hands out. */
  const DEAD_MEMBER = 2_147_483_632;
  const DEAD_ROW: Row = { pid: DEAD_MEMBER, ppid: ROOT, ticks: TICK_RECORDED, name: 'conhost.exe' };
  const RECORD = { pid: ROOT, name: 'node.exe', startedAt: TICK_RECORDED };

  /** Process-table queries made AFTER the caller's own reading. */
  function rereads(callsBefore: number): number {
    return mockExeca.mock.calls.slice(callsBefore).filter((c) => c[0] === 'powershell').length;
  }

  it('reads nothing more when every member died with the root, and signals only the root', async () => {
    // Every later look would fail: a re-read would print KILL_UNCONFIRMED.
    tableSequence([[ROOT_ROW, DEAD_ROW], []]);
    const proof = await proofOf(RECORD);
    const before = mockExeca.mock.calls.length;

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), proof);

    expect(rereads(before)).toBe(0);
    expect(taskkills()).toEqual([['/T', '/F', '/PID', String(ROOT)]]);
    expect(stderrLines.join('')).not.toContain('KILL_');
  });

  it('re-reads and kills a member still alive that the second reading vouches for', async () => {
    tableSequence([
      [ROOT_ROW, MEMBER_ROW, DEAD_ROW],
      [ROOT_ROW, MEMBER_ROW],
    ]);
    const proof = await proofOf(RECORD);
    const before = mockExeca.mock.calls.length;

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), proof);

    expect(rereads(before)).toBe(1);
    expect(taskkills()).toEqual([
      ['/T', '/F', '/PID', String(ROOT)],
      ['/F', '/PID', String(LIVE_MEMBER)],
    ]);
    expect(stderrLines.join('')).not.toContain('KILL_');
  });

  it('refuses a member that is alive only because a stranger took its number', async () => {
    // Signal 0 says the number is alive; it does not say whose it is. The
    // re-read says: another executable, another generation. Refused.
    tableSequence([
      [ROOT_ROW, MEMBER_ROW],
      [{ ...MEMBER_ROW, ppid: 4, ticks: TICK_OTHER, name: 'chrome.exe' }],
    ]);
    const proof = await proofOf(RECORD);
    const before = mockExeca.mock.calls.length;

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), proof);

    expect(rereads(before)).toBe(1);
    expect(taskkills()).toEqual([['/T', '/F', '/PID', String(ROOT)]]);
    expect(stderrLines.join('')).toContain(`KILL_REFUSED code=BINARY_CHANGED pid ${LIVE_MEMBER}`);
  });

  it('sweeps an alive member on the earlier reading when the table will not answer, word for word', async () => {
    tableSequence([[ROOT_ROW, MEMBER_ROW, DEAD_ROW], [], []]);
    const proof = await proofOf(RECORD);

    // kill-by-pid: execa is mocked in this file, nothing is signalled.
    await killPidTree(ROOT, new Set(), proof);

    expect(taskkills()).toEqual([
      ['/T', '/F', '/PID', String(ROOT)],
      ['/F', '/PID', String(LIVE_MEMBER)],
    ]);
    // Only the kill lines: the reading's own warning about the timeout is
    // printed too, by `readProcessTableWin`, and is not this rule's.
    expect(stderrLines.filter((l) => l.startsWith('KILL_'))).toEqual([
      `KILL_UNCONFIRMED code=TABLE_UNREADABLE pid=${ROOT} the tree members are swept on the ` +
        'earlier reading: the table would not answer a second time\n',
    ]);
  });
});
