// routes/cron.ts — POST /api/cron
// Triggers a single cron tick synchronously and returns a summary.
// Used by external managed crons (Vercel cron, Fly scheduled task, etc.).
// For local installs the in-process ticker in server.ts fires automatically.
//
// Goes through the SAME guarded entry point as the in-process ticker
// (cron/guarded-tick.ts) — finding R3 (audit2): an external scheduler that
// fires this route faster than a slow tick completes was previously exposed
// to the same concurrent-pile-up class of bug M-7 fixed for the in-process
// ticker. `runCronTickGuarded`'s `running` flag is module-level (shared by
// every caller), so an overlapping request here is skipped exactly like an
// overlapping in-process tick would be — and the two paths can't race each
// other into a double tick either, in the deployment where both happen to
// be enabled.

import type { Context } from 'hono';
import { runCronTickGuarded } from '../cron/guarded-tick.ts';
import type { RunnerDeps } from '../deps.ts';

// ─── cronRoute ────────────────────────────────────────────────────────────────

export async function cronRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const result = await runCronTickGuarded(deps, 5);
  return c.json({ ok: true, ...result }, 200);
}
