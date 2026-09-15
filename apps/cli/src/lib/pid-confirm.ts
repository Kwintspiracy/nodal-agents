// pid-confirm.ts — a recorded pid is a number, not an identity.
//
// #98 established that for POSTGRES and stopped there: the data directory
// answers, the process table only confirms, and nothing is killed that a fresh
// reading has not confirmed. Everything else in the CLI still killed on the
// faith of a number written to `~/.nodalai/pids/processes.json` minutes or days
// earlier (issue #100) —
//
//   · `up`'s non-postgres loop force-killed a whole TREE (`taskkill /T`) whose
//     root was classified ours by the PORT it was configured to use;
//   · `sweepRecordedChildren` compared creation ticks, which catches a recycled
//     pid but says nothing about what the pid now IS: a foreign postmaster that
//     inherited the number keeps its own tick, and nothing asked what it was;
//   · `down` read a pid off `postmaster.pid` and could print
//     `Stop-Process -Id <pid> -Force` next to it, handing the user the kill it
//     had declined to make itself.
//
// This is the same class of defect as #97, which cost a live database on
// 2026-09-14. The rules below are the one place that decides, so a refusal
// cannot be walked around by whichever caller happens to be in a hurry.
//
// Pure functions over plain rows, like `orphans.ts` and for the same reason:
// the probes they serve cannot be run in a suite without killing somebody's
// processes.

/** What we wrote down when we still knew the process was ours. */
export interface RecordedProcess {
  pid: number;
  /** Creation tick, as `processSnapshotWin` reports it. */
  startedAt?: string;
  /** Executable name, e.g. node.exe. Absent in pid files written before #100. */
  name?: string;
}

/** What the process table says about that number RIGHT NOW. */
export interface LiveProcess {
  pid: number;
  startedAt: string;
  name: string;
}

/** Why a kill was refused — a code, never a sentence (invariant #2). */
export type RefusalCode =
  | 'PID_GONE'
  | 'FOREIGN_POSTGRES'
  | 'BINARY_CHANGED'
  | 'PID_RECYCLED'
  | 'IDENTITY_NOT_RECORDED'
  | 'TABLE_UNREADABLE';

export type Confirmation =
  | { killable: true }
  | { killable: false; code: RefusalCode; detail: string };

const OK: Confirmation = { killable: true };

/** The postgres executable, by the name the process table reports. */
export const POSTGRES_EXE = 'postgres.exe';

export interface ConfirmInput {
  /** What we recorded. */
  readonly recorded: RecordedProcess;
  /** What the table says now — undefined when the pid is not in it. */
  readonly live: LiveProcess | undefined;
  /**
   * Whether a process TABLE was read at all. False means the OS declined to
   * answer, which is not the same fact as "the process is gone" — telling the
   * two apart is the whole discipline #98 arrived at (invariant #4).
   */
  readonly tableRead: boolean;
  /** Postgres pids `postgresProcessesForDataDir` confirmed as ours. */
  readonly ownedPostgresPids: ReadonlySet<number>;
}

/**
 * May this recorded pid be signalled?
 *
 * The order of the checks is the argument:
 *
 *  1. **No table read** — nothing confirms anything, so nothing is killed. This
 *     is a behaviour CHANGE and a deliberate one: the old code killed on the
 *     record alone in exactly this case, which is the case where the record is
 *     least worth trusting.
 *  2. **Not in the table** — the process is gone. Not a refusal to report, just
 *     nothing left to do.
 *  3. **It is a postgres the data dir does not claim.** Checked BEFORE the
 *     record is consulted, because this is the one that cost a database: `up`
 *     reached these pids through the non-postgres path, where `ownedPgPids` was
 *     never asked at all.
 *  4. **The binary changed.** Windows hands a freed number to the next process
 *     that asks; node.exe becoming postgres.exe — or chrome.exe — is that
 *     number having been reused.
 *  5. **The creation tick changed.** Same number, different generation.
 *  6. **We recorded neither tick nor name.** Then there is nothing to compare
 *     and the number proves nothing. Refused, and said out loud, rather than
 *     killed on faith.
 */
