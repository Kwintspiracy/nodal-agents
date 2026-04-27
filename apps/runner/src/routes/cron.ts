// routes/cron.ts — POST /api/cron — STUB
// Brique 14 implements the full cron tick logic:
//   - Reset orphaned tasks (in_progress without job_id > 5 min)
//   - Unblock tasks whose deps are done
//   - Execute todo tasks (max 5 per tick)
//   - Deliver compiled results when all tasks for root_job_id are done
//
// For now: returns { tasksProcessed: 0 } immediately.

import type { Context } from 'hono';

// ─── cronRoute ────────────────────────────────────────────────────────────────

export async function cronRoute(c: Context): Promise<Response> {
  // TODO(brique-14): implement cron tick
  return c.json({ ok: true, tasksProcessed: 0 }, 200);
}
