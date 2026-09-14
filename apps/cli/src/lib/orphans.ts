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
  /**
   * When the process started, in epoch milliseconds — `CreationDate` from WMI.
   *
   * It is what tells one generation of a pid from the next (finding C4). A
   * foreign worker can outlive its postmaster and see that freed pid handed to
   * OURS; the rows then read as a family and the worker gets adopted, and
   * killed. A parent cannot start after its own child, so the dates settle it.
   * Optional: when either date is missing, the check simply does not apply.
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

/** Lower-case, forward slashes, no trailing separator — every form is seen. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The command line split into arguments, double quotes removed.
 *
 * Whitespace is space, tab, CR or LF. The tab matters: the path-boundary rule
 * this replaces accepted only a space, so `-D C:/…/pg-data<TAB>-p 5432` stopped
 * being recognised as OUR postmaster (finding C5) — the same bug with the sign
 * flipped, and `up` then refuses to start or leaves its own orphan behind.
 */
function tokenise(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
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
function startsAfter(parent: PostgresProcessRow, child: PostgresProcessRow): boolean {
  return (
    parent.startedAt !== undefined &&
    child.startedAt !== undefined &&
    parent.startedAt > child.startedAt
  );
}

/**
 * The directory `-D` names on this command line, or null when it names none.
 *
 * Why the ARGUMENT, and not the line. Searching the LINE for our path — with
 * `includes`, then with a path boundary — kept claiming clusters that are not
 * ours, and the Codex review of this PR measured four of them on this very
 * function (findings C1 and C2):
 *
 *     -D "…/pg-data/other"                        a sub-directory
 *     -D "…/pg-data backup"                       a name that starts the same
 *     -D "…/pg-data/../foreign"                   a climb back out
 *     -D C:/foreign -c external_pid_file="…/pg-data/foreign.pid"
 *                                                 a cluster elsewhere whose PID
 *                                                 file happens to sit with us
 *
 * Every one of them came back `owned`, and `up` kills what it owns. No boundary
 * rule closes that, because the path was never the thing to look at: the
 * ARGUMENT is. Read `-D` (or `--pgdata`), compare the whole value, and a
 * directory that is not exactly ours is not ours.
 *
 * A value that leans on `..` to name our OWN directory is not resolved here and
 * reads as foreign. That errs towards leaving a process alone, which is the
 * side this module must always fall on.
 */
export function dataDirArgument(commandLine: string): string | null {
  const tokens = tokenise(commandLine);
  let fromOption: string | null = null;
  let fromSetting: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // `-c name=value`, and the `--name=value` spelling of the same setting.
    const setting =
      token === '-c' ? tokens[i + 1] : token.startsWith('--') ? token.slice(2) : undefined;
    const named = setting?.match(/^data[_-]directory=(.*)$/);
    if (named?.[1] !== undefined) {
      fromSetting = named[1];
      continue;
    }
    // The LAST `-D` wins, never the first: getopt overwrites as it goes, so
    // that is the one the server actually runs against (finding R1).
    if (token === '-D' || token === '--pgdata') {
      const next = tokens[i + 1];
      if (next !== undefined) fromOption = next;
      continue;
    }
    if (token.startsWith('--pgdata=')) fromOption = token.slice('--pgdata='.length);
    else if (token.startsWith('-D') && token.length > 2) fromOption = token.slice(2);
  }
  // `data_directory` is a SETTING, and a setting beats the command-line
  // default: when both are present the server uses this one (finding R2).
  return fromSetting ?? fromOption;
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

  const isOurPostmaster = (row: PostgresProcessRow): boolean => {
    if (dataNeedle === '') return false;
    const declared = dataDirArgument(row.commandLine);
    return declared !== null && normalise(declared) === dataNeedle;
  };

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
    let child: PostgresProcessRow = row;
    let cursor = byPid.get(row.ppid);
    let ancestor: PostgresProcessRow | null = null;
    while (cursor && !seen.has(cursor.pid)) {
      // A parent that started AFTER its child is a RECYCLED pid, not a parent
      // (finding C4). The chain stops there rather than adopting a stranger.
      if (startsAfter(cursor, child)) break;
      seen.add(cursor.pid);
      if (isOurPostmaster(cursor)) {
        ancestor = cursor;
        break;
      }
      child = cursor;
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
