// routes/worker.ts — POST /api/worker — execute a job (LLM loop)
// Responds 202 immediately, runs executeJob in background.
// Auth: WORKER_SECRET bearer token (internal calls only).

import type { Context } from 'hono';
import { z } from 'zod';
import { executeJob } from '../job/execute.ts';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import type { JobId } from '@nodalai/orchestration';

// ─── Request schema ───────────────────────────────────────────────────────────

export const WorkerRequestSchema = z.object({
  jobId: z.string().guid(),
});

// ─── workerRoute ──────────────────────────────────────────────────────────────

/**
 * POST /api/worker { jobId } → 202 { ok: true, jobId, status: 'accepted' }
 *
 * Auth: WORKER_SECRET bearer token in Authorization header.
 * Runs the LLM loop in the background after responding 202.
 */
export async function workerRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  // Validate worker secret
  const workerSecret = runnerEnv.WORKER_SECRET;
  if (!workerSecret) {
    return c.json({ error: 'server_misconfiguration' }, 500);
  }

  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Constant-time comparison
  if (!timingSafeEqual(provided, workerSecret)) {
    return c.json({ error: 'invalid_worker_secret' }, 403);
  }

  // Parse body
  const body = await c.req.json().catch(() => null);
  const parsed = WorkerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { jobId } = parsed.data;

  // Respond 202 immediately — job runs in background
  // The result is written to DB; dashboard polls via SSE
  void runJobBackground(jobId, deps, runnerEnv);

  return c.json({ ok: true, jobId, status: 'accepted' }, 202);
}

// ─── Background execution ─────────────────────────────────────────────────────

async function runJobBackground(
  jobId: string,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<void> {
  try {
    await executeJob(jobId as JobId, deps, runnerEnv);
  } catch {
    // executeJob never throws — it catches all errors internally.
    // This catch is defensive only.
  }
}

// ─── Timing-safe string comparison ───────────────────────────────────────────

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Returns true iff a === b.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a full comparison to avoid length-based timing leak
    let _diff = 0;
    const padded = b.padEnd(a.length, '\0');
    for (let i = 0; i < a.length; i++) {
      _diff |= a.charCodeAt(i) ^ (padded.charCodeAt(i) ?? 0);
    }
    return false; // Length mismatch → always false
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}
