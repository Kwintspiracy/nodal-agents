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
  // F-3 (audit #2): a tick is a GLOBAL system operation (every entity), not
  // scoped to the caller — requireRunnerAuth still authenticates a plain
  // session bearer-token caller (any entity's API user) onto this route, but
  // that's the wrong authorization model here. Restrict to trusted callers:
  // local-trust (dev, no auth) or a valid WORKER_SECRET bearer — the
  // credential the external scheduler this route exists for is configured
  // with. An ordinary entity user forcing a global tick is op abuse, not a
  // legitimate use of their own API access.
  if (!c.get('callerTrusted')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const result = await runCronTickGuarded(deps, 5);
  return c.json({ ok: true, ...result }, 200);
}
