// migrate.ts — run Drizzle migrations against a connection string
// Only @nodal-agents/db may import drizzle-orm directly (architecture rule).

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

export interface RunMigrationsOptions {
  /**
   * If true, rewrite `vector(N)` column types to `text` before applying the
   * migrations. Used when pgvector extension isn't available — semantic
   * memory search falls back to keyword mode (handled in @nodal-agents/memory).
   * Default: false.
   */
  patchVectorAsText?: boolean;
}

/**
 * Apply all pending Drizzle migrations to the given database.
 * Uses the migration files bundled with @nodal-agents/db at packages/db/migrations/.
 */
export async function runMigrations(
  connectionString: string,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  // Two layouts to support:
  //   - Monorepo dev: this file lives at packages/db/src/migrate.ts, so
  //     migrations are one level up at packages/db/migrations/.
  //   - Bundled pack: this code is inlined into runner.js / cli.js at the
  //     pack root, and migrations are copied to pack/migrations/ as a sibling.
  // Probe sibling first (cheaper, more common in shipped artifacts), then
  // fall back to the dev layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'migrations');
  const sourceFolder = existsSync(sibling) ? sibling : join(here, '../migrations');
  const migrationsFolder = opts.patchVectorAsText
    ? patchMigrationsForNoVector(sourceFolder)
    : sourceFolder;

  await migrate(db, { migrationsFolder });
  await sql.end();
}

/**
 * Copy the migrations folder to a tmp dir and rewrite any `vector(N)` column
 * type to `text`. Returns the path to the patched folder. Drizzle's migrator
 * needs the meta/ subfolder + journal file too — we copy those verbatim so the
 * migration tracking works.
 */
function patchMigrationsForNoVector(sourceFolder: string): string {
  const tmpFolder = mkdtempSync(join(tmpdir(), 'nodalai-migrations-'));
  const metaDir = join(tmpFolder, 'meta');
  mkdirSync(metaDir, { recursive: true });

  for (const entry of readdirSync(sourceFolder, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'meta') {
      for (const metaFile of readdirSync(join(sourceFolder, 'meta'))) {
        const content = readFileSync(join(sourceFolder, 'meta', metaFile), 'utf8');
        writeFileSync(join(metaDir, metaFile), content);
      }
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      const content = readFileSync(join(sourceFolder, entry.name), 'utf8');
      // Replace `vector(NNN)` with `text` — preserves column declarations
      // without requiring the pgvector extension.
      const patched = content.replace(/\bvector\(\d+\)/g, 'text');
      writeFileSync(join(tmpFolder, entry.name), patched);
    }
  }

  return tmpFolder;
}
