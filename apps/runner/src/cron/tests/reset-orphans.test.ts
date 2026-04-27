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
import { resetOrphanedTasks } from '../reset-orphans.ts';

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
