// cron/tests/reset-orphans.test.ts
// Acceptance criteria:
//   - 6-min-stale in_progress task with no job_id → reset to todo
//   - fresh in_progress task (1 min ago) → NOT reset
//   - in_progress task with no lock time → reset (defensive)
//   - in_progress task whose job is completed → reset
//   - already todo task → unchanged

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import { resetOrphanedTasks, resetOrphanedJobs } from '../reset-orphans.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

async function createTask(overrides: {
  status: string;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  jobId?: string | null;
}) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Test task',
      status: overrides.status,
      lockedAt: overrides.lockedAt ?? null,
      lockedBy: overrides.lockedBy ?? null,
      jobId: overrides.jobId ?? null,
    })
    .returning();
  return rows[0]!;
}

describe('resetOrphanedTasks', () => {
  it('resets a 6-min-stale in_progress task with no job_id to todo', async () => {
    const staleDate = new Date(Date.now() - 6 * 60 * 1000);
    const task = await createTask({
      status: 'in_progress',
      lockedAt: staleDate,
      lockedBy: 'worker-abc',
      jobId: null,
    });

    const count = await resetOrphanedTasks(db, 5);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentTasks.status, lockedBy: agentTasks.lockedBy })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
    expect(updated[0]?.lockedBy).toBeNull();
  });

  it('does NOT reset a fresh (1-min-old) in_progress task', async () => {
    const freshDate = new Date(Date.now() - 60 * 1000); // 1 min ago
    const task = await createTask({
      status: 'in_progress',
      lockedAt: freshDate,
      lockedBy: 'worker-fresh',
      jobId: null,
    });

    // Only reset tasks older than 5 minutes
    await resetOrphanedTasks(db, 5);
    // This task is fresh — should NOT be reset
    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('in_progress');
  });

  it('resets an in_progress task with NULL lockedAt', async () => {
    const task = await createTask({
      status: 'in_progress',
      lockedAt: null, // no lock time — defensive reset
      lockedBy: null,
      jobId: null,
    });

    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
  });

  it('resets an in_progress task whose linked job is completed', async () => {
    // Create a completed job
    const completedJobRows = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'task-board',
        task: 'parent task',
        status: 'completed',
      })
      .returning();
    const completedJob = completedJobRows[0]!;

    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const task = await createTask({
      status: 'in_progress',
      lockedAt: staleDate,
      lockedBy: 'worker-old',
      jobId: completedJob.id,
    });

    // Task is in_progress but job is done — orphaned
    // Note: this is Case B (terminal job). The task has a job_id but it's completed.
    // Our implementation handles Case B through terminal job detection.
    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    // Either reset to todo OR left in_progress (case B may not trigger for completed job
    // since the task's lockedAt is stale). In any case, the stale lock path (Case A)
    // should handle it because lockedAt is old AND job_id is set but locked_at is stale.
    // The spec says: "in_progress with no job_id OR in_progress with terminal job"
    // Case A (no job_id + stale) is the primary path. Case B is additional.
    // This task has a job_id, so we test Case B specifically.
    // Since the task HAS a job_id, Case A won't trigger. Case B should trigger.
    expect(updated[0]?.status).toBe('todo');
  });

  it('does not touch todo tasks', async () => {
    const task = await createTask({ status: 'todo', lockedAt: null });

    await resetOrphanedTasks(db, 5);

    const updated = await db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, task.id));

    expect(updated[0]?.status).toBe('todo');
  });

  it('returns count of reset tasks', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    await createTask({ status: 'in_progress', lockedAt: staleDate, jobId: null });
    await createTask({ status: 'in_progress', lockedAt: staleDate, jobId: null });

    const count = await resetOrphanedTasks(db, 5);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─── resetOrphanedJobs ────────────────────────────────────────────────────────

async function createJob(overrides: { status: string; updatedAt?: Date }) {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'orphan candidate',
      status: overrides.status,
      // updatedAt defaults to now() — we override with a raw update post-insert
      // because Drizzle's defaultNow() is computed in JS for postgres-js but
      // pglite + DEFAULT now() in DDL means a value passed as updatedAt is
      // honored. We pass it directly.
      updatedAt: overrides.updatedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('Failed to seed job');
  return row;
}

describe('resetOrphanedJobs', () => {
  it('marks a stale processing job as failed with orphan_job_reset', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const job = await createJob({ status: 'processing', updatedAt: staleDate });

    const count = await resetOrphanedJobs(db, 5);
    expect(count).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('orphan_job_reset');
  });

  it('marks a stale awaiting_delegation job as failed', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const job = await createJob({ status: 'awaiting_delegation', updatedAt: staleDate });

    await resetOrphanedJobs(db, 5);

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('orphan_job_reset');
  });

  it('does NOT touch a fresh processing job (1 min old)', async () => {
    const freshDate = new Date(Date.now() - 60 * 1000);
    const job = await createJob({ status: 'processing', updatedAt: freshDate });

    await resetOrphanedJobs(db, 5);

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.status).toBe('processing');
  });

  it('does NOT touch jobs in terminal states (completed/failed/cancelled)', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    const completed = await createJob({ status: 'completed', updatedAt: staleDate });
    const failed = await createJob({ status: 'failed', updatedAt: staleDate });
    const cancelled = await createJob({ status: 'cancelled', updatedAt: staleDate });

    await resetOrphanedJobs(db, 5);

    for (const j of [completed, failed, cancelled]) {
      const [row] = await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, j.id));
      expect(row?.status).toBe(j.status);
    }
  });

  it('does NOT touch awaiting_approval jobs (humans may resolve them later)', async () => {
    const staleDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
    const job = await createJob({ status: 'awaiting_approval', updatedAt: staleDate });

    await resetOrphanedJobs(db, 5);

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    // awaiting_approval is gated on a human acting; its TTL is enforced
    // separately via approval_requests.expires_at — this cron must not
    // pre-empt that.
    expect(row?.status).toBe('awaiting_approval');
  });

  it('returns count of jobs reset', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    await createJob({ status: 'processing', updatedAt: staleDate });
    await createJob({ status: 'awaiting_delegation', updatedAt: staleDate });

    const count = await resetOrphanedJobs(db, 5);
    // ≥ 2 because earlier tests in this file may have left stale rows.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // Regression for live bug observed on job 58e38faa (2026-05-13):
  // a parent in awaiting_delegation whose Summarizer sub-job took 7.5 min
  // for a deep research got nuked by the cron at the 5-min mark, killing
  // the resume path. The fix: skip the reset when the sub-job is still
  // alive, bump updated_at instead to push back the staleness check.
  it('does NOT reset awaiting_delegation parent when its sub-job is still running', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    // 1. Sub-job is processing (still alive, no terminal status)
    const subJob = await createJob({ status: 'processing', updatedAt: new Date() });
    // 2. Parent is stale awaiting_delegation, pending_delegation references the sub
    const [parent] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'orchestrator waiting for long sub-job',
        status: 'awaiting_delegation',
        updatedAt: staleDate,
        pendingDelegation: {
          toolUseId: 'tu_test',
          toolName: 'assign_summarizer',
          subJobId: subJob.id,
        },
      })
      .returning();
    if (!parent) throw new Error('Failed to seed parent');

    await resetOrphanedJobs(db, 5);

    const [parentAfter] = await db
      .select({ status: agentJobs.status, updatedAt: agentJobs.updatedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));

    // Parent should NOT have been marked failed — its sub is still alive.
    expect(parentAfter?.status).toBe('awaiting_delegation');
    // And updated_at should have been bumped past the cutoff so next tick re-evaluates.
    expect(parentAfter?.updatedAt?.getTime() ?? 0).toBeGreaterThan(staleDate.getTime());
  });

  it('DOES reset awaiting_delegation parent when sub-job already completed (truly orphaned resume)', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    // Sub-job completed but the resume path never fired (e.g. runner crashed
    // after the child completed). Parent must be reset — otherwise it sits
    // forever in awaiting_delegation.
    const subJob = await createJob({ status: 'completed', updatedAt: staleDate });
    const [parent] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'orchestrator with completed-but-unresumed sub',
        status: 'awaiting_delegation',
        updatedAt: staleDate,
        pendingDelegation: {
          toolUseId: 'tu_test_orphan',
          toolName: 'assign_summarizer',
          subJobId: subJob.id,
        },
      })
      .returning();
    if (!parent) throw new Error('Failed to seed parent');

    await resetOrphanedJobs(db, 5);

    const [parentAfter] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));

    expect(parentAfter?.status).toBe('failed');
    expect(parentAfter?.error).toBe('orphan_job_reset');
  });
});
