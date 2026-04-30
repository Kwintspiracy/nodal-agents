// cron/tests/reset-orphans.test.ts
// Acceptance criteria:
//   - 6-min-stale in_progress task with no job_id → reset to todo
//   - fresh in_progress task (1 min ago) → NOT reset
//   - in_progress task with no lock time → reset (defensive)
//   - in_progress task whose job is completed → reset
//   - already todo task → unchanged

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agentTasks } from '@nodalai/db';
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

async function createJob(overrides: {
  status: string;
  updatedAt?: Date;
}) {
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
});
