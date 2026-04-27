// postgres.ts — start/stop embedded Postgres using the embedded-postgres package

import { PG_DATA_DIR } from './config.ts';

export interface PostgresHandle {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start an embedded Postgres instance.
 *
 * Uses the `embedded-postgres` npm package which downloads a real PG binary
 * on first run (~50-80 MB). Data is persisted at ~/.nodalai/pg-data/.
 *
 * pgvector: if CREATE EXTENSION vector fails we log a yellow warning and
 * continue in keyword-only memory mode (no halt).
 */
export async function startEmbeddedPostgres(
  dataDir: string = PG_DATA_DIR,
  port: number = 54329,
): Promise<PostgresHandle> {
  // Dynamic import — embedded-postgres is a runtime-only dep
  const EmbeddedPostgres = (await import('embedded-postgres')).default;

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'nodalai',
    password: 'nodalai',
    port,
    persistent: true,
  });

  await pg.initialise();
  await pg.start();

  // Create the database if it doesn't exist
  try {
    await pg.createDatabase('nodalai');
  } catch {
    // Database already exists — ignore
  }

  const url = `postgresql://nodalai:nodalai@localhost:${port}/nodalai`;

  // Try to enable pgvector; if unavailable, warn and continue
  try {
    const client = pg.getPgClient('nodalai');
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.end();
  } catch {
    process.stderr.write(
      '\x1b[33m[nodalai] pgvector extension not available — semantic memory search disabled.\n' +
        '  To enable: install pgvector (Mac: brew install pgvector; Win: see README).\n' +
        '  Continuing in keyword-only memory mode.\x1b[0m\n',
    );
  }

  return {
    url,
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
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { runMigrations: migrate } = await import('@nodalai/db/migrate');
  await migrate(databaseUrl);
}
