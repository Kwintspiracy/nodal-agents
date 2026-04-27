// migrate.ts — run Drizzle migrations against a connection string
// Only @nodalai/db may import drizzle-orm directly (architecture rule).

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

/**
 * Apply all pending Drizzle migrations to the given database.
 * Uses the migration files bundled with @nodalai/db at packages/db/migrations/.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  // Resolve migrations folder relative to this file
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

  await migrate(db, { migrationsFolder });
  await sql.end();
}
