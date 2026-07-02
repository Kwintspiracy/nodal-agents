// approvals/resolve.ts — channel-neutral core for resolving an approval request.
//
// Both the dashboard (POST /api/approve) and the Telegram inline-button callback
// funnel through here so the decision logic lives in ONE place: mark the approval
// approved/rejected, set the job back to `pending`, and resume the worker (which
// executes or rejects the gated tool in execute.ts step 11.7). `resolvedBy`
// records WHERE the decision came from ('api' = dashboard, 'telegram' = button).

import { eq, and } from '@nodal-agents/db';
import { approvalRequests, agentJobs } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';

export type ApprovalDecision = 'approve' | 'reject';

export interface ResolveApprovalInput {
  approvalRequestId: string;
  decision: ApprovalDecision;
  /** Provenance of the decision — recorded in approval_requests.resolved_by. */
  resolvedBy: string;
  notes?: string | null;
  /**
   * Set by an UNTRUSTED caller (session bearer-token via /api/approve —
   * finding #4/#5): the approval must belong to this entity, closing the
   * runner-direct IDOR where an approval could be resolved by GUID alone
   * across tenants. Trusted callers (web via WORKER_SECRET, the Telegram
   * inline-button callback) pass undefined — unchanged behavior.
   */
  expectedEntityId?: string;
}

export type ResolveApprovalResult =
  | { ok: true; jobId: string; decision: ApprovalDecision; chatId: string | null }
  | {
      ok: false;
      code: 'approval_not_found' | 'already_resolved' | 'job_not_found';
      status?: string | null;
    };

/**
 * Resolve an approval request and resume its job. Idempotent-safe: a request
 * that is no longer `pending` returns `already_resolved` (the dashboard and a
 * Telegram tap can race — whoever gets there first wins, the other is told).
 * Returns the job's chatId so a caller can edit the originating Telegram card.
 */
export async function resolveApprovalDecision(
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
  input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
  const [approval] = await deps.db
    .select()
    .from(approvalRequests)
    .where(
      input.expectedEntityId
        ? and(
            eq(approvalRequests.id, input.approvalRequestId),
            eq(approvalRequests.entityId, input.expectedEntityId),
          )
        : eq(approvalRequests.id, input.approvalRequestId),
    )
    .limit(1);

  // Same code for "doesn't exist" and "exists but belongs to another entity"
  // — an untrusted caller must not learn which GUIDs exist outside its scope.
  if (!approval) return { ok: false, code: 'approval_not_found' };
  if (approval.status !== 'pending') {
    return { ok: false, code: 'already_resolved', status: approval.status };
  }

  const jobId = approval.jobId;
  const [job] = await deps.db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);
  if (!job) return { ok: false, code: 'job_not_found' };

  await deps.db
    .update(approvalRequests)
    .set({
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy,
      notes: input.notes ?? null,
    })
    .where(eq(approvalRequests.id, input.approvalRequestId));

  // Back to pending so executeJob picks it up. Approval does NOT bump chain_count
  // — the human acted on an already-proposed action, not a new LLM chain call.
  await deps.db
    .update(agentJobs)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(agentJobs.id, jobId));

  void triggerWorker(jobId, runnerEnv);

  return {
    ok: true,
    jobId,
    decision: input.decision,
    chatId: (job as { chatId?: string | null }).chatId ?? null,
  };
}
