// routes/cron.ts — POST /api/cron
// Triggers a single cron tick synchronously and returns a summary.
// Used by external managed crons (Vercel cron, Fly scheduled task, etc.).
// For local installs the in-process ticker in server.ts fires automatically.

import type { Context } from 'hono';
import { runCronTick } from '../cron/tick.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// ─── cronRoute ────────────────────────────────────────────────────────────────

export async function cronRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv?: Pick<RunnerEnv, 'TELEGRAM_BOT_TOKEN'>,
): Promise<Response> {
  const result = await runCronTick(deps, 5, runnerEnv);
  return c.json({ ok: true, ...result }, 200);
}
