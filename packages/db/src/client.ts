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
    // R2 (audit2 concurrency review): bound the two ways a query on this pool
    // can hang indefinitely with no client-side timeout at all. Sent as
    // Postgres startup/session parameters (postgres.js `connection` option),
    // so every connection in the pool gets them — no per-query opt-in needed.
    //   - lock_timeout: the vector identified for the cron watchdog (R1) — a
    //     query blocked waiting on a row lock previously waited forever.
    //     30s is comfortably longer than any legitimate lock wait in this
    //     app's write patterns (single-row updates/inserts, no long-held
    //     locks by design).
    //   - idle_in_transaction_session_timeout: a transaction left open with
    //     no further statements (BEGIN without COMMIT/ROLLBACK) is always a
    //     bug, never a legitimate long-running operation — 60s is generous.
    // Deliberately NOT setting statement_timeout here: a global cap would
    // also apply to legitimate long-running operations (a large backfill, a
    // slow migration-adjacent query) and risk cutting them off mid-flight.
    // migrate.ts uses its own separate `postgres()` connection (not this
    // factory) for running migrations, so these timeouts don't touch
    // migrations at all either way.
    connection: {
      lock_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    /** Gracefully close all pool connections */
    close: () => pool.end(),
  };
}

export type { schema };
