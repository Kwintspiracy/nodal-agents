import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server.ts';
import { sql } from '@nodal-agents/db';

// Un health probe ne se met jamais en cache.
export const dynamic = 'force-dynamic';

/**
 * GET /api/health — { ok, db, service }, 503 quand la base est injoignable.
 *
 * Ce handler répondait `{ ok: true }` inconditionnellement — c'est ce qui a
 * rendu l'incident du 23/08 invisible : Postgres mort, dashboard qui fait
 * semblant, et un `curl :3000/api/health` qui jure que tout va bien. Même
 * contrat que le health du runner désormais : SELECT 1, et le détail de
 * l'erreur va dans les logs serveur uniquement (jamais au client — la route
 * n'est pas authentifiée).
 */
export async function GET(): Promise<NextResponse> {
  let db: 'ok' | 'error' = 'error';
  try {
    await getDb().execute(sql`SELECT 1`);
    db = 'ok';
  } catch (err) {
    console.error('[health] DB ping failed:', err instanceof Error ? err.message : err);
  }
  const ok = db === 'ok';
  return NextResponse.json({ ok, db, service: 'nodalai-web' }, { status: ok ? 200 : 503 });
}
