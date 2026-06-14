// state.test.ts — invalid transitions rejected, helpers work correctly

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import {
  assertTransition,
  JobStateError,
  setJobStatus,
  claimJob,
  completeJob,
  failJob,
  cancelJob,
  saveCheckpoint,
} from '../../job/state.ts';
import type { JobStatus } from '../../job/state.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

/** Insert a fresh agent_jobs row and return its id. Used by Leg-3 tests that
 * need isolated rows so they don't corrupt the shared seed.jobId. */
async function insertFreshJob(status: string): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'test task',
      status,
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('Failed to insert fresh job');
  return row.id;
}

describe('assertTransition', () => {
  it('allows pending → processing', () => {
    expect(() => assertTransition('job-1', 'pending', 'processing')).not.toThrow();
  });

  it('allows processing → completed', () => {
    expect(() => assertTransition('job-1', 'processing', 'completed')).not.toThrow();
  });

  it('allows processing → awaiting_approval', () => {
    expect(() => assertTransition('job-1', 'processing', 'awaiting_approval')).not.toThrow();
  });

  it('allows awaiting_approval → pending (resume)', () => {
    expect(() => assertTransition('job-1', 'awaiting_approval', 'pending')).not.toThrow();
  });

  it('allows awaiting_delegation → pending (resume)', () => {
    expect(() => assertTransition('job-1', 'awaiting_delegation', 'pending')).not.toThrow();
  });

  it('rejects completed → processing (terminal state)', () => {
    expect(() => assertTransition('job-1', 'completed', 'processing')).toThrow(JobStateError);
  });

  it('rejects failed → pending (terminal state)', () => {
    expect(() => assertTransition('job-1', 'failed', 'pending')).toThrow(JobStateError);
  });

  it('rejects pending → completed (skip processing)', () => {
    expect(() => assertTransition('job-1', 'pending', 'completed')).toThrow(JobStateError);
  });

  it('JobStateError carries code and transition info', () => {
    try {
      assertTransition('job-abc', 'completed', 'processing');
    } catch (err) {
      expect(err).toBeInstanceOf(JobStateError);
      const e = err as JobStateError;
      expect(e.code).toBe('invalid_job_transition');
      expect(e.jobId).toBe('job-abc');
      expect(e.from).toBe('completed');
      expect(e.to).toBe('processing');
    }
  });

  const validTransitions: Array<[JobStatus, JobStatus]> = [
    ['pending', 'processing'],
    ['pending', 'cancelled'],
    ['processing', 'completed'],
    ['processing', 'failed'],
    ['processing', 'awaiting_approval'],
    ['processing', 'awaiting_delegation'],
    ['awaiting_approval', 'pending'],
    ['awaiting_approval', 'failed'],
    ['awaiting_delegation', 'pending'],
    ['awaiting_delegation', 'failed'],
  ];

  for (const [from, to] of validTransitions) {
    it(`allows ${from} → ${to}`, () => {
      expect(() => assertTransition('j', from, to)).not.toThrow();
    });
  }
});

