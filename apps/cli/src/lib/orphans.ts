// orphans.ts — who owns a Postgres process, and on which port it was OBSERVED.
//
// Both questions were answered by GUESSING until 2026-09-14, and the guess cost
// a live database:
//
//   · OWNERSHIP was decided by the embedded binary path (`@embedded-postgres`).
//     That path is inside node_modules, and two installs sharing one
//     node_modules — a worktree with junctions, the supported way to review a
//     branch on Windows — resolve to the SAME path. A second stack starting up
//     claimed the main install's postmaster (pid 41956) and killed it.
//   · The PORT was not measured at all: every pid found in the process table
//     was printed next to `config.ports.postgres`. Thirteen lines announced
//     :25450 for processes listening on :25444 or on nothing.
//
// Three passes of review then found three more ways to attribute a foreign
// cluster, each one a new spelling of the same mistake — the data dir as a
// substring, then as a path, then the `-D` argument, then `-c data_directory`.
// The pattern, not the spelling, is the defect: **a process table cannot say
// whose a cluster is.** So the question is turned around and the DATA DIRECTORY
// answers it — see `ownedPostgresPids`. The table only confirms.
//
// A port is printed only when a listener probe actually returned that pid.
//
// Pure functions over plain rows on purpose: the probe they serve cannot be run
// in a test without killing somebody's Postgres.

/** One `postgres.exe` as the process table reports it. */
export interface PostgresProcessRow {
  pid: number;
  ppid: number;
  commandLine: string;
  /**
   * When the process started, in epoch milliseconds — `CreationDate` from WMI.
   *
   * It is what tells one generation of a pid from the next (finding C4). A
   * foreign worker can outlive its postmaster and see that freed pid handed to
   * OURS; the rows then read as a family and the worker gets adopted, and
   * killed. A parent cannot start after its own child, so the dates settle it.
   * Optional in the type, required in practice: a row with no date is REFUSED,
   * never waved through — an unchecked link is how a recycled ppid adopts a
   * stranger.
   */
  startedAt?: number;
}

/** A candidate the probe refused, and why — never dropped in silence. */
export interface SkippedPostgres {
  pid: number;
  reason: string;
}

export interface PostgresOwnership {
  /** Processes provably belonging to this install's data dir. */
  owned: number[];
  /** Processes seen and deliberately left alone. */
  skipped: SkippedPostgres[];
}

/**
 * The probe's stdout, one process per line, turned into rows.
 *
 * The line is `pid|ppid|startedAt|commandLine`. The three numbers come FIRST
 * and are cut with `indexOf`, so the command line — the only field that can
 * itself carry a `|` — stays last and whole.
 *
 * It lives here, and not inside the probe, because nothing tested it: the probe
 * cannot run in a suite without killing somebody's database, and the parsing
 * went with it. A line that does not carry the three separators is dropped
 * rather than half-read — that is what turned a truncated line into a pid 999
 * classified as ours during the review of this PR.
 */
export function parseProcessRows(stdout: string): PostgresProcessRow[] {
  const rows: PostgresProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const first = line.indexOf('|');
    if (first < 0) continue;
    const second = line.indexOf('|', first + 1);
    if (second < 0) continue;
    const third = line.indexOf('|', second + 1);
    if (third < 0) continue;
    const pid = Number.parseInt(line.slice(0, first), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number.parseInt(line.slice(first + 1, second), 10);
    const startedAt = Number.parseInt(line.slice(second + 1, third), 10);
    rows.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      commandLine: line.slice(third + 1),
      ...(Number.isInteger(startedAt) && startedAt > 0 ? { startedAt } : {}),
    });
  }
  return rows;
}

/**
 * Did `parent` start strictly after `child`? Unknowable — and therefore false —
 * when either date is missing.
 */
function isPlausibleParent(parent: PostgresProcessRow, child: PostgresProcessRow): boolean {
  // Without both dates there is nothing to check, and an unchecked link is how
  // a recycled ppid adopts a stranger. No dates, no descent.
  if (parent.startedAt === undefined || child.startedAt === undefined) return false;
  return parent.startedAt <= child.startedAt;
}

