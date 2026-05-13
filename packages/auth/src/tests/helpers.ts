// Test helpers for @nodal-agents/auth tests.
// Delegates to @nodal-agents/db/test-utils for the pglite spinUpTestDb helper —
// so packages/auth does not need to import pglite directly (architecture rule).

import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import * as schema from '@nodal-agents/db/schema';

export type AuthTestDb =
  ReturnType<typeof spinUpTestDb> extends Promise<{ db: infer D }> ? D : never;

/**
 * Spins up an in-memory PGlite instance with the full schema including auth tables.
 * Delegates to @nodal-agents/db/test-utils which already includes all tables.
 */
export async function spinUpAuthTestDb(): Promise<{
  db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
}> {
  const result = await spinUpTestDb();
  return { db: result.db };
}

/** Build a fake HTTP Request with optional headers. */
export function fakeRequest(opts: { url?: string; headers?: Record<string, string> }): Request {
  return new Request(opts.url ?? 'http://localhost:3000/', {
    headers: opts.headers ?? {},
  });
}

// Re-export schema for tests that need to do direct DB queries.
export { schema };