export function confirmRecordedPid(input: ConfirmInput): Confirmation {
  const { recorded, live, tableRead, ownedPostgresPids } = input;

  if (!tableRead) {
    return {
      killable: false,
      code: 'TABLE_UNREADABLE',
      detail: `pid ${recorded.pid} could not be confirmed: the process table did not answer`,
    };
  }
  if (live === undefined) {
    return {
      killable: false,
      code: 'PID_GONE',
      detail: `pid ${recorded.pid} is no longer running`,
    };
  }
  if (isPostgresExe(live.name) && !ownedPostgresPids.has(live.pid)) {
    return {
      killable: false,
      code: 'FOREIGN_POSTGRES',
      detail: `pid ${recorded.pid} is a ${live.name} that our data dir does not claim`,
    };
  }
  if (recorded.name !== undefined && !sameExe(recorded.name, live.name)) {
    return {
      killable: false,
      code: 'BINARY_CHANGED',
      detail: `pid ${recorded.pid} was recorded as ${recorded.name} and now runs ${live.name}`,
    };
  }
  if (recorded.startedAt !== undefined && recorded.startedAt !== live.startedAt) {
    return {
      killable: false,
      code: 'PID_RECYCLED',
      detail: `pid ${recorded.pid} started at ${live.startedAt}, recorded at ${recorded.startedAt}`,
    };
  }
  if (recorded.startedAt === undefined && recorded.name === undefined) {
    return {
      killable: false,
      code: 'IDENTITY_NOT_RECORDED',
      detail: `pid ${recorded.pid} was recorded as a bare number: nothing identifies it now`,
    };
  }
  return OK;
}

/** Case-insensitive: Windows reports node.exe, NODE.EXE and Node.exe alike. */
function sameExe(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isPostgresExe(name: string): boolean {
  return sameExe(name, POSTGRES_EXE);
}

export interface TreeVerdict {
  /** The root, judged by `confirmRecordedPid`. */
  root: Confirmation;
  /**
   * Whether `taskkill /T` may be used. `/T` kills a whole tree without ever
   * saying what was in it — so it is allowed only over a tree whose root is
   * PROVEN ours and which contains no postgres we cannot claim. A service in
   * that tree can perfectly well have started a cluster against another data
   * directory (issue #100, path 1).
   */
  treeKillAllowed: boolean;
  /** Members that must not be signalled, whatever happens to the root. */
  foreign: LiveProcess[];
  /** Members that may be signalled one by one when /T is refused. */
  killable: LiveProcess[];
}

/**
 * Judge a whole tree before anything in it is signalled.
 *
 * Members are NOT held to the recorded-identity rule — they were observed as
 * descendants of the root in the SAME reading that is about to be acted on, so
 * their parentage is current, not remembered. What they are held to is the
 * postgres rule: a cluster we cannot claim is never killed, not as a root and
 * not as somebody's child.
 */
export function confirmTree(
  root: ConfirmInput,
  members: readonly LiveProcess[],
  ownedPostgresPids: ReadonlySet<number>,
): TreeVerdict {
  const verdict = confirmRecordedPid(root);
  const foreign: LiveProcess[] = [];
  const killable: LiveProcess[] = [];
  for (const member of members) {
    if (isPostgresExe(member.name) && !ownedPostgresPids.has(member.pid)) foreign.push(member);
    else killable.push(member);
  }
  return {
    root: verdict,
    treeKillAllowed: verdict.killable && foreign.length === 0,
    foreign,
    killable,
  };
}

/**
 * The line printed when a kill is refused. A code and the pid, so the reason is
 * greppable in launcher.log and survives translation.
 */
export function formatRefusal(refusal: Extract<Confirmation, { killable: false }>): string {
  return `KILL_REFUSED code=${refusal.code} ${refusal.detail}`;
}