/**
 * What `<dataDir>/postmaster.pid` claims: the pid on line 1, and the start time
 * PostgreSQL wrote on line 3 (epoch SECONDS).
 *
 * The lockfile is read by `postgres.ts`, which owns the disk; this module only
 * reasons about what it said.
 */
export interface LockfileClaim {
  pid: number;
  /** Line 3, epoch seconds. Null when the file is too short to carry it. */
  startedAtSeconds: number | null;
}

export interface OwnershipInput {
  /** The rows the process table gave, empty when it could not be read. */
  readonly rows: readonly PostgresProcessRow[];
  /** Whether the table could be READ at all. Without it, nothing is confirmed. */
  readonly tableRead: boolean;
  /** What our own data directory claims, or null when it claims nothing. */
  readonly claim: LockfileClaim | null;
}

/**
 * How far apart the lockfile's start time and the process's creation date may
 * be and still describe the same start.
 *
 * Line 3 is `MyStartTime`, set by `InitProcessGlobals` at the top of
 * `PostmasterMain` and only then written to the file — so it is the moment the
 * POSTMASTER started, not the moment the file was written. It therefore sits
 * milliseconds away from the process creation date the OS records, and the
 * window needs to cover clock resolution, nothing more.
 *
 * It was a minute, justified by "a slow disk". That justification was wrong —
 * the disk is not in the picture — and the window was wide enough to accept a
 * pid recycled around the recorded start, which is exactly what it exists to
 * refuse. Measured: a foreign process created 30 s after the claimed start was
 * accepted as ours.
 */
const START_TIME_TOLERANCE_MS = 2_000;

/**
 * Which Postgres processes this install owns.
 *
 * THE DATA DIRECTORY IS THE AUTHORITY. Everything else only confirms.
 *
 * Three passes of Codex review on this PR each found a way to attribute a
 * FOREIGN postmaster, and each fix closed one more spelling of the same
 * mistake: the embedded binary path, then our data dir as a substring of the
 * command line, then a path boundary, then the `-D` argument, then `-c
 * data_directory=`. The third pass named the real problem instead of the next
 * spelling, and it is this: **the process table cannot say whose a cluster is.**
 * A command line is not authoritative — `data_directory` in `postgresql.conf`
 * overrides `-D` and never appears on it — and a lockfile alone is not either,
 * since its pid can have been recycled onto somebody else's process.
 *
 * So the question is turned around. `<dataDir>/postmaster.pid` is written BY
 * the postmaster that holds THIS directory: that is true by construction, not
 * by resemblance. It names our pid. The process table is then asked to CONFIRM,
 * never to attribute:
 *
 *   · the pid is in the table, so it is a postgres process (the probe filters
 *     on the executable name) and it is alive;
 *   · its creation date matches the start time the postmaster itself wrote on
 *     line 3 of the lockfile. A recycled pid fails this and nothing else can —
 *     no name, no path, no ancestry would have caught it.
 *
 * Workers are then reached by ANCESTRY towards that one confirmed pid, never by
 * reading their command line. A `--forkchild="io_worker"` carries no data dir
 * at all (PostgreSQL 18, seen live 2026-08-21), and that is fine: it does not
 * need to say anything, it needs a parent we already trust.
 *
 * WHAT THIS GIVES UP, and it is a real loss: when the lockfile is GONE while a
 * postmaster lives on — the 2026-08-20 incident — nothing here attributes
 * anything. The old code guessed from the command line and could be right; it
 * could also kill a stranger, which it did on 2026-09-14. Refusing to guess
 * means `up` reports what it sees and stops instead of cleaning up. That is the
 * side this module falls on.
 */
