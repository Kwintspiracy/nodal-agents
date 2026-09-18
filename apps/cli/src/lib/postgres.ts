// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PG_DATA_DIR } from './config.ts';
import { applyPostgresLoggingConfig, postgresLogDirFor } from './pg-logging.ts';
import {
  formatForeignSkip,
  ownedPostgresPids,
  parseProcessRows,
  type LockfileClaim,
} from './orphans.ts';

/** What a reading found — and whether a process TABLE was behind it. */
export interface ProcessTableReading {
  /**
   * False when no process table was read: on a host that has none, or after a
   * probe that failed. `owned` can still be non-empty — the single-pid checks
   * confirm the lockfile's claim without a table — but no ancestry was walked,
   * so no workers are in the answer.
   */
  read: boolean;
  owned: number[];
}

/**
 * The postmaster PID recorded in `<dataDir>/postmaster.pid`, or null when the
 * lockfile is absent, unreadable, or written for ANOTHER data directory. Says
 * nothing about whether that process is still alive — see `livePostmasterPid`.
 *
 * Line 2 of the lockfile is the data directory the postmaster was started with.
 * Checking it costs nothing and catches a lockfile that was copied, restored
 * from a backup, or left behind by a different cluster — a file whose pid we
 * would otherwise hand straight to `SIGKILL` (finding C3). A lockfile too old
 * to carry the line is accepted as before, so nothing that worked stops.
 */
export function readPostmasterPid(dataDir: string = PG_DATA_DIR): number | null {
  return readPostmasterClaim(dataDir)?.pid ?? null;
}

/**
 * Everything `<dataDir>/postmaster.pid` claims: the pid on line 1 and the start
 * time on line 3 (epoch SECONDS, written by the postmaster itself).
 *
 * The start time is what makes an ordinary RECYCLED pid detectable. A lockfile
 * survives a crash, the OS hands its pid to somebody else, and nothing about
 * that new process — not its name, not its path, not its ancestry — says it is
 * not ours. Its creation date usually does.
 *
 * USUALLY, not always, and the residue is worth stating exactly. The check is a
 * WINDOW, currently two seconds, so it accepts anything born within it — a pid
 * recycled that fast needs no clock trickery at all. Wind the wall clock back
 * BEFORE the stranger is created and the window is not even needed: it is born
 * at an instant that reads the same as the recorded one, and no stored
 * timestamp separates the two generations.
 *
 * On Linux `postmasterHoldsDataDir` closes both, with a proof that has no clock
 * in it. On Windows there is no equivalent cheap reading, so there the residue
 * stands. Named rather than papered over.
 */
export function readPostmasterClaim(dataDir: string = PG_DATA_DIR): LockfileClaim | null {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const lines = readFileSync(pidFile, 'utf-8').split('\n');
    const pid = Number.parseInt(lines[0]?.trim() ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const recorded = lines[1]?.trim();
    if (recorded !== undefined && recorded !== '' && !sameDirectory(recorded, dataDir)) {
      process.stderr.write(
        `POSTMASTER_PID_FOREIGN_DATA_DIR pid=${pid} recorded=${recorded} expected=${dataDir}\n`,
      );
      return null;
    }
    const seconds = Number.parseInt(lines[2]?.trim() ?? '', 10);
    return { pid, startedAtSeconds: Number.isInteger(seconds) && seconds > 0 ? seconds : null };
  } catch {
    return null;
  }
}

/**
 * Two spellings of ONE directory.
 *
 * Case is folded on Windows and NOWHERE ELSE. Folding it everywhere made
 * `/srv/PG/data` and `/srv/pg/data` the same directory, and on a
 * case-sensitive filesystem those are two different clusters — so a pid
 * recycled from one to the other passed the very check that exists to tell
 * them apart (pass-8 finding R1). The filesystem's own rule is the only rule.
 */
function sameDirectory(a: string, b: string): boolean {
  const clean = (v: string): string =>
    process.platform === 'win32'
      ? v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : // A backslash is a legal character in a POSIX filename, so turning it
        // into a separator made `/srv/pg\data` and `/srv/pg/data` — two real,
        // different directories — compare equal (pass-9 finding R2). Only the
        // trailing separator is dropped.
        v.replace(/\/+$/, '');
  return clean(a) === clean(b);
}

/**
 * The PID recorded for this data dir, when it is not known to have exited —
 * otherwise null. Not "alive": `isPidRunning` leans conservative on any probe
 * error that is not ESRCH, and this name inherits that limit rather than
 * hiding it.
 *
 * This is the only reliable way to see a dead-but-not-gone Postgres. Detection
 * by listening port cannot: a postmaster that crashed its startup (or is mid
 * shutdown) holds no socket, so `netstat` shows nothing — while its Win32
 * shared-memory section, which is keyed to the DATA DIR and not the port, is
 * still attached. That is exactly the orphan whose next `up` dies with FATAL
 * "pre-existing shared memory block is still in use", and exactly the one a
 * port scan reports as absent (field-confirmed 2026-08-20).
 */
export function livePostmasterPid(dataDir: string = PG_DATA_DIR): number | null {
  const pid = readPostmasterPid(dataDir);
  return pid !== null && isPidRunning(pid) ? pid : null;
}

