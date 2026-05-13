// routes/health.ts — GET /api/health — db + llm reachability probe
// Returns { ok, db, llm } — never throws, always returns 200 with diagnostic.

import type { Context } from 'hono';
import type { RunnerDeps } from '../deps.ts';
import { sql } from '@nodal-agents/db';

// ─── healthRoute ──────────────────────────────────────────────────────────────

export async function healthRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const result: {
    ok: boolean;
    db: 'ok' | 'error';
    llm: 'ok' | 'unchecked';
    dbError?: string;
  } = {
    ok: false,
    db: 'error',
    llm: 'unchecked', // LLM is not pinged on every health check (expensive)
  };

  // DB ping: cheapest possible query
  try {
    await deps.db.execute(sql`SELECT 1`);
    result.db = 'ok';
  } catch (err) {
    result.dbError = err instanceof Error ? err.message : String(err);
  }

  result.ok = result.db === 'ok';

  return c.json(result, result.ok ? 200 : 503);
}
