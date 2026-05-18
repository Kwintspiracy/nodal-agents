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

    const claimed = await claimJob(db as Parameters<typeof claimJob>[0], seed.jobId, 'worker-1');

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