describe('DB state helpers', () => {
  it('setJobStatus updates status in DB', async () => {
    await setJobStatus(db as Parameters<typeof setJobStatus>[0], seed.jobId, 'processing');

    const rows = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.status).toBe('processing');
  });

  it('claimJob returns true and sets status to processing', async () => {
    // Reset to pending
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, seed.jobId));

    const claimed = await claimJob(db as Parameters<typeof claimJob>[0], seed.jobId);

    expect(claimed).toBe(true);

    const rows = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.status).toBe('processing');
  });

  it('completeJob sets status, result, completedAt', async () => {
    await completeJob(
      db as Parameters<typeof completeJob>[0],
      seed.jobId,
      'Task accomplished successfully',
      ['return_result'],
    );

    const rows = await db
      .select({
        status: agentJobs.status,
        result: agentJobs.result,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toBe('Task accomplished successfully');
    expect(rows[0]?.completedAt).toBeTruthy();
  });

  it('completeJob persists messages JSONB when provided (Brique 28 regression)', async () => {
    // Reset to processing so the conditional writer (Leg 3) allows the write.
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, seed.jobId));

    // Single-turn jobs that complete via return_result used to leave the
    // messages array stuck at its initial [user]-only state. The runner had
    // the assistant turn in memory but completeJob never wrote it. Result:
    // the dashboard /jobs/[id] panel showed only the user prompt.
    const fullMessages = [
      { role: 'user', content: 'what is the cosmic microwave background?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success', text: 'CMB is the relic radiation from the Big Bang.' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            result: { acknowledged: true },
          },
        ],
      },
    ];

    await completeJob(
      db as Parameters<typeof completeJob>[0],
      seed.jobId,
      'CMB is the relic radiation from the Big Bang.',
      ['return_result'],
      undefined,
      fullMessages,
    );

    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.messages).toEqual(fullMessages);
  });

  it('failJob sets status to failed with error code AND completedAt', async () => {
    // Reset to processing so the conditional writer (Leg 3) allows the write.
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, seed.jobId));

    const before = Date.now();
    await failJob(db as Parameters<typeof failJob>[0], seed.jobId, 'chain_limit_exceeded');
    const after = Date.now();

    const rows = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('chain_limit_exceeded');
    // completedAt must be set so dashboards/cron filtering by
    // `completed_at IS NULL` correctly excludes terminated jobs.
    expect(rows[0]?.completedAt).not.toBeNull();
    const completedAtMs = rows[0]?.completedAt?.getTime() ?? 0;
    expect(completedAtMs).toBeGreaterThanOrEqual(before);
    expect(completedAtMs).toBeLessThanOrEqual(after);
  });

  it('failJob backstop: fills an empty result with a generic explanation naming the error code', async () => {
    const jobId = await insertFreshJob('processing');
    await failJob(db as Parameters<typeof failJob>[0], jobId, 'token_budget_exceeded');

    const [row] = await db
      .select({ result: agentJobs.result, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));

    // Never silent: a non-empty, error-code-bearing explanation is surfaced.
    expect(row?.error).toBe('token_budget_exceeded');
    expect(row?.result).toBeTruthy();
    expect(row?.result).toContain('token_budget_exceeded');
  });

  it('failJob backstop: persists the supplied userMessage verbatim as the user-facing result', async () => {
    const jobId = await insertFreshJob('processing');
    const reason = 'Missing the Notion API key — add it under Connectors, then retry.';
    await failJob(
      db as Parameters<typeof failJob>[0],
      jobId,
      'agent_blocked',
      undefined,
      undefined,
      reason,
    );

    const [row] = await db
      .select({ result: agentJobs.result, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));

    expect(row?.error).toBe('agent_blocked');
    expect(row?.result).toBe(reason);
  });

  it('failJob backstop: preserves an existing non-empty result (partial delivery not clobbered)', async () => {
    const jobId = await insertFreshJob('processing');
    await db
      .update(agentJobs)
      .set({ result: 'partial delivery from dashboard_publish' })
      .where(eq(agentJobs.id, jobId));

    await failJob(db as Parameters<typeof failJob>[0], jobId, 'unresolved_tool_failure');

    const [row] = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));

    // The partial content the agent already delivered must survive the failure.
    expect(row?.result).toBe('partial delivery from dashboard_publish');
  });

  it('cancelJob stamps completedAt + persists messages WITHOUT touching status', async () => {
    // The status column is flipped to 'cancelled' by `cancelJobAction`
    // (web), not by this helper — the helper only finalises the row.
    // Verify: existing status preserved, completedAt set, messages saved.
    await setJobStatus(db as Parameters<typeof setJobStatus>[0], seed.jobId, 'cancelled');

    const transcript = [
      { role: 'user', content: 'long-running task' },
      { role: 'assistant', content: 'working...' },
    ];

    const before = Date.now();
    await cancelJob(
      db as Parameters<typeof cancelJob>[0],
      seed.jobId,
      { inputTokens: 42, outputTokens: 7, turn: 3 },
      transcript,
    );
    const after = Date.now();

    const rows = await db
      .select({
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        messages: agentJobs.messages,
        inputTokens: agentJobs.inputTokens,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    // Status stays cancelled — we deliberately don't write it again here.
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.completedAt).not.toBeNull();
    const ts = rows[0]?.completedAt?.getTime() ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(rows[0]?.messages).toEqual(transcript);
    expect(rows[0]?.inputTokens).toBe(42);
    expect(rows[0]?.turn).toBe(3);
  });

  // F1 regression — Leg 1: claimJob returns false (and does NOT touch the row)
  // when the job is not in 'pending' state. Uses a fresh row so it doesn't
  // contaminate seed.jobId for subsequent tests.
  it('Leg 1: claimJob returns false when job is not pending (already processing)', async () => {
    const jobId = await insertFreshJob('processing');

    const claimed = await claimJob(db as Parameters<typeof claimJob>[0], jobId);

    expect(claimed).toBe(false);

    // Row must still be 'processing' — the call must not have written anything.
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('processing');
  });

  // F1 regression — Leg 3: completeJob returns false (no write) when row is
  // already terminal; returns true (writes) when row is 'processing'.
  it('Leg 3: completeJob returns true when processing, false when already terminal', async () => {
    const jobId = await insertFreshJob('processing');

    const wrote = await completeJob(
      db as Parameters<typeof completeJob>[0],
      jobId,
      'completed result',
      ['return_result'],
    );
    expect(wrote).toBe(true);

    // Row is now 'completed' — calling again must return false (no overwrite).
    const again = await completeJob(
      db as Parameters<typeof completeJob>[0],
      jobId,
      'overwrite attempt',
      [],
    );
    expect(again).toBe(false);

    // The row must still hold the FIRST completed result, not the overwrite.
    const [row] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('completed');
    expect(row?.result).toBe('completed result');
  });

  // F1 regression — Leg 3: failJob returns false (no write) when row is already
  // terminal (e.g. orphan reaper already marked it failed).
  it('Leg 3: failJob returns false and does NOT overwrite when row is already terminal', async () => {
    // Insert a row already in 'failed' (simulating what the orphan reaper does).
    const jobId = await insertFreshJob('failed');
    await db
      .update(agentJobs)
      .set({ error: 'orphan_job_reset' })
      .where(eq(agentJobs.id, jobId));

    const wrote = await failJob(
      db as Parameters<typeof failJob>[0],
      jobId,
      'zombie_attempt',
    );
    expect(wrote).toBe(false);

    // Error code must still be the reaper's, not 'zombie_attempt'.
    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('orphan_job_reset');
  });

  // F1 regression — Leg 3: failJob returns true when row is 'processing'.
  it('Leg 3: failJob returns true and writes when row is processing', async () => {
    const jobId = await insertFreshJob('processing');

    const wrote = await failJob(
      db as Parameters<typeof failJob>[0],
      jobId,
      'test_failure_code',
    );
    expect(wrote).toBe(true);

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('test_failure_code');
  });

  it('saveCheckpoint persists messages, turn, chainCount', async () => {
    const messages = [
      { role: 'user', content: 'test task' },
      { role: 'assistant', content: 'working on it' },
    ];

    await saveCheckpoint(db as Parameters<typeof saveCheckpoint>[0], seed.jobId, {
      messages,
      turn: 3,
      chainCount: 2,
      toolsUsed: ['save_memory'],
    });

    const rows = await db
      .select({
        messages: agentJobs.messages,
        turn: agentJobs.turn,
        chainCount: agentJobs.chainCount,
        toolsUsed: agentJobs.toolsUsed,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, seed.jobId));

    expect(rows[0]?.turn).toBe(3);
    expect(rows[0]?.chainCount).toBe(2);
    expect(Array.isArray(rows[0]?.messages)).toBe(true);
    expect(rows[0]?.toolsUsed).toContain('save_memory');
  });
});
