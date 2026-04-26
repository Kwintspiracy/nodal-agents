// withTransaction — helper for running work inside a DB transaction

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './schema/index.ts';

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;
type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * Runs `fn` inside a Postgres transaction.
 * Automatically COMMIT on success, ROLLBACK on throw.
 *
 * @example
 * await withTransaction(db, async (tx) => {
 *   await tx.insert(users).values({ email: 'a@b.com' });
 *   await tx.insert(entities).values({ user_id: ... });
 * });
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
