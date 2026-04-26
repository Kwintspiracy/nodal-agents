// createClient — factory for a Drizzle + postgres connection pool
// This is the ONLY file in the monorepo that imports 'postgres'

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.ts';

export type DbClient = ReturnType<typeof createClient>;

/**
 * Shared Drizzle DB instance type.
 * Both the postgres-js and pglite drivers extend PgDatabase, so this type
 * is satisfied by either. Use this when accepting a Drizzle instance as a
 * parameter without caring about the underlying driver.
 */
export type AnyDrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface CreateClientOptions {
  /** Max connections in the pool. Default: 10 */
  max?: number;
}

/**
 * Creates a Drizzle ORM client backed by a postgres.js connection pool.
 *
 * @param connectionString - PostgreSQL connection string (postgres://...)
 * @param options - Optional pool configuration
 * @returns Object with `db` (Drizzle instance) and `close()` for graceful shutdown
 */
export function createClient(connectionString: string, options: CreateClientOptions = {}) {
  const pool = postgres(connectionString, {
    max: options.max ?? 10,
    // Fail fast on connection issues rather than hanging
    connect_timeout: 10,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    /** Gracefully close all pool connections */
    close: () => pool.end(),
  };
}

export type { schema };
