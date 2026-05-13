// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PG_DATA_DIR } from './config.ts';

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
  let pid: number;
  try {
    const firstLine = readFileSync(pidFile, 'utf-8').split('\n')[0]?.trim() ?? '';
    pid = Number.parseInt(firstLine, 10);
    if (!Number.isInteger(pid) || pid <= 0) return;
  } catch {
    return;
  }
  // process.kill(pid, 0) is the canonical "is this PID alive?" probe — sends
  // no signal, throws ESRCH if the process doesn't exist.
  try {
    process.kill(pid, 0);
    // PID is alive — Postgres really is running, do NOT touch the lockfile.
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return;
  }
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
      user: 'nodalai',
      password: 'nodalai',
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

  // Postgres refuses to run as root for safety. In Docker the container
  // usually runs as root, so we ask embedded-postgres to spin up a
  // dedicated `postgres` system user on first boot. process.getuid is
  // undefined on Windows — guard accordingly.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'nodalai',
    password: 'nodalai',
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
    await pg.createDatabase('nodalai');
  } catch {
    // Database already exists — ignore
  }

  const url = `postgresql://nodalai:nodalai@localhost:${port}/nodalai`;

  // Try to enable pgvector; if unavailable, warn and continue
  let vectorAvailable = false;
  try {
    const client = pg.getPgClient('nodalai');
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
