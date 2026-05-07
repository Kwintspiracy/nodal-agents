// router/assign-tools.test.ts — generateAssignTools DB tests
// Uses pglite. Assertions on real DB rows, not mock call counts.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import { generateAssignTools } from '../../router/assign-tools';
import { DelegationPendingError } from '../../errors';
import type { AgentId } from '../../types';
import type { TestDb } from '@nodalai/db/test-utils';

let db: TestDb;

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedEntity(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodalai/db')).users)
    .values({ email: `test-at-${Date.now()}@example.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'Test', slug: `e-${Date.now()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

async function seedOrchestrator(db: TestDb, entityId: string, slug: string) {
  const [a] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Orchestrator ${slug}`,
      slug,
      personality: 'test orchestrator',
      role: 'orchestrator',
      active: true,
    })
    .returning();
  return a!;
}

async function seedWorker(db: TestDb, entityId: string, slug: string) {
  const [a] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Worker ${slug}`,
      slug,
      personality: 'test worker',
      role: 'agent',
      active: true,
    })
    .returning();
  return a!;
}

async function assignChild(
  db: TestDb,
  orchestratorId: string,
  subAgentId: string,
  entityId: string,
  instructions?: string,
) {
  await db.insert(agentAssignments).values({
    orchestratorId,
    subAgentId,
    entityId,
    instructions: instructions ?? null,
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

describe('generateAssignTools', () => {
  it('returns empty array when orchestrator has no assigned children', async () => {
    const { entityId } = await seedEntity(db);
    const orchestrator = await seedOrchestrator(db, entityId, `orch-no-children-${Date.now()}`);
    const tools = await generateAssignTools(orchestrator.id as AgentId, db);
    expect(tools).toHaveLength(0);
  });

  it('returns one tool per active assigned child', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-two-${Date.now()}`);
    const w1 = await seedWorker(db, entityId, `test-worker-alpha-${Date.now()}`);
    const w2 = await seedWorker(db, entityId, `test-worker-beta-${Date.now()}`);

    await assignChild(db, orch.id, w1.id, entityId);
    await assignChild(db, orch.id, w2.id, entityId);

    const tools = await generateAssignTools(orch.id as AgentId, db);
    expect(tools).toHaveLength(2);
  });

  it('tool names are assign_<slug> with hyphens replaced by underscores', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-slug-${Date.now()}`);
    const w = await seedWorker(db, entityId, `test-email-sender-${Date.now()}`);
    await assignChild(db, orch.id, w.id, entityId);

    const tools = await generateAssignTools(orch.id as AgentId, db);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toMatch(/^assign_test_email_sender_\d+$/);
    expect(tool.name).not.toContain('-'); // hyphens converted to underscores
  });

  it('tool description is data-driven (not hardcoded)', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-desc-${Date.now()}`);
    const w = await seedWorker(db, entityId, `test-data-bot-${Date.now()}`);
    await assignChild(db, orch.id, w.id, entityId, 'Always check duplicates first');

    const tools = await generateAssignTools(orch.id as AgentId, db);
    const tool = tools[0]!;

    // Description must reference the agent name from DB
    expect(tool.description).toContain('Worker test-data-bot');
    // Instructions from DB must appear
    expect(tool.description).toContain('Always check duplicates first');
  });

  it('tool description includes skill names from DB', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-skills-${Date.now()}`);
    const w = await seedWorker(db, entityId, `test-sheet-worker-${Date.now()}`);
    await assignChild(db, orch.id, w.id, entityId);

    // Add a skill
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'My Custom Skill',
        slug: `custom-skill-${Date.now()}`,
        content: 'skill content',
      })
      .returning();
    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: w.id,
      skillId: skill!.id,
    });

    const tools = await generateAssignTools(orch.id as AgentId, db);
    expect(tools[0]?.description).toContain('My Custom Skill');
  });

  it('tool execute() throws DelegationPendingError (sentinel for runner)', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-exec-${Date.now()}`);
    const slug = `test-sentinel-worker-${Date.now()}`;
    const w = await seedWorker(db, entityId, slug);
    await assignChild(db, orch.id, w.id, entityId);

    const tools = await generateAssignTools(orch.id as AgentId, db);
    const tool = tools[0]!;

    const ctx = {
      jobId: 'test-job-id',
      agentId: orch.id,
      entityId,
      db,
      jobChatId: null,
    };

    await expect(tool.execute({ task: 'do work' }, ctx)).rejects.toThrow(DelegationPendingError);
  });

  it('does not include inactive children', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-inactive-${Date.now()}`);

    // active worker
    const wActive = await seedWorker(db, entityId, `test-active-w-${Date.now()}`);
    // inactive worker
    const [wInactive] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Inactive Worker',
        slug: `test-inactive-w-${Date.now()}`,
        personality: 'p',
        role: 'agent',
        active: false,
      })
      .returning();

    await assignChild(db, orch.id, wActive.id, entityId);
    await assignChild(db, orch.id, wInactive!.id, entityId);

    const tools = await generateAssignTools(orch.id as AgentId, db);
    // Only the active child has a tool
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).not.toContain('inactive');
  });

  it('tool count matches number of active assigned children', async () => {
    const { entityId } = await seedEntity(db);
    const orch = await seedOrchestrator(db, entityId, `orch-count-${Date.now()}`);
    const numChildren = 4;
    for (let i = 0; i < numChildren; i++) {
      const w = await seedWorker(db, entityId, `test-count-worker-${i}-${Date.now()}`);
      await assignChild(db, orch.id, w.id, entityId);
    }

    const tools = await generateAssignTools(orch.id as AgentId, db);
    expect(tools).toHaveLength(numChildren);
  });
});
