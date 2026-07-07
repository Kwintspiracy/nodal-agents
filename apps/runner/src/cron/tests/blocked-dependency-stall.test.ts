// cron/tests/blocked-dependency-stall.test.ts
// Audit finding OR-4 (#14/#15): a dependency that finishes 'blocked' or
// 'cancelled' (instead of 'done') must NOT leave its dependent task stuck
// in 'todo' forever, and must NOT prevent the root job from ever reaching a
// terminal state. Repro simulates the real cron tick sequence
// (unblockReadyTasks → checkRootJobComplete → deliverCompletedRoots) run
// repeatedly, exactly as the cron ticker would, with T1 pre-set to a
// terminal-but-not-done status (as if its own job had already finished
// blocked/cancelled).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import { checkRootJobComplete } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { unblockReadyTasks } from '../unblock-ready.ts';
import { deliverCompletedRoots } from '../deliver-results.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

async function createRootJob() {
  const rows = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'root task',
      status: 'processing',
      completedAt: null,
      messages: [],
    })
    .returning();
  return rows[0]!;
}

async function createTaskForRoot(
  rootJobId: string,
  status: string,
  title: string,
  dependsOn: string[] = [],
  result: string | null = null,
) {
  const rows = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title,
      status,
      dependsOn,
      result,
      rootJobId,
    })
    .returning();
  return rows[0]!;
}

/** Simulate one cron tick's worth of dependency/delivery processing. */
async function runTick() {
  await unblockReadyTasks(db);
  return deliverCompletedRoots(db as Parameters<typeof deliverCompletedRoots>[0]);
}

describe('OR-4: blocked/cancelled dependency must not stall the dependent task forever', () => {
  it('T2 depends_on T1; T1 finishes blocked → T2 is resolved-failed (not left todo forever), root reaches a terminal state', async () => {
    const rootJob = await createRootJob();

    // T1 finished 'blocked' (as executeReadyTasks/markTaskFromResult would
    // set it once its own job failed) — NOT 'done'.
    const t1 = await createTaskForRoot(rootJob.id, 'blocked', 'T1', [], 'T1 failed: some error');
    // T2 depends on T1 and has never run.
    const t2 = await createTaskForRoot(rootJob.id, 'todo', 'T2', [t1.id]);

    // Run several cron ticks — proves the fix holds across repeated ticks,
    // not just the first one.
    for (let i = 0; i < 5; i++) {
      await runTick();
    }

    const t2Row = (
      await db
        .select({ status: agentTasks.status, result: agentTasks.result })
        .from(agentTasks)
        .where(eq(agentTasks.id, t2.id))
    )[0];
    // T2 must be resolved to a terminal state (never 'todo' forever) since
    // its only dependency can never become 'done'.
    expect(t2Row?.status).toBe('blocked');
    expect(t2Row?.result).toBeTruthy();

    const complete = await checkRootJobComplete(rootJob.id as JobId, db);
    expect(complete).toBe(true);

    const rootRow = (
      await db
        .select({
          completedAt: agentJobs.completedAt,
          status: agentJobs.status,
          result: agentJobs.result,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, rootJob.id))
    )[0];
    // The root must actually get delivered — no silent stall.
    expect(rootRow?.completedAt).not.toBeNull();
    expect(rootRow?.status).toBe('failed'); // no task succeeded, both T1 and T2 are 'blocked'
    expect(rootRow?.result).toContain('[blocked]');
  });
});
