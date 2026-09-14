// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PG_DATA_DIR } from './config.ts';
import {
  formatForeignSkip,
  ownedPostgresPids,
  parseProcessRows,
  type LockfileClaim,
} from './orphans.ts';

/** What a reading of the process table found — and whether it could read. */
export interface ProcessTableReading {
  /** False when the table could not be read at all: conclude NOTHING from `owned`. */
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
 * The start time is what makes a RECYCLED pid detectable. A lockfile survives a
 * crash, the OS hands its pid to somebody else, and nothing about that new
 * process — not its name, not its path, not its ancestry — says it is not ours.
 * Its creation date does: it will not match the moment the postmaster recorded.
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

/** Two spellings of one directory — case and separators, as everywhere else. */
function sameDirectory(a: string, b: string): boolean {
  const clean = (v: string): string => v.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return clean(a) === clean(b);
}

/**
 * The PID of a postmaster that is BOTH recorded for this data dir AND still
 * alive, or null.
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
  if (pid === null) return null;
  // process.kill(pid, 0) is the canonical "is this PID alive?" probe — sends
  // no signal, throws ESRCH if the process doesn't exist.
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM = alive but owned by another user: still a live process.
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? null : pid;
  }
}

/**
 * Postgres processes whose command line points at `dataDir`, found by asking
 * the OS rather than by reading our own bookkeeping.
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
  // and the claim is still CONFIRMED — by asking the OS for that one pid's
  // start time (`processStartedAtMs`) instead of listing every process. Where
  // even that is unavailable, nothing is owned. `read: false` tells the caller
  // no ancestry was walked, so no workers are in the answer.
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
 * What we own when the process table could not be read: the pid our own data
 * directory claims, if it is still alive, and nothing else.
 *
 * `up` used to reach for `livePostmasterPid()` itself in this case — a second,
 * looser answer to the one question this module exists to answer, and it
 * accepted pids the confirmed set had refused (pass-4 finding R1). One source,
 * here, so a refusal cannot be walked around. No workers are claimed: with no
 * table there is no ancestry to walk.
 */
export function unconfirmedReading(dataDir: string): ProcessTableReading {
  const claim = readPostmasterClaim(dataDir);
  if (claim === null || livePostmasterPid(dataDir) !== claim.pid) return { read: false, owned: [] };
  // Liveness is NOT confirmation. Without a start time, a stale lockfile whose
  // pid the OS has since handed to a stranger reads exactly like our own
  // postmaster — the hole pass 4 closed for the Windows path and pass 5 found
  // still open here. So the same question is asked of the OS about THIS pid
  // alone, which needs no process table.
  const startedAt = processStartedAtMs(claim.pid);
  if (startedAt === null) {
    process.stderr.write(
      `ORPHAN_PROBE_NO_START_TIME pid=${claim.pid} platform=${process.platform}\n`,
    );
    return { read: false, owned: [] };
  }
  const { owned } = ownedPostgresPids({
    rows: [{ pid: claim.pid, ppid: 0, commandLine: '', startedAt }],
    tableRead: true,
    claim,
  });
  return { read: false, owned };
}

/**
 * When this pid started, in epoch milliseconds, asked of the OS about ONE pid —
 * no process table needed. Null when this platform cannot say.
 *
 * Linux keeps it in `/proc/<pid>/stat` field 22, in clock ticks since boot, and
 * `/proc/stat`'s `btime` gives the boot instant. Both are plain reads. Where
 * neither is available the answer is null, and the caller refuses rather than
 * attributing a pid it cannot date.
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
    // `/proc/uptime`, NOT `/proc/stat`'s `btime`. `btime` is derived from
    // `getboottime64`, which Linux SHIFTS when the wall clock is set: a clock
    // that moves after the postmaster started moves our computed start with
    // it, and can land it back on a stranger's — a coincidence the two-second
    // window would then wave through. Anchoring on the CURRENT clock instead
    // means a clock jump pushes the estimate AWAY from the recorded value, so
    // the answer is a refusal. Wrong in the safe direction is the requirement.
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
export async function startEmbeddedPostgres(
  dataDir: string = PG_DATA_DIR,
  port: number = 25432,
  password: string = LEGACY_PG_PASSWORD,
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
    await pg.start();
  } catch (err) {
    const errMsg = err instanceof Error && err.message ? err.message : String(err);
    // The actionable failure is usually in the FATAL log lines, not the
    // thrown error (embedded-postgres v18.3.0-beta.17 throws undefined).
    const fatalLines = capturedLogs.filter((l) => /\b(FATAL|PANIC|ERROR)\b/.test(l));
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
    const sharedMemHint = capturedLogs.some((l) => /pre-existing shared memory block/.test(l))
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
      await pg.stop();
    },
  };
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
