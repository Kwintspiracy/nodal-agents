// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PG_DATA_DIR } from './config.ts';

export interface PostgresHandle {
  url: string;
  /** True when pgvector extension was successfully loaded; false when we fell back to keyword-only memory. */
  vectorAvailable: boolean;
  stop: () => Promise<void>;
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

  // Capture errors that embedded-postgres surfaces via its onError callback —
  // some failures throw nothing useful (e.g. "Error: undefined") because the
  // real diagnostic only flows through this stream.
  const capturedErrors: string[] = [];

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'nodalai',
    password: 'nodalai',
    port,
    persistent: true,
    // Force UTF-8 encoding regardless of host locale — needed on Windows
    // where the default LC_* (e.g. English_United States.1252) breaks on
    // any non-Western char (emojis, accented chars beyond Latin-1, etc.).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      capturedErrors.push(msg);
    },
    // Keep onLog quiet by default; if user wants to see, set NODALAI_PG_LOG=1
    onLog:
      process.env['NODALAI_PG_LOG'] === '1'
        ? (m) => process.stdout.write('[pg] ' + m + '\n')
        : () => {},
  });

  // Skip initdb if a cluster already exists in the data dir. This handles
  // both "previous successful run" and "previous partial-failure leftover"
  // — the latter would otherwise crash with "directory exists but is not empty".
  const alreadyInitialised = existsSync(join(dataDir, 'PG_VERSION'));
  try {
    if (!alreadyInitialised) {
      await pg.initialise();
    }
    await pg.start();
  } catch (err) {
    const errMsg = err instanceof Error && err.message ? err.message : String(err);
    const detail = capturedErrors.length
      ? `\n  Captured Postgres errors:\n    ${capturedErrors.join('\n    ')}`
      : '';
    throw new Error(
      `Postgres ${alreadyInitialised ? 'start' : 'init+start'} failed: ${errMsg}${detail}`,
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
 * Delegates to @nodalai/db/migrate to respect the architecture rule:
 * only packages/db may import drizzle-orm or postgres directly.
 *
 * @param patchVectorAsText when true, rewrite `vector(N)` columns to `text`
 *   in migration SQL — used when pgvector wasn't loaded (keyword-only mode).
 */
export async function runMigrations(
  databaseUrl: string,
  opts: { patchVectorAsText?: boolean } = {},
): Promise<void> {
  const { runMigrations: migrate } = await import('@nodalai/db/migrate');
  await migrate(databaseUrl, opts);
}
