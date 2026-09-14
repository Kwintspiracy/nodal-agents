// orphans.ts — who owns a Postgres process, and on which port it was OBSERVED.
//
// Both questions were answered by guessing until 2026-09-14, and the guess cost
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
// The rules here replace both guesses. Ownership is the DATA DIR and nothing
// else; a worker without a data dir on its command line is ours only when its
// ancestry reaches a postmaster that is ours. A port is printed only when a
// listener probe actually returned that pid.
//
// Pure functions over plain rows on purpose: the probe they serve cannot be run
// in a test without killing somebody's Postgres.

/** One `postgres.exe` as the process table reports it. */
export interface PostgresProcessRow {
  pid: number;
  ppid: number;
  commandLine: string;
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

/** Lower-case, forward slashes — command lines and data dirs mix both. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/');
}

/**
 * Split the `postgres.exe` rows into the ones this install owns and the ones it
 * must not touch.
 *
 * A row is OURS when its command line carries our data dir (that is the
 * postmaster, `postgres.exe -D <dataDir>`), or when walking up `ppid` reaches
 * such a postmaster. The second case is what `--forkchild="io_worker"` needs:
 * PostgreSQL 18 spawns workers whose command line holds no data dir at all
 * (seen live 2026-08-21), and their parent is the postmaster.
 *
 * Everything else is skipped — including a sibling install's postmaster and its
 * workers, which is precisely what the binary-path test used to swallow.
 */
export function classifyPostgresProcesses(
  rows: readonly PostgresProcessRow[],
  dataDir: string,
): PostgresOwnership {
  const dataNeedle = normalise(dataDir);
  const byPid = new Map<number, PostgresProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  const isOurPostmaster = (row: PostgresProcessRow): boolean =>
    normalise(row.commandLine).includes(dataNeedle);

  const owned: number[] = [];
  const skipped: SkippedPostgres[] = [];

  for (const row of rows) {
    if (isOurPostmaster(row)) {
      owned.push(row.pid);
      continue;
    }
    // Walk up the parent chain, staying inside the postgres.exe rows. The seen
    // set keeps a recycled or corrupt ppid from looping forever.
    const seen = new Set<number>([row.pid]);
    let cursor = byPid.get(row.ppid);
    let ancestor: PostgresProcessRow | null = null;
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      if (isOurPostmaster(cursor)) {
        ancestor = cursor;
        break;
      }
      cursor = byPid.get(cursor.ppid);
    }
    if (ancestor) owned.push(row.pid);
    else
      skipped.push({
        pid: row.pid,
        reason: `ancestry=${row.ppid} reaches no postmaster for ${dataDir}`,
      });
  }

  return { owned, skipped };
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
