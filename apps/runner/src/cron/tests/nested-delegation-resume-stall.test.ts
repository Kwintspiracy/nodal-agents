// cron/tests/nested-delegation-resume-stall.test.ts
// Audit finding OR-5 (#15/#16): nested planner delegation stall.
//
// Scenario: A (orchestrator) delegates inline to B (also an orchestrator).
// B fans out via create_task and suspends with its own status staying
// 'processing' (executeJob returns 'awaiting_tasks' to A without touching
// B's DB row further) — A is left `awaiting_delegation` waiting on B
// (handleDelegation already persisted that). B's tasks later finish via the
// cron (executeReadyTasks / unblockReadyTasks) and B itself is finalized
// directly by deliverCompletedRoots, which updates B's agent_jobs row via a
// raw UPDATE — NOT via runJob/executeJob. Since maybeResumeParent is only
// invoked from executeJob's wrapper (on completed/failed/cancelled), and
// deliverCompletedRoots never calls it, A should stay stuck in
// 'awaiting_delegation' forever unless deliverCompletedRoots also resumes it.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import { deliverCompletedRoots } from '../deliver-results.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

describe('OR-5: a child finalized by the cron must resume its awaiting_delegation parent', () => {
  it('A delegates inline to B; B fans out via create_task and is finalized by deliverCompletedRoots; A must be resumed (not left awaiting_delegation forever)', async () => {
    // B: the delegated child, itself a planner orchestrator that fanned out.
    // Its own DB row stays 'processing' the way executeJob leaves it when it
    // returns 'awaiting_tasks' to its caller (see execute.ts ~2917-2931).
    const [childB] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 'do the sub-work',
        status: 'processing',
        completedAt: null,
        messages: [{ role: 'user', content: 'do the sub-work' }],
      })
      .returning();
    if (!childB) throw new Error('failed to seed child B');

    // A: the parent, suspended exactly as handleDelegation leaves it —
    // awaiting_delegation with a realistic pending_delegation payload
    // pointing at B's toolUseId/toolName/subJobId.
    const [parentA] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'do the whole thing',
        status: 'awaiting_delegation',
        pendingDelegation: {
          type: 'single',
          toolUseId: 'tu-nested-1',
          toolName: 'assign_worker',
          subJobId: childB.id,
        },
        messages: [{ role: 'user', content: 'do the whole thing' }],
      })
      .returning();
    if (!parentA) throw new Error('failed to seed parent A');

    // Link B → A (B is A's delegated child).
    await db.update(agentJobs).set({ parentJobId: parentA.id }).where(eq(agentJobs.id, childB.id));

    // B's own task board: one task, already done — B is ready to be
    // finalized by the cron.
    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'Sub-task done by B',
      status: 'done',
      result: 'sub-task result',
      rootJobId: childB.id,
    });

    // Run several cron ticks (deliverCompletedRoots is the phase under test).
    for (let i = 0; i < 3; i++) {
      await deliverCompletedRoots(db);
    }

    // B must be finalized (completedAt set, status derived from its tasks).
    const bRow = (
      await db
        .select({ status: agentJobs.status, completedAt: agentJobs.completedAt })
        .from(agentJobs)
        .where(eq(agentJobs.id, childB.id))
    )[0];
    expect(bRow?.completedAt).not.toBeNull();
    expect(bRow?.status).toBe('completed');

    // A must have been resumed: flipped out of awaiting_delegation back to
    // 'pending' (ready for the next cron pass / triggerWorker to re-drive
    // it), with the child's result injected as a tool_result and
    // pending_delegation cleared. Left stuck in 'awaiting_delegation' is
    // exactly the silent stall this finding describes.
    const aRow = (
      await db
        .select({
          status: agentJobs.status,
          pendingDelegation: agentJobs.pendingDelegation,
          messages: agentJobs.messages,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, parentA.id))
    )[0];
    expect(aRow?.status).toBe('pending');
    expect(aRow?.pendingDelegation).toBeNull();
    const messages = aRow?.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
  });
});

describe('OR-5 hardening: a maybeResumeParent failure on one root must not abort delivery of other roots', () => {
  it('root C has a parent with malformed pending_delegation (resume throws); root D is independent — both still get delivered in the same tick', async () => {
    // P: a parent stuck awaiting_delegation with a MALFORMED pending_delegation
    // (no toolUseId) — resumeDelegated throws OrchestrationError
    // ('missing_tool_use_id') for this shape. maybeResumeParent does not catch
    // that itself; without a try/catch around the call in deliverCompletedRoots,
    // this throw would abort the `for` loop mid-tick and starve every root
    // that comes after it.
    const [parentP] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'parent with malformed pending delegation',
        status: 'awaiting_delegation',
        pendingDelegation: { type: 'single' }, // missing toolUseId/toolName/subJobId
        messages: [{ role: 'user', content: 'parent with malformed pending delegation' }],
      })
      .returning();
    if (!parentP) throw new Error('failed to seed parent P');

    const [childC] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: 'child C',
        status: 'processing',
        completedAt: null,
        parentJobId: parentP.id,
        messages: [],
      })
      .returning();
    if (!childC) throw new Error('failed to seed child C');

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'C task',
      status: 'done',
      result: 'C result',
      rootJobId: childC.id,
    });

    // D: a fully independent root — no parent at all.
    const [rootD] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'root D',
        status: 'processing',
        completedAt: null,
        messages: [],
      })
      .returning();
    if (!rootD) throw new Error('failed to seed root D');

    await db.insert(agentTasks).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      assignedAgentId: seed.agentId,
      title: 'D task',
      status: 'done',
      result: 'D result',
      rootJobId: rootD.id,
    });

    // Single tick. Both roots are candidates; the malformed-parent resume for
    // C must not prevent D (nor C itself) from being delivered.
    await deliverCompletedRoots(db);

    const cRow = (
      await db
        .select({ status: agentJobs.status, completedAt: agentJobs.completedAt })
        .from(agentJobs)
        .where(eq(agentJobs.id, childC.id))
    )[0];
    expect(cRow?.completedAt).not.toBeNull();
    expect(cRow?.status).toBe('completed');

    const dRow = (
      await db
        .select({ status: agentJobs.status, completedAt: agentJobs.completedAt })
        .from(agentJobs)
        .where(eq(agentJobs.id, rootD.id))
    )[0];
    expect(dRow?.completedAt).not.toBeNull();
    expect(dRow?.status).toBe('completed');

    // P's resume attempt failed (malformed payload) — it's simply left as-is,
    // not silently marked resumed.
    const pRow = (
      await db.select({ status: agentJobs.status }).from(agentJobs).where(eq(agentJobs.id, parentP.id))
    )[0];
    expect(pRow?.status).toBe('awaiting_delegation');
  });
});
