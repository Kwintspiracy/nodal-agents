// routes/approve.ts — POST /api/approve — resume an awaiting_approval job
//
// POST /api/approve { approvalRequestId, decision: 'approve' | 'reject', notes? }
//   → { jobId, status }
//
// This route only records the human's decision (approved / rejected) and
// re-queues the job. The actual tool execution happens in execute.ts step 11.7
// (the execute-on-resume step) which fires at the start of executeJob and
// replaces the [AWAITING_APPROVAL] marker with the real tool output.

import type { Context } from 'hono';
import { z } from 'zod';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveApprovalDecision } from '../approvals/resolve.ts';

// ─── Request schema ───────────────────────────────────────────────────────────

export const ApproveRequestSchema = z.object({
  approvalRequestId: z.string().guid(),
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
});

// ─── approveRoute ─────────────────────────────────────────────────────────────

export async function approveRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const body = await c.req.json().catch(() => null);
  const parsed = ApproveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { approvalRequestId, decision, notes } = parsed.data;

  // Authorization (finding #4/#5): an untrusted session bearer-token caller
  // may only resolve an approval belonging to its own entity — trusted
  // callers (web via WORKER_SECRET) keep the pre-existing unscoped lookup.
  const expectedEntityId = c.get('callerTrusted') ? undefined : c.get('callerEntityId');

  // Dashboard-driven resolution → resolvedBy: 'api'. Shares the channel-neutral
  // core with the Telegram inline-button path (approvals/resolve.ts).
  const result = await resolveApprovalDecision(deps, runnerEnv, {
    approvalRequestId,
    decision,
    resolvedBy: 'api',
    notes: notes ?? null,
    expectedEntityId,
  });

  if (!result.ok) {
    if (result.code === 'approval_not_found') return c.json({ error: 'approval_not_found' }, 404);
    if (result.code === 'job_not_found') return c.json({ error: 'job_not_found' }, 404);
    return c.json({ error: 'approval_already_resolved', status: result.status }, 400);
  }

  // 'worker' = the job was `awaiting_approval` and is now `pending` (re-queued
  // for triggerWorker). 'in_process' (Lot A1) = the job's own executeJob is
  // already past `awaiting_approval` — it never actually suspended, so the
  // status the caller should see is whatever the job holds now, not 'pending'.
  const status = result.resumed === 'in_process' ? 'processing' : 'pending';
  return c.json({ ok: true, jobId: result.jobId, status, decision }, 200);
}
