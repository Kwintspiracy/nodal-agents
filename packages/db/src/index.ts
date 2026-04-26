// @nodalai/db — public API

export { createClient } from './client.ts';
export type { DbClient, CreateClientOptions, AnyDrizzleDb } from './client.ts';

export { withTransaction } from './transaction.ts';

export * from './schema/index.ts';

// Re-export commonly used Drizzle query helpers so that other packages
// (e.g. packages/auth) can use them without importing drizzle-orm directly.
// Only packages/db may import drizzle-orm (architecture rule).
export { eq, and, or, sql } from 'drizzle-orm';
