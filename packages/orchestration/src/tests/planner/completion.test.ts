// planner/completion.test.ts — checkRootJobComplete DB tests

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentTasks, agentJobs } from '@nodalai/db';
import { checkRootJobComplete } from '../../planner/completion';
import type { JobId } from '../../types';
import type { TestDb } from '@nodalai/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodalai/db')).users)
    .values({ email: `test-cmp-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-cmp-${Date.now()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Comp Agent',
      slug: `test-comp-agent-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
    })
    .returning();
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: agent!.id,
      channel: 'api',
      task: 'root job',
      status: 'processing',
    })
    .returning();
  return { entityId: entity!.id, agentId: agent!.id, jobId: job!.id };
}

async function createTask(
  db: TestDb,
  entityId: string,
  agentId: string,
  jobId: string,
  status: string,
) {
  const [task] = await db
    .insert(agentTasks)
    .values({
      entityId,
      orchestratorId: agentId,
      title: `Task ${status} ${Date.now()}`,
      status,
      rootJobId: jobId,
    })
    .returning();
  return task!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('checkRootJobComplete', () => {
  it('returns false when no tasks exist for root_job_id', async () => {
    const { jobId } = await seedContext(db);
    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(false);
  });

  it('returns false when any task is still todo', async () => {
    const { entityId, agentId, jobId } = await seedContext(db);
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'todo'); // still pending

    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(false);
  });

  it('returns false when any task is in_progress', async () => {
    const { entityId, agentId, jobId } = await seedContext(db);
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'in_progress');

    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(false);
  });

  it('returns true when all tasks are done', async () => {
    const { entityId, agentId, jobId } = await seedContext(db);
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'done');

    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(true);
  });

  it('returns true when tasks are mix of done/cancelled/blocked (all terminal)', async () => {
    const { entityId, agentId, jobId } = await seedContext(db);
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'cancelled');
    await createTask(db, entityId, agentId, jobId, 'blocked');

    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(true);
  });

  it('returns false for a mix of terminal and non-terminal', async () => {
    const { entityId, agentId, jobId } = await seedContext(db);
    await createTask(db, entityId, agentId, jobId, 'done');
    await createTask(db, entityId, agentId, jobId, 'todo'); // non-terminal

    const result = await checkRootJobComplete(jobId as JobId, db);
    expect(result).toBe(false);
  });
});
