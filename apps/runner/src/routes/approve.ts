// routes/approve.ts — POST /api/approve — resume an awaiting_approval job
// 1:1 port of legacy api/approve.py logic
//
// POST /api/approve { approvalRequestId, decision: 'approve' | 'reject', notes? }
//   → { jobId, status }

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

  // Load the paused job
  const jobRows = await deps.db.select().from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1);

  if (jobRows.length === 0) {
    return c.json({ error: 'job_not_found' }, 404);
  }

  const job = jobRows[0]!;

  // Build updated messages
  let messages = Array.isArray(job.messages) ? (job.messages as unknown[]) : [];

  if (decision === 'reject') {
    // Inject rejection into the conversation
    messages = injectRejection(messages, notes ?? '');

    // Set job back to pending for resume (approval does NOT bump chain_count)
    await deps.db
      .update(agentJobs)
      .set({
        messages,
        status: 'pending',
        updatedAt: new Date(),
      })
      .where(eq(agentJobs.id, jobId));
  } else {
    // Approve: inject approval marker so LLM sees the gate is open
    messages = injectApproval(messages);

    await deps.db
      .update(agentJobs)
      .set({
        messages,
        status: 'pending',
        updatedAt: new Date(),
      })
      .where(eq(agentJobs.id, jobId));
  }

  // Mark approval resolved (LAST — so a crash between execute+messages is retryable)
  await deps.db
    .update(approvalRequests)
    .set({
      status: decision === 'approve' ? 'approved' : 'rejected',
      resolvedAt: new Date(),
      resolvedBy: 'api',
      notes: notes ?? null,
    })
    .where(eq(approvalRequests.id, approvalRequestId));

  // Resume the job
  void triggerWorker(jobId, runnerEnv);

  return c.json({ ok: true, jobId, status: 'pending', decision }, 200);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function injectRejection(messages: unknown[], notes: string): unknown[] {
  return messages.map((msg) => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as Record<string, unknown>)['role'] === 'tool'
    ) {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        const updatedContent = content.map((block) => {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>)['type'] === 'tool-result'
          ) {
            const result = (block as Record<string, unknown>)['result'];
            if (typeof result === 'string' && result.includes('[AWAITING_APPROVAL]')) {
              return {
                ...(block as Record<string, unknown>),
                result: `[REJECTED] Human reviewer rejected this action. Reason: ${notes || 'no reason provided'}. Adapt your approach.`,
              };
            }
          }
          return block;
        });
        return { ...(msg as Record<string, unknown>), content: updatedContent };
      }
    }
    return msg;
  });
}

function injectApproval(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as Record<string, unknown>)['role'] === 'tool'
    ) {
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        const updatedContent = content.map((block) => {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>)['type'] === 'tool-result'
          ) {
            const result = (block as Record<string, unknown>)['result'];
            if (typeof result === 'string' && result.includes('[AWAITING_APPROVAL]')) {
              return {
                ...(block as Record<string, unknown>),
                result:
                  '[APPROVED] Human reviewer approved this action. Continue with the approved parameters.',
              };
            }
          }
          return block;
        });
        return { ...(msg as Record<string, unknown>), content: updatedContent };
      }
    }
    return msg;
  });
}
