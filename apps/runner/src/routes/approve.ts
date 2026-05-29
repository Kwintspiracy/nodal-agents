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
import { eq } from '@nodal-agents/db';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from './agent.ts';

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

  // Load approval request
  const approvalRows = await deps.db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId))
    .limit(1);

  if (approvalRows.length === 0) {
    return c.json({ error: 'approval_not_found' }, 404);
  }

  const approval = approvalRows[0]!;

  if (approval.status !== 'pending') {
    return c.json({ error: 'approval_already_resolved', status: approval.status }, 400);
  }

  const jobId = approval.jobId;

  // Verify the job exists
  const jobRows = await deps.db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);

  if (jobRows.length === 0) {
    return c.json({ error: 'job_not_found' }, 404);
  }

  // Mark approval resolved. execute.ts step 11.7 reads this on resume and
  // executes or rejects the tool (replacing the [AWAITING_APPROVAL] marker).
  await deps.db
    .update(approvalRequests)
    .set({
      status: decision === 'approve' ? 'approved' : 'rejected',
      resolvedAt: new Date(),
      resolvedBy: 'api',
      notes: notes ?? null,
    })
    .where(eq(approvalRequests.id, approvalRequestId));

  // Set job back to pending so executeJob will pick it up.
  // Approval does NOT bump chain_count — the LLM did not make an extra chain
  // call, the human just acted on an already-proposed action.
  await deps.db
    .update(agentJobs)
    .set({
      status: 'pending',
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, jobId));

  // Resume the job
  void triggerWorker(jobId, runnerEnv);

  return c.json({ ok: true, jobId, status: 'pending', decision }, 200);
}
