// router/delegate.test.ts — handleDelegation DB tests
// Asserts on real DB rows.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs } from '@nodal-agents/db';
import { handleDelegation } from '../../router/delegate';
import { OrchestrationError } from '../../errors';
import type { AgentId, JobId, AgentJob, EntityId } from '../../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodal-agents/db')).users)
    .values({ email: `test-d-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodal-agents/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-d-${Date.now()}` })
    .returning();

  const [orch] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Orchestrator',
      slug: `test-orch-d-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();

  const [worker] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Worker D',
      slug: `test-worker-d-${Date.now()}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();

  const [parentJob] = await db
    .insert(agentJobs)
    .values({
      entityId: entity!.id,
      agentId: orch!.id,
      channel: 'api',
      task: 'parent task',
      status: 'processing',
      messages: [{ role: 'user', content: 'parent task' }],
    })
    .returning();

  return {
    entityId: entity!.id,
    orchId: orch!.id,
    workerId: worker!.id,
    workerSlug: worker!.slug,
    parentJobId: parentJob!.id,
  };
}

function makeParentJob(
  id: string,
  agentId: string,
  entityId: string,
  chatId: string | null = null,
): AgentJob {
  return {
    id: id as JobId,
    agentId: agentId as AgentId,
    entityId: entityId as EntityId,
    status: 'processing',
    messages: [{ role: 'user', content: 'parent task' }],
    pendingDelegation: null,
    chainCount: 0,
    delegationDepth: 0,
    parentJobId: null,
    task: 'parent task',
    channel: 'api',
    chatId,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('handleDelegation', () => {
  it('suspends parent to awaiting_delegation', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);

    await handleDelegation(
      parentJob,
      workerSlug,
      'tu_test_001',
      { task: 'do work for child' },
      [],
      db,
    );

    const [updatedParent] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId));

    expect(updatedParent?.status).toBe('awaiting_delegation');
  });

  it('persists parent messages — without this, resume sees only the tool-result and the LLM has no context', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    // Parent is mid-loop: it has the original user task AND its own
    // tool-call assistant message in memory. Both must survive the suspend
    // so the next executeJob entry sees the full conversation.
    const parentJob = {
      ...makeParentJob(parentJobId, orchId, entityId),
      messages: [
        { role: 'user', content: 'do X via worker' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tu_msg_persist',
              toolName: 'assign_worker',
              args: { task: 'X' },
            },
          ],
        },
      ],
    };

    await handleDelegation(parentJob, workerSlug, 'tu_msg_persist', { task: 'X' }, [], db);

    const [updatedParent] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId));

    const msgs = updatedParent?.messages as Array<{ role: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[1]?.role).toBe('assistant');
  });

  it('creates a child job with parent_job_id set', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);

    const result = await handleDelegation(
      parentJob,
      workerSlug,
      'tu_test_002',
      { task: 'child work' },
      [],
      db,
    );

    const [childRow] = await db
      .select({
        parentJobId: agentJobs.parentJobId,
        channel: agentJobs.channel,
        status: agentJobs.status,
        delegationDepth: agentJobs.delegationDepth,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, result.childJobId as string));

    expect(childRow).toBeDefined();
    expect(childRow?.parentJobId).toBe(parentJobId);
    expect(childRow?.channel).toBe('internal');
    expect(childRow?.status).toBe('pending');
    expect(childRow?.delegationDepth).toBe(1); // parent depth 0 + 1
  });

  it('stores pending_delegation with toolUseId and subJobId', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);
    const toolUseId = 'tu_test_003';

    const result = await handleDelegation(
      parentJob,
      workerSlug,
      toolUseId,
      { task: 'check inventory' },
      [],
      db,
    );

    const [parentRow] = await db
      .select({ pendingDelegation: agentJobs.pendingDelegation })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId));

    const pending = parentRow?.pendingDelegation as {
      toolUseId: string;
      subJobId: string;
      type: string;
    } | null;

    expect(pending).not.toBeNull();
    expect(pending?.toolUseId).toBe(toolUseId);
    expect(pending?.subJobId).toBe(result.childJobId);
    expect(pending?.type).toBe('single');
  });

  it('propagates chatId from parent to child', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId, '12345678');

    const result = await handleDelegation(
      parentJob,
      workerSlug,
      'tu_test_004',
      { task: 'needs chat id' },
      [],
      db,
    );

    const [childRow] = await db
      .select({ chatId: agentJobs.chatId })
      .from(agentJobs)
      .where(eq(agentJobs.id, result.childJobId as string));

    expect(childRow?.chatId).toBe('12345678');
  });

  it('includes sideToolResults in pending_delegation when provided', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);

    const sideResults = [
      {
        type: 'tool_result' as const,
        tool_use_id: 'tu_deferred_001',
        content: 'Deferred — another handoff in this turn took priority.',
        is_error: true,
      },
    ];

    await handleDelegation(
      parentJob,
      workerSlug,
      'tu_test_005',
      { task: 'main work' },
      sideResults,
      db,
    );

    const [parentRow] = await db
      .select({ pendingDelegation: agentJobs.pendingDelegation })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId));

    const pending = parentRow?.pendingDelegation as {
      sideToolResults?: typeof sideResults;
    } | null;

    expect(pending?.sideToolResults).toHaveLength(1);
    expect(pending?.sideToolResults?.[0]?.tool_use_id).toBe('tu_deferred_001');
  });

  it('fails loud with delegation_no_entity when the parent job has no entity — not a misleading child_agent_not_found (F-6 follow-up)', async () => {
    // parentJob.entityId is typed EntityId | null. A bare `as string` cast
    // would silently produce `entity_id = NULL` (matches nothing in
    // Postgres), surfacing as child_agent_not_found regardless of whether
    // the child agent actually exists — masking the real problem.
    const { orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJobNoEntity = makeParentJob(parentJobId, orchId, null as unknown as string);

    await expect(
      handleDelegation(
        parentJobNoEntity,
        workerSlug,
        'tu_test_no_entity',
        { task: 'should fail loud' },
        [],
        db,
      ),
    ).rejects.toThrow(OrchestrationError);

    try {
      await handleDelegation(
        parentJobNoEntity,
        workerSlug,
        'tu_test_no_entity_2',
        { task: 'should fail loud' },
        [],
        db,
      );
      expect.unreachable('handleDelegation should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as InstanceType<typeof OrchestrationError>).code).toBe('delegation_no_entity');
    }
  });

  it('resolves the child agent within the PARENT job entity — not another entity sharing the same slug (F-6, audit #2)', async () => {
    // agents.slug is now unique per (entity_id, slug), not globally — two
    // entities can legitimately have a worker with the same slug. An
    // unscoped lookup would resolve to whichever row Postgres happens to
    // return, letting entity A's job delegate into entity B's agent.
    const { entityId: entityA, orchId: orchA, parentJobId } = await seedContext(db);
    const sharedSlug = `shared-worker-slug-${Date.now()}`;

    // Rename entity A's own worker to the shared slug so it's the "right"
    // target, then create an unrelated entity B with a DIFFERENT agent using
    // the SAME slug.
    const [ownWorker] = await db
      .insert(agents)
      .values({
        entityId: entityA,
        name: 'Entity A Shared-Slug Worker',
        slug: sharedSlug,
        personality: 'p',
        role: 'agent',
        active: true,
      })
      .returning();

    const [userB] = await db
      .insert((await import('@nodal-agents/db')).users)
      .values({ email: `test-d-b-${Date.now()}@ex.com` })
      .returning();
    const [entityB] = await db
      .insert((await import('@nodal-agents/db')).entities)
      .values({ userId: userB!.id, name: 'T-B', slug: `e-d-b-${Date.now()}` })
      .returning();
    const [otherWorker] = await db
      .insert(agents)
      .values({
        entityId: entityB!.id,
        name: 'Entity B Shared-Slug Worker',
        slug: sharedSlug,
        personality: 'p',
        role: 'agent',
        active: true,
      })
      .returning();

    const parentJob = makeParentJob(parentJobId, orchA, entityA);

    const result = await handleDelegation(
      parentJob,
      sharedSlug,
      'tu_test_cross_entity',
      { task: 'must stay in entity A' },
      [],
      db,
    );

    const [childRow] = await db
      .select({ agentId: agentJobs.agentId, entityId: agentJobs.entityId })
      .from(agentJobs)
      .where(eq(agentJobs.id, result.childJobId as string));

    expect(childRow?.agentId).toBe(ownWorker!.id);
    expect(childRow?.agentId).not.toBe(otherWorker!.id);
    expect(childRow?.entityId).toBe(entityA);
  });

  it('throws OrchestrationError if child agent slug does not exist', async () => {
    const { entityId, orchId, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);

    await expect(
      handleDelegation(parentJob, 'no-such-agent-slug', 'tu_missing', { task: 'work' }, [], db),
    ).rejects.toThrow(OrchestrationError);
  });

  it('child task includes data from prior step when provided', async () => {
    const { entityId, orchId, workerSlug, parentJobId } = await seedContext(db);
    const parentJob = makeParentJob(parentJobId, orchId, entityId);

    const result = await handleDelegation(
      parentJob,
      workerSlug,
      'tu_test_006',
      { task: 'process this', data: 'spreadsheet rows here...' },
      [],
      db,
    );

    const [childRow] = await db
      .select({ task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.id, result.childJobId as string));

    expect(childRow?.task).toContain('process this');
    expect(childRow?.task).toContain('spreadsheet rows here...');
  });
});