/**
 * Has this pid NOT been established as gone?
 *
 * The honest reading of the name, and the difference matters. `process.kill(pid,
 * 0)` sends no signal and throws ESRCH when nothing holds that number, which is
 * the only conclusive answer it gives. EPERM means alive and owned by another
 * user. Any OTHER error establishes nothing, and this returns true there —
 * "not proven gone", which is the conservative side for a lockfile we must not
 * delete out from under a live server.
 *
 * It is not a licence to kill anything: every caller that acts on a pid still
 * has to get past the directory proof and the start-time match.
 *
 * Split out so a caller holding a pid can ask about THAT pid, instead of going
 * through `livePostmasterPid` and re-reading the lockfile underneath it.
 */
function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The Postgres processes this install owns, found by asking the OS rather than
 * by reading our own bookkeeping.
 *
 * The last resort, and it earned its place: on 2026-08-20 a postmaster survived
 * with NO listening socket and NO `postmaster.pid` — the lockfile had been
 * removed while the process lived on holding the shared-memory block. Detection
 * by port could not see it (nothing to see) and detection by data dir could not
 * either (nothing to read), so `up` failed on the opaque FATAL with no orphan
 * reported. Both earlier probes rely on state the crash can destroy; this one
 * relies on the process table, which it cannot.
 *
 * Windows-only (WMI). Everywhere else, and on any failure, it says so with
 * `read: false` rather than an empty list: "I could not look" and "there is
 * nothing there" are different facts, and only one of them licenses a kill.
 *
 * It ATTRIBUTES nothing. The rows it reads only CONFIRM what our own data
 * directory already claims — see `ownedPostgresPids` for why the question runs
 * that way round. Nothing here is decided from a command line: three passes of
 * review found three different spellings of our path on a foreign cluster's
 * command line, and on 2026-09-14 one of them cost a live database.
 */
export async function postgresProcessesForDataDir(
  dataDir: string = PG_DATA_DIR,
): Promise<ProcessTableReading> {
  // Not Windows: there is no table to read. The data directory still answers,
  // and the claim is still CONFIRMED — by asking the OS about that ONE pid:
  // which directory it runs out of, and when it started. Where either is
  // unanswerable, nothing is owned. `read: false` tells the caller no ancestry
  // was walked, so no workers are in the answer.
  if (process.platform !== 'win32') return unconfirmedReading(dataDir);
  const { execa } = await import('execa');
  try {
    const { stdout, stderr, exitCode } = await execa(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // `CreationDate` is the load-bearing field: it tells one generation of
        // a pid from the next, which is the only thing that catches a pid the
        // OS recycled onto a stranger. It goes BEFORE the command line, the one
        // field that may itself carry a `|`. The command line is kept for the
        // log line that says what was left alone — never to decide ownership.
        'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\'" | ' +
          // `[datetime]'…Z'` parses as LOCAL time, so the epoch itself landed on
          // the wrong side of the offset: measured here, eight hours out
          // (finding R4). `Get-Date … | ToUniversalTime` gives a Utc-kind
          // epoch, and the millisecond value then matches the real instant.
          'ForEach-Object { $ms = if ($_.CreationDate) ' +
          "{ [int64]($_.CreationDate.ToUniversalTime() - (Get-Date '1970-01-01T00:00:00Z')" +
          '.ToUniversalTime()).TotalMilliseconds } else { 0 }; ' +
          '"$($_.ProcessId)|$($_.ParentProcessId)|$ms|$($_.CommandLine)" }',
      ],
      { reject: false, timeout: 10_000 },
    );
    if (exitCode !== 0) {
      // The probe could not ANSWER. That is not the same fact as "no Postgres
      // is running", and telling the two apart is the whole point: a boot that
      // reasons about a process table it never read is guessing (finding C6,
      // invariant #4).
      process.stderr.write(
        `ORPHAN_PROBE_UNREADABLE exit=${String(exitCode)} stderr=${stderr.trim().slice(0, 200)}\n`,
      );
      return unconfirmedReading(dataDir);
    }
    const { owned, skipped } = ownedPostgresPids({
      rows: parseProcessRows(stdout),
      tableRead: true,
      // The data directory answers; this table only confirms.
      claim: readPostmasterClaim(dataDir),
    });
    // Loud, not silent: a candidate left alone is reported with a code.
    for (const entry of skipped) process.stderr.write(`${formatForeignSkip(entry)}\n`);
    return { read: true, owned };
  } catch (err) {
    process.stderr.write(
      `ORPHAN_PROBE_UNREADABLE error=${err instanceof Error ? err.message : String(err)}\n`,
    );
    return unconfirmedReading(dataDir);
  }
}

/**
 * What we own when the process table could not be read.
 *
 * NOT "the pid our data directory claims, if it is alive" — liveness is the
 * cheapest of the three things asked here, and the summary used to stop at it
 * (pass-11 finding R2). The pid has to be claimed by our lockfile, not known to
 * be gone, still running OUT of our data directory, and started when the
 * lockfile says. The last two are refusals when unanswerable; the liveness
 * probe is the one that leans the other way, because its only conclusive answer
 * is ESRCH (see `isPidRunning`). Every refusal writes a code — two of these
 * returns were silent until pass 12, and a refusal nobody can debug is barely
 * better than a wrong answer.
 *
 * `up` used to reach for `livePostmasterPid()` itself in this case — a second,
 * looser answer to the one question this module exists to answer, and it
 * accepted pids the confirmed set had refused (pass-4 finding R1). One source,
 * here, so a refusal cannot be walked around. No workers are claimed: with no
 * table there is no ancestry to walk.
 */
