// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PG_DATA_DIR } from './config.ts';

/**
 * The postmaster PID recorded in `<dataDir>/postmaster.pid`, or null when the
 * lockfile is absent or unreadable. Says nothing about whether that process is
 * still alive — see `livePostmasterPid` for that.
 */
export function readPostmasterPid(dataDir: string = PG_DATA_DIR): number | null {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const firstLine = readFileSync(pidFile, 'utf-8').split('\n')[0]?.trim() ?? '';
    const pid = Number.parseInt(firstLine, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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
 * Windows-only (WMI). Returns [] elsewhere and on any failure: this is an extra
 * chance to notice, never a reason to fail a boot.
 */
export async function postgresPidsForDataDir(dataDir: string = PG_DATA_DIR): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const { execa } = await import('execa');
  try {
    const { stdout } = await execa(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // CommandLine is where the -D <dataDir> argument lives. Matching on it
        // is what ties a bare `postgres.exe` to OUR cluster rather than to some
        // other Postgres the user runs.
        'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\'" | ' +
          'Select-Object -ExpandProperty ProcessId,CommandLine | Out-Null; ' +
          'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\'" | ' +
          'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
      ],
      { reject: false, timeout: 10_000 },
    );
    // TWO ways to recognise one of ours, and the second is the one that
    // matters in practice.
    //
    //   · the data dir — present only on the POSTMASTER's command line
    //     (`postgres.exe -D <dataDir>`).
    //   · the embedded binary path — present on EVERY process of the cluster.
    //
    // Matching the data dir alone missed the case that actually blocks a boot.
    // Seen live on 2026-08-21: the survivor was
    //     postgres.exe --forkchild="io_worker" 5856
    // an internal I/O worker of PostgreSQL 18. No data dir on its command line,
    // so the probe returned [] and `up` died on the opaque FATAL with no orphan
    // reported — the very failure this function was written to prevent.
    //
    // The binary path cannot be spoofed by accident: it points inside this
    // install's node_modules, so anything running from it is ours by
    // construction, postmaster or worker.
    const dataNeedle = dataDir.toLowerCase().replace(/\\/g, '/');
    const binNeedle = '@embedded-postgres';
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const pid = Number.parseInt(line.slice(0, tab), 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const cmd = line
        .slice(tab + 1)
        .toLowerCase()
        .replace(/\\/g, '/');
      if (cmd.includes(dataNeedle) || cmd.includes(binNeedle)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
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
 * dir. Uses `pg_ctl stop -m fast` via the embedded-postgres package so that
 * the postmaster releases its Windows shared-memory section cleanly. A bare
 * `taskkill /F` skips that release and leaves the SHM segment orphaned —
 * the next `pg_ctl start` then dies with FATAL "pre-existing shared memory
 * block is still in use" until the machine reboots.
 *
 * Returns true if a stop was attempted (and didn't throw), false if there
 * was nothing to stop or the stop failed. The caller can then fall back to
 * a hard taskkill, accepting the SHM-leak risk over leaving the port held.
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

export async function stopOrphanPostgres(dataDir: string = PG_DATA_DIR): Promise<boolean> {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return false;
  try {
    const EmbeddedPostgres = (await import('embedded-postgres')).default;
    // Re-create a handle pointing at the existing data dir. The constructor
    // doesn't connect; .stop() reads postmaster.pid and signals graceful
    // shutdown via pg_ctl, which releases the Windows shared-memory section
    // before the postmaster exits.
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: PG_USER,
      // stop() only reads postmaster.pid and signals pg_ctl — it never
      // authenticates, so the value here is irrelevant.
      password: LEGACY_PG_PASSWORD,
      port: 25432, // unused for stop()
      persistent: true,
      onError: () => {},
      onLog: () => {},
    });
    await pg.stop();
    return true;
  } catch {
    return false;
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
