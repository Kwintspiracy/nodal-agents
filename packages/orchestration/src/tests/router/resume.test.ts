// router/resume.test.ts — resumeDelegated DB tests
// Asserts on real DB message rows.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodalai/db';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentJobs } from '@nodalai/db';
import { resumeDelegated } from '../../router/resume';
import { OrchestrationError } from '../../errors';
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
    .values({ email: `test-r-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-r-${Date.now()}` })
    .returning();

  const [orch] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Orch R',
      slug: `test-orch-r-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();

  return { entityId: entity!.id, orchId: orch!.id };
}

async function seedParentJob(
  db: TestDb,
  entityId: string,
  agentId: string,
  toolUseId: string,
  childJobId: string,
  sideToolResults?: Array<{
    type: string;
    tool_use_id: string;
    toolName?: string;
    content: string;
  }>,
) {
  const pendingDelegation: Record<string, unknown> = {
    type: 'single',
    toolUseId,
    toolName: 'assign_test_agent',
    subJobId: childJobId,
  };
  if (sideToolResults && sideToolResults.length > 0) {
    pendingDelegation['sideToolResults'] = sideToolResults;
  }

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'api',
      task: 'parent task',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'parent task' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: `assign_test_agent`, input: {} }],
        },
      ],
      pendingDelegation,
    })
    .returning();
  return job!;
}

async function seedChildJob(db: TestDb, entityId: string, agentId: string, parentJobId?: string) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'internal',
      task: 'child task',
      status: 'completed',
      ...(parentJobId ? { parentJobId } : {}),
    })
    .returning();
  return job!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('resumeDelegated', () => {
  it('injects tool_result with correct tool_use_id into parent messages', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_001';
    const childResult = 'The analysis is complete.';

    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, childResult, db);

    const [updatedParent] = await db
      .select({ messages: agentJobs.messages, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    expect(updatedParent?.status).toBe('pending');

    // The last message should be a tool-role message with tool-result parts
    // (AI SDK v4 CoreMessage format).
    const msgs = updatedParent?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.role).toBe('tool');

    const content = lastMsg?.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
      result?: unknown;
    }>;
    expect(Array.isArray(content)).toBe(true);

    const toolResult = content.find((b) => b.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolCallId).toBe(toolUseId);
    expect(toolResult?.toolName).toBe('assign_test_agent');
    expect(toolResult?.result).toBe(childResult);
  });

  it('sets parent status back to pending', async () => {
    const { entityId, orchId } = await seedContext(db);
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, 'tu_resume_002', childJob.id);

    const updatedJob = await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      'child result',
      db,
    );

    expect(updatedJob.status).toBe('pending');
  });

  it('clears pending_delegation after resume', async () => {
    const { entityId, orchId } = await seedContext(db);
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, 'tu_resume_003', childJob.id);

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, 'result', db);

    const [row] = await db
      .select({ pendingDelegation: agentJobs.pendingDelegation })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    expect(row?.pendingDelegation).toBeNull();
  });

  it('includes sideToolResults in the injected tool message (message-integrity)', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_004';
    const sideResults = [
      {
        type: 'tool_result',
        tool_use_id: 'tu_deferred_side',
        toolName: 'assign_other_agent',
        content: 'Deferred — another handoff took priority',
      },
    ];

    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(
      db,
      entityId,
      orchId,
      toolUseId,
      childJob.id,
      sideResults,
    );

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, 'main result', db);

    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    const msgs = row?.messages as Array<{ role: string; content: unknown }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.role).toBe('tool');
    const content = lastMsg?.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
    }>;

    // Should have both: main tool-result + side tool-result
    expect(content).toHaveLength(2);
    const sideResult = content.find((b) => b.toolCallId === 'tu_deferred_side');
    expect(sideResult).toBeDefined();
    expect(sideResult?.toolName).toBe('assign_other_agent');
  });

  it('throws OrchestrationError if parent not found', async () => {
    await expect(
      resumeDelegated(
        '00000000-0000-0000-0000-000000000001' as JobId,
        '00000000-0000-0000-0000-000000000002' as JobId,
        'result',
        db,
      ),
    ).rejects.toThrow(OrchestrationError);
  });

  it('throws OrchestrationError if parent is not awaiting_delegation', async () => {
    const { entityId, orchId } = await seedContext(db);
    // Create a job that is NOT awaiting_delegation
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: orchId,
        channel: 'api',
        task: 'processing job',
        status: 'processing', // wrong status
        pendingDelegation: { toolUseId: 'tu_bad', subJobId: 'some-id', type: 'single' },
      })
      .returning();

    await expect(
      resumeDelegated(job!.id as JobId, 'some-child-id' as JobId, 'result', db),
    ).rejects.toThrow(OrchestrationError);
  });
});
