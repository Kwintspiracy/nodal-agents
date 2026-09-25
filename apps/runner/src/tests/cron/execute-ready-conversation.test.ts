// execute-ready-conversation.test.ts — a task-board child two levels down
// still belongs to the conversation (#469, review of PR #482).
//
// The chat shows the pending approvals of every run that carries the
// conversation's id. Depth 1 of the task-board path is already proven
// (apps/runner/src/cron/tests/execute-ready.test.ts, "inherits conversation_id
// from the CREATOR (root) job"), and the delegation path too (delegate.test.ts).
// What this adds is depth 2: a task created by a task-board child, whose
// approval must still show in the conversation it belongs to.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks, eq } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';

// The child's run itself is not what is proven here: only the row it is born with.
vi.mock('../../job/execute.ts', () => ({
  executeJob: vi.fn(async () => ({ status: 'completed' })),
}));

const { executeReadyTasks } = await import('../../cron/execute-ready.ts');

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

describe('task-board children and the conversation @cap:approuver-une-action/moteur', () => {
  it('a task-board child is born with its creator job conversation_id, at every depth', async () => {
    const conversationId = '66666666-6666-4666-8666-666666666666';
    await db.update(agentJobs).set({ conversationId }).where(eq(agentJobs.id, seed.jobId));
    const deps = { db } as unknown as RunnerDeps;

    // Depth 1: a task created by the root job.
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      title: 'first level',
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      rootJobId: seed.jobId,
      status: 'todo',
    });
    await executeReadyTasks(db as unknown as Parameters<typeof executeReadyTasks>[0], deps);
    const [first] = await db
      .select({ id: agentJobs.id, conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, seed.jobId));
    expect(first?.conversationId).toBe(conversationId);

    // Depth 2: a task created by that child.
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      title: 'second level',
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      rootJobId: first!.id,
      status: 'todo',
    });
    await executeReadyTasks(db as unknown as Parameters<typeof executeReadyTasks>[0], deps);
    const [second] = await db
      .select({ conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, first!.id));
    expect(second?.conversationId).toBe(conversationId);
  });
});
