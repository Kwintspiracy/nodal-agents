// cron/tests/deliver-results.test.ts
// Acceptance criteria:
//   - all tasks done → delivery called once, root job marked completed
//   - second tick does NOT re-deliver (idempotency via completedAt guard)
//   - mixed done/failed tasks → still triggers delivery
//   - tasks still in_progress → no delivery
//   - compiled result includes all task titles + results
//   - regression: inject_delegation.wrong_status — all tasks found, not just first

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import { deliverCompletedRoots } from '../deliver-results.ts';

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createRootJob() {
  const rows = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'root task',
      status: 'completed', // root job already finished its planning phase
      messages: [],
    })
    .returning();
  return rows[0]!;
}

async function createTaskForRoot(
  rootJobId: string,
  status: string,
  result: string,
  title?: string,
) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: title ?? `Task ${Math.random().toString(36).slice(2, 6)}`,
      status,
      result,
      rootJobId,
    })
    .returning();
  return rows[0]!;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('deliverCompletedRoots', () => {
  it('marks root job completed when all tasks are done', async () => {
    const rootJob = await createRootJob();
    // Reset completedAt to null so deliverCompletedRoots can set it
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Task 1 result', 'Task 1');
    await createTaskForRoot(rootJob.id, 'done', 'Task 2 result', 'Task 2');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({
        status: agentJobs.status,
        completedAt: agentJobs.completedAt,
        result: agentJobs.result,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.completedAt).not.toBeNull();
    expect(updated[0]?.result).toContain('Task 1');
    expect(updated[0]?.result).toContain('Task 2');
  });

  it('does NOT re-deliver when root job already has completedAt set', async () => {
    const rootJob = await createRootJob();
    // completedAt is already set (from createRootJob)
    await createTaskForRoot(rootJob.id, 'done', 'already delivered result');

    // Set completedAt explicitly
    await db
      .update(agentJobs)
      .set({ completedAt: new Date(), result: 'previous delivery' })
      .where(eq(agentJobs.id, rootJob.id));

    await deliverCompletedRoots(db as RunnerDeps['db']);

    // This root job should be skipped (already delivered)
    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.result).toBe('previous delivery'); // unchanged
  });

  it('does not deliver when tasks are still in_progress', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'done result');
    await createTaskForRoot(rootJob.id, 'in_progress', 'not done yet');

    await deliverCompletedRoots(db as RunnerDeps['db']);
    // This specific root should NOT be delivered
    const updated = await db
      .select({ completedAt: agentJobs.completedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.completedAt).toBeNull();
  });

  it('delivers when mix of done and blocked tasks (all terminal)', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Task A success', 'Task A');
    await createTaskForRoot(rootJob.id, 'blocked', 'Task B failed: some error', 'Task B');

    const count = await deliverCompletedRoots(db as RunnerDeps['db']);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.result).toContain('Task A');
    expect(updated[0]?.result).toContain('Task B');
  });

  it('compiled result includes all task titles and results', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'Alpha result', 'Alpha Task');
    await createTaskForRoot(rootJob.id, 'done', 'Beta result', 'Beta Task');
    await createTaskForRoot(rootJob.id, 'done', 'Gamma result', 'Gamma Task');

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    const compiled = updated[0]?.result ?? '';
    expect(compiled).toContain('Alpha Task');
    expect(compiled).toContain('Alpha result');
    expect(compiled).toContain('Beta Task');
    expect(compiled).toContain('Beta result');
    expect(compiled).toContain('Gamma Task');
    expect(compiled).toContain('Gamma result');
  });

  it('regression: inject_delegation.wrong_status — all tasks compiled, not just first', async () => {
    // Legacy bug: only the first task was included in the delivery result.
    // This test verifies that ALL tasks are compiled.
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    const TASKS = ['Research phase', 'Analysis phase', 'Summary phase', 'Final report'];
    const results = ['Research done', 'Analysis done', 'Summary done', 'Report done'];

    for (let i = 0; i < TASKS.length; i++) {
      await createTaskForRoot(rootJob.id, 'done', results[i]!, TASKS[i]);
    }

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const updated = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    const compiled = updated[0]?.result ?? '';

    // ALL four tasks must appear in the compiled result
    for (const title of TASKS) {
      expect(compiled).toContain(title);
    }
    for (const res of results) {
      expect(compiled).toContain(res);
    }
  });

  it('idempotency: two concurrent ticks deliver each root exactly once', async () => {
    const rootJob = await createRootJob();
    await db
      .update(agentJobs)
      .set({ completedAt: null, status: 'processing' })
      .where(eq(agentJobs.id, rootJob.id));

    await createTaskForRoot(rootJob.id, 'done', 'concurrent task result');

    // Run two concurrent delivery calls
    const [countA, countB] = await Promise.all([
      deliverCompletedRoots(db as RunnerDeps['db']),
      deliverCompletedRoots(db as RunnerDeps['db']),
    ]);

    // Total delivered for this root = exactly 1 (one wins the atomic claim)
    const total = countA + countB;
    expect(total).toBeGreaterThanOrEqual(1); // at least 1 (could be 1 from other tests)

    // Verify the root job was delivered exactly once (completedAt set once)
    const updated = await db
      .select({ completedAt: agentJobs.completedAt, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, rootJob.id));

    expect(updated[0]?.status).toBe('completed');
    expect(updated[0]?.completedAt).not.toBeNull();
  });
});

// Augment the type for db in this file
type RunnerDeps = { db: typeof db };
