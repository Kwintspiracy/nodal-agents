// process-table-available.ts — can this machine enumerate its own processes?
//
// Asked once, at module load, and reused by every test that needs a real
// process table.
//
// ## Why a test would ever be allowed to skip
//
// GitHub's Windows runner cannot read its process table. Not slowly — at all:
// both PowerShell paths (Get-CimInstance over CIM/WSMan, Get-WmiObject over
// DCOM) time out, at 6s and again at 20s, serialised, with no contention left
// to blame. Four CI attempts on 2026-08-21 established this, each one first
// blaming something the evidence then ruled out.
//
// That is a fact about the machine, not about the code. A test that asserts an
// OS capability the OS declines to provide reports nothing useful about the
// product — it only turns the suite permanently red, and a permanently red
// suite is one nobody reads.
//
// ## What keeps this honest
//
// This is a skip, not a silencing. Three things hold:
//
//   1. The LOGIC is still tested everywhere, unconditionally. `walkDescendants`
//      is a pure function over a snapshot — tree walking, root exclusion, cycle
//      safety — and those cases never skip. Only the cases that need the real
//      OS table are conditional.
//   2. The PRODUCT is unaffected. `processSnapshotWin` already degrades on
//      exactly this failure: it reports the reason on stderr and the caller
//      falls back to a plain tree kill, with the recorded-tree sweep at the
//      next start as the backstop. A machine that cannot enumerate processes is
//      a supported machine, not a broken one.
//   3. The COVERAGE moved, it did not vanish. This behaviour is verified by
//      hand on a real Windows machine — see docs/protocole-install-upgrade.md,
//      step 3 — because the case that matters (a genuine Ctrl+C to a console
//      process group) cannot be produced by any automated harness anyway. It
//      was verified that way on 2026-08-21: 4 stranded processes recorded,
//      4 swept, 0 survivors.
//
// The skip announces itself in the run output. A silent skip would be the thing
// to fear here; this one says what it could not do and why.

import { processSnapshotWin, lastSnapshotFailure } from '../lib/processes.ts';

export interface ProcessTableProbe {
  /** True when the OS answered with a usable process table. */
  available: boolean;
  /** Why it did not, for the skip message. Empty when available. */
  reason: string;
}

async function probe(): Promise<ProcessTableProbe> {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'not Windows — these cases are Windows-only' };
  }
  const snapshot = await processSnapshotWin();
  if (snapshot.size > 0) return { available: true, reason: '' };
  return {
    available: false,
    reason: lastSnapshotFailure ?? 'the process table came back empty, with no reason reported',
  };
}

export const processTable: ProcessTableProbe = await probe();

if (!processTable.available && process.platform === 'win32') {
  console.warn(
    `\n[tests] SKIPPING the OS-level process-tree cases: ${processTable.reason}\n` +
      '        The tree-walking logic still runs (walkDescendants); what is skipped\n' +
      '        is only what needs a real process table. See this file for why, and\n' +
      '        docs/protocole-install-upgrade.md step 3 for the manual coverage.\n',
  );
}