export function unconfirmedReading(dataDir: string): ProcessTableReading {
  const claim = readPostmasterClaim(dataDir);
  if (claim === null) {
    // Silent until pass 12: a refusal with no code is a refusal nobody can
    // debug, and the summary above promised one for every condition.
    process.stderr.write(`ORPHAN_PROBE_NO_CLAIM dataDir=${dataDir}\n`);
    return { read: false, owned: [] };
  }
  // Ask about THE PID WE READ, not about whatever the lockfile says a moment
  // later. `livePostmasterPid` re-reads the file, so a lockfile that vanished
  // or changed pid between the two reads produced "this pid is not alive" for a
  // process that had never been probed at all (pass-13 finding R1). The refusal
  // was safe; the diagnostic accused a death nobody had established.
  if (!isPidRunning(claim.pid)) {
    process.stderr.write(`ORPHAN_PROBE_CLAIMED_PID_NOT_ALIVE pid=${claim.pid}\n`);
    return { read: false, owned: [] };
  }
  // Liveness is NOT confirmation. A stale lockfile whose pid the OS has since
  // handed to a stranger reads exactly like our own postmaster — the hole pass
  // 4 closed for the Windows path and pass 5 found still open here. So the OS
  // is asked about THIS pid alone, which needs no process table, and TWO proofs
  // must hold.
  //
  // The start time catches an ordinary recycled pid. The working directory
  // catches what a clock comparison cannot, and that is more than a wound-back
  // clock: the time check is a WINDOW, so a pid reused inside it passes on its
  // own (see `readPostmasterClaim` for both shapes of that residue).
  const holdsDataDir = postmasterHoldsDataDir(claim.pid, dataDir);
  if (holdsDataDir !== true) {
    process.stderr.write(
      `ORPHAN_PROBE_NOT_IN_DATA_DIR pid=${claim.pid} holds=${String(holdsDataDir)}\n`,
    );
    return { read: false, owned: [] };
  }
  const startedAt = processStartedAtMs(claim.pid);
  if (startedAt === null) {
    process.stderr.write(
      `ORPHAN_PROBE_NO_START_TIME pid=${claim.pid} platform=${process.platform}\n`,
    );
    return { read: false, owned: [] };
  }
  const { owned, skipped } = ownedPostgresPids({
    rows: [{ pid: claim.pid, ppid: 0, commandLine: '', startedAt }],
    tableRead: true,
    claim,
  });
  // The last refusal — a lockfile with no start time on line 3, or a start
  // time that disagrees — happened INSIDE the classifier, and its reason was
  // being dropped here (pass-12 finding R2).
  for (const entry of skipped) process.stderr.write(`${formatForeignSkip(entry)}\n`);
  return { read: false, owned };
}

/**
 * Does this process hold OUR data directory as its working directory?
 *
 * A clock-free proof, and the reason it exists: no comparison of wall-clock
 * times survives the wall clock being wound back, so a start time alone cannot
 * settle a recycled pid. PostgreSQL's postmaster `chdir()`s into its data
 * directory at startup and stays there, so `/proc/<pid>/cwd` — a symlink the
 * KERNEL maintains, not a string the process chose — points at it for as long
 * as it lives.
 *
 * This is not the command line wearing a different hat. A command line is what
 * a process SAYS; this is what the kernel knows it HAS. A stranger would have
 * to be running out of our data directory to fake it.
 *
 * Null where the platform or permissions make it unanswerable, and the caller
 * treats that as "not proven" rather than as a yes.
 */
function postmasterHoldsDataDir(pid: number, dataDir: string): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    return sameDirectory(realpathSync(`/proc/${pid}/cwd`), realpathSync(dataDir));
  } catch {
    return null;
  }
}

/**
 * When this pid started, in epoch milliseconds, asked of the OS about ONE pid —
 * no process table needed. Null when this platform cannot say.
 *
 * Linux keeps it in `/proc/<pid>/stat` field 22, in clock ticks since boot;
 * `/proc/uptime` turns that into an instant. Where neither is available the
 * answer is null, and the caller refuses rather than attributing a pid it
 * cannot date.
 *
 * It is NOT proof on its own — see the rollback counter-example inside — and
 * the caller pairs it with `postmasterHoldsDataDir`.
 */
export function processStartedAtMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Field 2 is the executable name in parentheses and may itself contain
    // spaces or parentheses; everything after the LAST ')' is unambiguous.
    // Counting from there, `starttime` (field 22) is index 19.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticksSinceBoot = Number.parseInt(after[19] ?? '', 10);
    if (!Number.isFinite(ticksSinceBoot)) return null;
    // `/proc/uptime`, not `/proc/stat`'s `btime`: `btime` comes from
    // `getboottime64`, which Linux shifts when the wall clock is set, so the
    // same reading gives different answers across a clock change.
    //
    // Anchoring on the current clock does NOT make this rollback-proof, and
    // the comment here used to claim it did. Worked counter-example: postmaster
    // at B+1000, its pid recycled at B+2000, clock then wound back 1000 s — at
    // uptime 3000 the arithmetic lands exactly on B+1000, the value sitting in
    // the stale lockfile. No wall-clock comparison survives a wall-clock
    // rollback, because both sides move together. That is why
    // `postmasterHoldsDataDir` exists: a second proof with no clock in it.
    const uptimeSeconds = Number.parseFloat(
      readFileSync('/proc/uptime', 'utf-8').split(' ')[0] ?? '',
    );
    if (!Number.isFinite(uptimeSeconds)) return null;
    // USER_HZ is 100 on every Linux this runs on; a process cannot read it, and
    // `getconf CLK_TCK` would mean spawning a shell. If it were anything else,
    // the elapsed time comes out scaled, the comparison misses, and the pid is
    // refused — again the safe direction, never a false match.
    const elapsedSeconds = uptimeSeconds - ticksSinceBoot / 100;
    return Date.now() - elapsedSeconds * 1000;
  } catch {
    return null;
  }
}