export function ownedPostgresPids(input: OwnershipInput): PostgresOwnership {
  const owned: number[] = [];
  const skipped: SkippedPostgres[] = [];
  const claim = input.claim;

  if (claim === null) {
    for (const row of input.rows) {
      skipped.push({ pid: row.pid, reason: 'no postmaster.pid claims this data dir' });
    }
    return { owned, skipped };
  }

  const byPid = new Map<number, PostgresProcessRow>();
  for (const row of input.rows) byPid.set(row.pid, row);
  const postmaster = byPid.get(claim.pid);

  if (!input.tableRead) {
    // Nothing to confirm the claim with, so the claim stands alone — and a
    // claim alone is exactly what a stale lockfile on a recycled pid looks
    // like. Callers that CAN date the pid another way say so by handing a row
    // for it and `tableRead: true` (see `unconfirmedReading`); those that
    // cannot get nothing, which is the side this module falls on.
    for (const row of input.rows) {
      skipped.push({ pid: row.pid, reason: 'the process table could not be read' });
    }
    return { owned, skipped };
  }

  {
    if (postmaster === undefined) {
      // The lockfile names a pid that is not a live postgres process. Stale, or
      // recycled onto something else entirely — either way, not ours to touch.
      for (const row of input.rows) {
        skipped.push({ pid: row.pid, reason: `lockfile pid ${claim.pid} is not a live postgres` });
      }
      return { owned, skipped };
    }
    if (!startMatchesClaim(postmaster, claim)) {
      for (const row of input.rows) {
        skipped.push({
          pid: row.pid,
          reason: `pid ${claim.pid} started at ${String(postmaster.startedAt)}, lockfile says ${String(claim.startedAtSeconds)}`,
        });
      }
      return { owned, skipped };
    }
  }

  owned.push(claim.pid);

  for (const row of input.rows) {
    if (row.pid === claim.pid) continue;
    if (descendsFrom(row, claim.pid, byPid)) owned.push(row.pid);
    else skipped.push({ pid: row.pid, reason: `ancestry=${row.ppid} does not reach ${claim.pid}` });
  }

  return { owned, skipped };
}

/**
 * Does this process's creation date agree with the start time the postmaster
 * wrote into the lockfile?
 *
 * A missing date is a NO, not a yes. It used to be a yes — "unknowable,
 * therefore accepted" — and that made the one check capable of catching a
 * recycled pid switch itself off exactly when the inputs were incomplete: an
 * older lockfile with no line 3, or a WMI row with no `CreationDate`. Measured
 * both ways, a foreign postmaster came back owned. Uncertainty must stop an
 * automatic kill, never license one (invariant #4).
 */
function startMatchesClaim(process: PostgresProcessRow, claim: LockfileClaim): boolean {
  if (process.startedAt === undefined || claim.startedAtSeconds === null) return false;
  return Math.abs(process.startedAt - claim.startedAtSeconds * 1000) <= START_TIME_TOLERANCE_MS;
}

/** Does `row` descend from `ancestorPid`, walking up inside the table? */
function descendsFrom(
  row: PostgresProcessRow,
  ancestorPid: number,
  byPid: ReadonlyMap<number, PostgresProcessRow>,
): boolean {
  const seen = new Set<number>([row.pid]);
  let child: PostgresProcessRow = row;
  let cursor = byPid.get(row.ppid);
  while (cursor && !seen.has(cursor.pid)) {
    // A parent that started AFTER its child is a RECYCLED pid, not a parent —
    // and a link with no dates cannot be checked at all, so it is not a link.
    if (!isPlausibleParent(cursor, child)) return false;
    if (cursor.pid === ancestorPid) return true;
    seen.add(cursor.pid);
    child = cursor;
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

/**
 * The port a pid was OBSERVED listening on, or null.
 *
 * `listeners` holds what a listener probe returned for the configured ports —
 * a measurement. A pid absent from it listens on none of our ports, and gets no
 * port in the report rather than the config value.
 */
export function measuredPort(
  pid: number,
  listeners: readonly { port: number; pid: number }[],
): number | null {
  return listeners.find((l) => l.pid === pid)?.port ?? null;
}

/**
 * Report the refusals with a machine code, never a sentence (invariant #2):
 * the line is for whoever debugs a boot, and it has to survive translation.
 */
export function formatForeignSkip(entry: SkippedPostgres): string {
  return `ORPHAN_PROBE_FOREIGN_POSTGRES_SKIPPED pid=${entry.pid} reason=${entry.reason}`;
}