/**
 * Remove a stale postmaster.pid file when the recorded PID is no longer
 * alive. Postgres refuses to start when the lockfile exists, even if the
 * owning process is dead — common after an unclean shutdown on Windows.
 *
 * Safe: only deletes the file when we can prove the recorded PID is not a
 * running process. If the PID is alive (or we can't check), we leave the
 * lockfile alone — tearing it down for a live Postgres would be a disaster.
 */
function clearStalePostmasterPid(dataDir: string): void {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  if (readPostmasterPid(dataDir) === null) return;
  // Alive (or unprovable) — Postgres really is running, do NOT touch the lockfile.
  if (livePostmasterPid(dataDir) !== null) return;
  try {
    unlinkSync(pidFile);
  } catch {
    /* best-effort */
  }
}

export interface PostgresHandle {
  url: string;
  /** True when pgvector extension was successfully loaded; false when we fell back to keyword-only memory. */
  vectorAvailable: boolean;
  /**
   * Move the role to a new password on this running cluster (SECRET-003).
   * Returns true on success. See the implementation for the required ordering:
   * the caller persists the new value BEFORE calling, and reverts on false.
   */
  rotatePassword: (newPassword: string) => Promise<boolean>;
  stop: () => Promise<void>;
}

/**
 * Gracefully stop a Postgres instance whose `postmaster.pid` is in our data
 * dir, by running `pg_ctl stop -m fast` against it. The postmaster then
 * releases its Windows shared-memory section cleanly; a bare `taskkill /F`
 * skips that release and leaves the SHM segment orphaned, and the next
 * `pg_ctl start` dies with FATAL "pre-existing shared memory block is still in
 * use" until the machine reboots.
 *
 * It used to construct an `EmbeddedPostgres` handle and call `.stop()` on it,
 * and the comment above this one said that reads `postmaster.pid` and signals
 * pg_ctl. It does not. Read in the installed package
 * (`embedded-postgres@18.3.0-beta.17`, `dist/index.js`): `stop()` opens with
 * `if (!this.process) return;`, and a handle that never started a cluster has
 * no `process`. So the call returned at once, this function returned `true`,
 * and NOTHING had been signalled — while its caller went on to `SIGKILL` the
 * postmaster, which is exactly the SHM leak the graceful stop exists to avoid
 * (finding R3). `pg_ctl` is invoked here directly instead, and the return value
 * now reports what actually happened.
 */
/**
 * The password every install used before SECRET-003 (audit 2026-08-07): the role
 * and the password were both the literal `nodalai`, identical everywhere, on a
 * predictable port. Kept as the fallback for clusters initialised before the
 * per-install password existed — `rotatePostgresPassword` replaces it on boot.
 */
export const LEGACY_PG_PASSWORD = 'nodalai';

/** Postgres role name. Unchanged: rotating the role would orphan existing data. */
export const PG_USER = 'nodalai';

/** Database name. Same value as the role, historically. */
export const PG_DATABASE = 'nodalai';

/**
 * Connection URL for the embedded cluster.
 *
 * The password is percent-encoded: a minted one is base64url and safe today, but
 * a hand-edited config.json could contain `@` or `:` and silently produce a URL
 * pointing at the wrong host.
 */
export function buildPgUrl(port: number, password: string): string {
  return `postgresql://${PG_USER}:${encodeURIComponent(password)}@localhost:${port}/${PG_DATABASE}`;
}

/**
 * Escape a password for use as a Postgres string literal.
 *
 * ALTER USER does not accept a bind parameter for the password, so the value has
 * to be inlined. Doubling single quotes is the standard escape; the minted value
 * is base64url and contains none, but a hand-edited config.json might.
 */
function quotePgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function stopOrphanPostgres(
  decidedPid: number,
  dataDir: string = PG_DATA_DIR,
): Promise<boolean> {
  // `pg_ctl stop` re-reads `postmaster.pid` and signals WHATEVER pid it finds
  // there — it does not check line 2, and it knows nothing of what we decided.
  // So the lockfile pid has to BE the pid we settled on; otherwise every guard
  // in this file is bypassed by the stop itself, and a foreign postmaster named
  // by a stale lockfile gets shut down (pass-3 finding R2). When they differ we
  // do not call it at all: the caller stops the pid it decided, by signal.
  const claim = readPostmasterClaim(dataDir);
  if (claim === null || claim.pid !== decidedPid) {
    process.stderr.write(
      `PG_CTL_SKIPPED_LOCKFILE_MISMATCH decided=${decidedPid} lockfile=${String(claim?.pid ?? null)}\n`,
    );
    return false;
  }
  // `pg_ctl` refuses to run as root, and this CLI supports being run as root
  // (the start path creates a dedicated account for the server). Calling it
  // there fails with exit 1 before any signal is sent, so we do not pretend
  // (pass-3 finding R4).
  const asRoot =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
  if (asRoot) {
    process.stderr.write('PG_CTL_SKIPPED_ROOT — pg_ctl refuses to run as root\n');
    return false;
  }
  try {
    const binary = await resolvePgCtl();
    if (binary === null) {
      process.stderr.write(`PG_CTL_NOT_FOUND dataDir=${dataDir}\n`);
      return false;
    }
    const { execa } = await import('execa');
    // `-w` waits for the shutdown to complete: returning before the postmaster
    // is gone would hand the caller a live process it then hard-kills.
    const { exitCode, stderr } = await execa(
      binary,
      ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30'],
      { reject: false, timeout: 40_000 },
    );
    if (exitCode !== 0) {
      process.stderr.write(
        `PG_CTL_STOP_FAILED exit=${String(exitCode)} stderr=${stderr.trim().slice(0, 200)}\n`,
      );
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(
      `PG_CTL_STOP_FAILED error=${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * The absolute path of the `pg_ctl` that ships with the embedded cluster — the
 * same binary that started it.
 *
 * `embedded-postgres` exports only `./dist/index.js`, so its `binary.js` cannot
 * be reached by specifier. It is loaded by PATH instead, next to the entry
 * point we resolve through the package we already depend on; that module picks
 * the right `@embedded-postgres/<platform>` and hands back absolute paths.
 * Everything is checked rather than assumed: a layout that stops exposing
 * `pg_ctl` returns null here and the caller says so with a code.
 */
export async function resolvePgCtl(): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const { dirname } = await import('node:path');
    const require = createRequire(import.meta.url);
    const entry = require.resolve('embedded-postgres');
    const module = (await import(pathToFileURL(join(dirname(entry), 'binary.js')).href)) as {
      default?: () => Promise<{ pg_ctl?: string }>;
    };
    const binaries = await module.default?.();
    const pgCtl = binaries?.pg_ctl;
    return pgCtl !== undefined && existsSync(pgCtl) ? pgCtl : null;
  } catch {
    return null;
  }
}

/**
 * Start an embedded Postgres instance.
 *
 * Uses the `embedded-postgres` npm package which downloads a real PG binary
 * on first run (~50-80 MB). Data is persisted at ~/.nodalai/pg-data/.
 *
 * - On first boot: runs initdb with UTF-8 encoding (must override the
 *   Windows default WIN1252 locale, which can't represent emojis used in
 *   our seed/migration default values like entity icons).
 * - On subsequent boots: detects existing cluster (PG_VERSION file) and
 *   skips initdb, so a partial-failure leftover doesn't block the next run.
 *
 * pgvector: if CREATE EXTENSION vector fails we log a yellow warning and
 * continue in keyword-only memory mode (no halt).
 */
/**
 * How long a cluster may take to accept its first connection.
 *
 * Generous: a first boot on a cold Windows machine replays WAL, and the old
 * path had no budget at all — it waited on a stderr line forever.
 */
const READY_TIMEOUT_MS = 180_000;

/**
 * Start the cluster and wait until it ANSWERS, rather than until it says so.
 *
 * `embedded-postgres@18.3.0-beta.17` decides a cluster is up by watching the
 * postmaster's stderr for the literal line "database system is ready to accept
 * connections" (dist/index.js, the `start()` promise). That is fine while the
 * postmaster writes to stderr — and it stops being fine the moment
 * `logging_collector` is on, because the collector then owns that stream and
 * the parent process never sees another byte. The promise neither resolves nor
 * rejects: `nodal-agents up` hangs forever with a healthy Postgres behind it.
 *
 * This was NOT reasoned out. It was found by `postgres-logging.pg.test.ts`,
 * which timed out at 180s against a cluster whose log file was being written
 * the whole time — the log proved the cluster was up, the promise proved
 * nothing. Writing it down because the next person to touch the logging
 * settings will meet it again.
 *
 * So readiness is MEASURED instead: connect, run nothing, disconnect. That is
 * what the sentence in the log means anyway, and it is true regardless of where
 * the cluster writes. The package's own promise is still watched — it rejects
 * when the postmaster exits during startup, which is a failure this poll would
 * otherwise sit through until the deadline.
 */
/**
 * Is this connection error an AUTHENTICATION refusal rather than "not ready
 * yet"?
 *
 * The distinction is the whole of issue #114's third review finding. Once
 * `logging_collector` is on the package's own promise never settles, so the
 * `resolvedItself` branch below — the one that used to catch "the cluster is up
 * but the probe is refused" — never runs. A wrong password therefore looked
 * exactly like a cluster still starting: the poll retried it every 500ms for
 * 180 SECONDS and then threw a message about readiness, leaving a live
 * postmaster nobody had a handle on.
 *
 * SQLSTATE class 28 is `invalid_authorization_specification` — 28000, and 28P01
 * for a bad password. Those never become true by waiting. Nothing else is
 * treated as fatal: a class this poll does not recognise stays a retry, because
 * the cost of retrying a real startup error is one deadline, and the cost of
 * giving up on a cluster that WAS coming up is a failed boot.
 */
export function isPostgresAuthFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length === 5 && code.startsWith('28');
}

/**
 * Les lignes par lesquelles le POSTMASTER dit qu'il a renoncé au démarrage.
 *
 * Même argument que la classe 28 juste au-dessus, sur un autre cas : aucune de
 * ces conditions ne devient vraie en attendant. Le postmaster est déjà sorti
 * quand il les écrit, et la boucle d'attente ne fait plus que compter jusqu'à
 * 180 s au-dessus d'un cadavre.
 *
 * Mesuré le 18/09/2026 en reproduisant l'issue #130 : sous `pnpm test`
 * complet, le troisième démarrage de `postgres-auth-stop.pg.test.ts` écrivait
 * `FATAL: pre-existing shared memory block is still in use` À LA PREMIÈRE
 * SECONDE, puis le test attendait ses 120 s et mourait sur « Test timed out »
 * — sans un mot du message que le journal portait depuis le début. Le
 * diagnostic était déjà écrit dans ce fichier (`sharedMemHint`) ; il était
 * seulement injoignable.
 *
 * La liste est COURTE et littérale à dessein. Un `FATAL` quelconque ne veut pas
 * dire que le cluster est mort — une session refusée en écrit un pendant qu'il
 * tourne très bien — et traiter toute la catégorie comme fatale transformerait
 * un démarrage lent en démarrage raté, c'est-à-dire le défaut inverse.
 */
export const POSTMASTER_GAVE_UP: readonly RegExp[] = [
  // Windows : la section de mémoire partagée d'un postmaster tué sans ménage
  // est encore attachée. Elle est indexée par le DATA DIR, pas par le port.
  /pre-existing shared memory block is still in use/i,
  // Le port est pris, ou le système refuse de l'attribuer.
  /could not create any TCP\/IP sockets/i,
];

/**
 * La ligne par laquelle le postmaster a renoncé, ou `null`. Pure, pour être
 * éprouvée sans cluster.
 */
export function postmasterGaveUp(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (POSTMASTER_GAVE_UP.some((pattern) => pattern.test(line))) return line.trim();
  }
  return null;
}

/** Ce que l'attente de démarrage a besoin de savoir de son cluster. */
export interface StartWatchers {
  /** Ce que le postmaster a écrit jusqu'ici. Vide par défaut. */
  logs?: () => readonly string[];
  /**
   * Un arrêt GRACIEUX du cluster, s'il y en a un. Rend false quand il n'a pas
   * abouti, et l'appelant retombe alors sur celui du paquet.
   *
   * Il existe parce que `embedded-postgres@18.3.0-beta.17` arrête un cluster
   * sous Windows par `taskkill /pid … /f /t` (dist/index.js, `stop()`) — un
   * tir à balle réelle qui NE relâche PAS la section de mémoire partagée. Le
   * prochain démarrage sur ce data dir meurt alors sur le FATAL ci-dessus.
   * C'est le même raisonnement que `stopOrphanPostgres`, appliqué au cluster
   * qu'on tient soi-même.
   */
  gracefulStop?: () => Promise<boolean>;
}

/** Arrête, sans jamais coûter l'erreur qu'on est en train de rapporter. */
async function stopQuietly(
  pg: { stop?: () => Promise<void> },
  watchers: StartWatchers,
): Promise<void> {
  try {
    if (watchers.gracefulStop && (await watchers.gracefulStop())) return;
  } catch {
    /* on retombe sur l'arrêt du paquet */
  }
  try {
    await pg.stop?.();
  } catch {
    /* the failure being reported is the one worth reporting */
  }
}

export async function startAndWaitUntilReady(
  pg: {
    start: () => Promise<void>;
    stop?: () => Promise<void>;
    getPgClient: (database?: string) => { connect: () => Promise<void>; end: () => Promise<void> };
  },
  watchers: StartWatchers = {},
): Promise<void> {
  const readLogs = watchers.logs ?? ((): readonly string[] => []);
  let exitedEarly: unknown = null;
  let resolvedItself = false;
  // Attached SYNCHRONOUSLY, before any await: an unobserved rejection here
  // would take the whole CLI down through `unhandledRejection`.
  const started = pg.start().then(
    () => {
      resolvedItself = true;
    },
    (err: unknown) => {
      exitedEarly = err ?? new Error('the postmaster exited during startup');
    },
  );

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exitedEarly !== null) throw exitedEarly;
    // FAIL LOUD, IMMEDIATELY (invariant #4). Le postmaster a dit qu'il
    // renonçait ; le journal le porte déjà, et attendre ne le défera pas.
    const gaveUp = postmasterGaveUp(readLogs());
    if (gaveUp !== null) {
      await stopQuietly(pg, watchers);
      throw new Error(`Postgres gave up during startup: ${gaveUp}`);
    }
    // `postgres` always exists after initdb; `nodalai` may not yet.
    const probe = pg.getPgClient('postgres');
    try {
      await probe.connect();
      await probe.end();
      return;
    } catch (err) {
      await probe.end().catch(() => {});
      // FAIL LOUD, IMMEDIATELY (invariant #4). Waiting cannot fix a password.
      if (isPostgresAuthFailure(err)) {
        await stopQuietly(pg, watchers);
        const code = (err as { code?: string }).code;
        throw new Error(
          `Postgres refused the connection: authentication failed (SQLSTATE ${code}). ` +
            'The cluster started and was stopped again. The password the CLI holds does not ' +
            'match the one this data directory was initialised with.',
        );
      }
    }
    if (resolvedItself) {
      // The package saw its line, so the cluster is up even if this probe is
      // still being refused (a role or auth problem, not a readiness one).
      await started;
      return;
    }
    if (Date.now() > deadline) {
      // Same reason as the auth path: whatever we give up on, we do not leave a
      // postmaster running that no handle of ours can stop.
      await stopQuietly(pg, watchers);
      throw new Error(
        `Postgres did not accept a connection within ${READY_TIMEOUT_MS / 1000}s of starting`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The last lines the cluster wrote into its own log directory, newest file
 * first. Empty when there is nothing to read — this runs on the failure path
 * and must never replace the original error with a second one.
 */
function tailLogDirectory(logDirectory: string, lines = 40): string[] {
  try {
    const files = readdirSync(logDirectory)
      .map((name) => join(logDirectory, name))
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const newest = files[0];
    if (!newest) return [];
    return readFileSync(newest.path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-lines);
  } catch {
    return [];
  }
}

export async function startEmbeddedPostgres(
  dataDir: string = PG_DATA_DIR,
  port: number = 25432,
  password: string = LEGACY_PG_PASSWORD,
  // Derived from the data directory, one subdirectory per cluster: the file
  // name is a day and a day name is TRUNCATED when it comes round, so two
  // clusters sharing one directory would blank each other's crash history
  // (review pass 2 of #114). Still overridable, so a test can start a cluster
  // without writing into the user's own `~/.nodalai/logs/`.
  logDirectory: string = postgresLogDirFor(dataDir),
): Promise<PostgresHandle> {
  // Dynamic import — embedded-postgres is a runtime-only dep
  const EmbeddedPostgres = (await import('embedded-postgres')).default;

  // embedded-postgres@18.3.0-beta.17 sometimes rejects `pg.start()` with
  // literal `undefined` — the real diagnostic only flows through `onLog`
  // (e.g. "FATAL: pre-existing shared memory block is still in use" after a
  // crashed Windows postgres leaves a kernel object). Capture every log line
  // and pull out FATAL/PANIC/ERROR markers ourselves so the user sees the
  // actionable message instead of "Error: undefined".
  const capturedLogs: string[] = [];
  const capturedErrors: string[] = [];
  const verboseLog = process.env['NODALAI_PG_LOG'] === '1';

  // Postgres refuses to run as root for safety. When the CLI is launched
  // as root (e.g. inside a CI container, or by an init system that runs
  // services as root), we ask embedded-postgres to spin up a dedicated
  // `postgres` system user on first boot. process.getuid is undefined on
  // Windows — guard accordingly.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: PG_USER,
    // On FIRST boot this is what initdb sets the role's password to. On later
    // boots the cluster already exists and this value is only used to build
    // connection strings — which is why rotation has to go through ALTER USER.
    password,
    port,
    persistent: true,
    createPostgresUser: isRoot,
    // Force UTF-8 encoding regardless of host locale — needed on Windows
    // where the default LC_* (e.g. English_United States.1252) breaks on
    // any non-Western char (emojis, accented chars beyond Latin-1, etc.).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      capturedErrors.push(msg);
    },
    onLog: (m) => {
      capturedLogs.push(m);
      if (verboseLog) process.stdout.write('[pg] ' + m + '\n');
    },
  });

  // Skip initdb if a cluster already exists in the data dir. This handles
  // both "previous successful run" and "previous partial-failure leftover"
  // — the latter would otherwise crash with "directory exists but is not empty".
  const alreadyInitialised = existsSync(join(dataDir, 'PG_VERSION'));

  // Clear any stale postmaster.pid (the recorded PID is dead). Postgres won't
  // start while it's there, and the embedded-postgres package surfaces the
  // failure as a useless `Error: undefined` — see startup logs.
  if (alreadyInitialised) clearStalePostmasterPid(dataDir);
  try {
    if (!alreadyInitialised) {
      await pg.initialise();
    }
    // The cluster keeps its OWN log from here on (issue #111). Written after
    // initdb — the data directory does not exist before it — and before every
    // start, not once, so a cluster created by an older version gets it too.
    //
    // It is the last thing done before `start()` on purpose: a start that
    // crashes is exactly the start whose log is worth having, and until
    // 2026-09-15 that log did not exist. The only trace of two crashes that day
    // was the runner's side of the disconnect.
    applyPostgresLoggingConfig(dataDir, logDirectory);
    await startAndWaitUntilReady(pg, {
      logs: () => capturedLogs,
      gracefulStop: () => stopThisCluster(dataDir),
    });
  } catch (err) {
    const errMsg = err instanceof Error && err.message ? err.message : String(err);
    // The actionable failure is usually in the FATAL log lines, not the
    // thrown error (embedded-postgres v18.3.0-beta.17 throws undefined).
    //
    // TWO sources since #111, and both are needed. The collector owns stderr
    // once the cluster is up, so `capturedLogs` only ever holds what was
    // written before it took over — which is exactly where a data-directory or
    // shared-memory FATAL lands, so it is still the right place to look first.
    // Anything later is in the file, and the file is new.
    const fatalLines = [...capturedLogs, ...tailLogDirectory(logDirectory)].filter((l) =>
      /\b(FATAL|PANIC|ERROR)\b/.test(l),
    );
    const detail = [
      capturedErrors.length
        ? `Captured Postgres errors:\n    ${capturedErrors.join('\n    ')}`
        : null,
      fatalLines.length ? `Postgres log:\n    ${fatalLines.join('\n    ')}` : null,
    ]
      .filter(Boolean)
      .join('\n  ');

    // Hint for the common Windows-after-crash case so the user knows what to do
    // instead of seeing a bare FATAL line.
    const sharedMemHint = fatalLines.some((l) => /pre-existing shared memory block/.test(l))
      ? '\n  → A previous Postgres crashed without releasing its Windows shared-memory ' +
        'block. Reboot the machine to clear the orphan kernel object, then retry. ' +
        'No data is lost; pg-data is preserved.'
      : '';

    throw new Error(
      `Postgres ${alreadyInitialised ? 'start' : 'init+start'} failed: ${errMsg}` +
        (detail ? `\n  ${detail}` : '') +
        sharedMemHint,
    );
  }

  // Create the database if it doesn't exist
  try {
    await pg.createDatabase(PG_DATABASE);
  } catch {
    // Database already exists — ignore
  }

  const url = buildPgUrl(port, password);

  // Try to enable pgvector; if unavailable, warn and continue
  let vectorAvailable = false;
  try {
    const client = pg.getPgClient(PG_DATABASE);
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.end();
    vectorAvailable = true;
  } catch {
    process.stderr.write(
      '\x1b[33m[nodalai] pgvector extension not available — semantic memory search disabled.\n' +
        '  To enable: install pgvector (Mac: brew install pgvector; Win: see README).\n' +
        '  Continuing in keyword-only memory mode (vector columns rewritten to text).\x1b[0m\n',
    );
  }

  return {
    url,
    vectorAvailable,
    /**
     * Move the role to `newPassword` on this running cluster (SECRET-003).
     *
     * A cluster initialised before the per-install password exists still carries
     * the shipped default: initdb sets the password once, so the only way
     * forward is ALTER USER against the live server.
     *
     * ORDER MATTERS, and it is the CALLER's job: persist `newPassword` to
     * config.json BEFORE calling this, and revert if it returns false. The
     * reverse order leaves a window where the role has changed and nothing on
     * disk knows the new value — an install that cannot open its own database.
     * This way the worst case is a config naming a password the role does not
     * have yet, which the next boot simply retries.
     *
     * Uses embedded-postgres' own client rather than importing `pg` directly:
     * only packages/db may depend on a driver (dep-cruiser `only-db-imports-pg`).
     */
    rotatePassword: async (newPassword: string): Promise<boolean> => {
      const client = pg.getPgClient(PG_DATABASE);
      try {
        await client.connect();
        await client.query(`ALTER USER ${PG_USER} WITH PASSWORD ${quotePgLiteral(newPassword)}`);
        return true;
      } catch {
        return false;
      } finally {
        await client.end().catch(() => {});
      }
    },
    stop: async () => {
      // GRACIEUX D'ABORD. `embedded-postgres@18.3.0-beta.17` arrête un cluster
      // sous Windows par `taskkill /pid … /f /t` (dist/index.js, `stop()`) :
      // le postmaster ne relâche alors pas sa section de mémoire partagée,
      // indexée par le DATA DIR, et le démarrage SUIVANT sur ce dossier meurt
      // sur « pre-existing shared memory block is still in use ». Ce fichier
      // écrivait déjà tout cela à propos de `stopOrphanPostgres` ; le cluster
      // qu'on tient soi-même passait pourtant encore par le tir à balle
      // réelle. Mesuré le 18/09/2026 en reproduisant l'issue #130.
      if (await stopThisCluster(dataDir)) return;
      await pg.stop();
    },
  };
}

/**
 * Arrête le cluster de CE data dir par `pg_ctl stop -m fast`, le seul arrêt qui
 * relâche la mémoire partagée. Rend false quand il n'a pas abouti — l'appelant
 * retombe alors sur l'arrêt du paquet, et le refus a déjà écrit son code.
 */
async function stopThisCluster(dataDir: string): Promise<boolean> {
  const claim = readPostmasterClaim(dataDir);
  if (claim === null) {
    // Aucun postmaster ne réclame ce dossier : il n'y a rien à arrêter
    // gracieusement, et `pg_ctl` n'aurait rien à signaler.
    return false;
  }
  return stopOrphanPostgres(claim.pid, dataDir);
}

// ─── Drizzle migrations ───────────────────────────────────────────────────────

/**
 * Run Drizzle migrations against the given database URL.
 * Delegates to @nodal-agents/db/migrate to respect the architecture rule:
 * only packages/db may import drizzle-orm or postgres directly.
 *
 * @param patchVectorAsText when true, rewrite `vector(N)` columns to `text`
 *   in migration SQL — used when pgvector wasn't loaded (keyword-only mode).
 */
export async function runMigrations(
  databaseUrl: string,
  opts: { patchVectorAsText?: boolean } = {},
): Promise<void> {
  const { runMigrations: migrate } = await import('@nodal-agents/db/migrate');
  await migrate(databaseUrl, opts);
}
