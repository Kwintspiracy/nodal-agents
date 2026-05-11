// team-block.test.ts — buildTeamBlock DB tests
// Verifies data-driven team block: content reflects DB state, not hardcoded slugs.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodalai/db';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import { buildTeamBlock } from '../team-block';
import type { AgentId } from '../types';
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
    .values({ email: `test-tb-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-tb-${Date.now()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

async function seedAgent(
  db: TestDb,
  entityId: string,
  slug: string,
  role: 'agent' | 'orchestrator' = 'orchestrator',
  orchestratorMode?: 'router' | 'planner',
) {
  const [a] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Agent ${slug}`,
      slug,
      personality: 'p',
      role,
      orchestratorMode: orchestratorMode ?? null,
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

describe('buildTeamBlock', () => {
  it('returns empty string for agent with no children (worker)', async () => {
    const { entityId } = await seedContext(db);
    const worker = await seedAgent(db, entityId, `test-worker-tb-${Date.now()}`, 'agent');
    const block = await buildTeamBlock(worker.id as AgentId, db);
    expect(block).toBe('');
  });

  it('returns empty string when orchestrator has no assigned children', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(db, entityId, `test-orch-tb-no-children-${Date.now()}`);
    const block = await buildTeamBlock(orch.id as AgentId, db);
    expect(block).toBe('');
  });

  it('contains agent names from DB (not hardcoded)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-tb-names-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w1 = await seedAgent(db, entityId, `test-widget-bot-${Date.now()}`, 'agent');
    const w2 = await seedAgent(db, entityId, `test-data-fetcher-${Date.now()}`, 'agent');

    await assignChild(db, orch.id, w1.id, entityId);
    await assignChild(db, orch.id, w2.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // Names come from DB — reflect the actual names we seeded
    expect(block).toContain(`Agent test-widget-bot`);
    expect(block).toContain(`Agent test-data-fetcher`);
  });

  it('reflects DB state change (description update)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-tb-update-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const worker = await seedAgent(db, entityId, `test-updateable-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, worker.id, entityId, 'Original instruction');

    const block1 = await buildTeamBlock(orch.id as AgentId, db);
    expect(block1).toContain('Original instruction');

    // Update instructions in DB
    await db
      .update(agentAssignments)
      .set({ instructions: 'Updated instruction — changed in DB' })
      .where(eq(agentAssignments.subAgentId, worker.id));

    // Re-call — must reflect the new DB state (data-driven, never cached)
    const block2 = await buildTeamBlock(orch.id as AgentId, db);
    expect(block2).toContain('Updated instruction — changed in DB');
    expect(block2).not.toContain('Original instruction');
  });

  it('generates assign_* tool references for router mode', async () => {
    const { entityId } = await seedContext(db);
    const subOrch = await seedAgent(db, entityId, `test-sub-orch-${Date.now()}`, 'orchestrator');
    const orch = await seedAgent(db, entityId, `test-orch-router-${Date.now()}`, 'orchestrator');
    await assignChild(db, orch.id, subOrch.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);
    // Router mode: should reference assign_* tools
    expect(block).toContain('assign_');
    expect(block).toContain('router orchestrator');
  });

  it('generates assigned_to references for planner mode', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-planner-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-worker-planner-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);
    expect(block).toContain('assigned_to');
    expect(block).toContain('planning orchestrator');
  });

  it('includes skill names from DB in team block', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-skills-tb-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-skill-worker-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Special Analytics Tool',
        slug: `analytics-tb-${Date.now()}`,
        content: 'Analytics skill content',
      })
      .returning();
    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: w.id,
      skillId: skill!.id,
    });

    const block = await buildTeamBlock(orch.id as AgentId, db);
    expect(block).toContain('Special Analytics Tool');
  });

  it('includes sub-agent connector tools so the orchestrator can route Airtable/Notion/etc requests', async () => {
    // Regression for Brique 34bis follow-up: pre-fix, Conciergus (orchestrator)
    // answered "I don't have Airtable access" directly when asked to list bases
    // instead of delegating to Summarizus who had Airtable assigned. The team
    // block must now expose each child's connector tool inventory so the
    // orchestrator can route correctly.
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-conn-tools-${Date.now()}`,
      'orchestrator',
      'router',
    );
    const w = await seedAgent(db, entityId, `test-conn-worker-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    // Seed a connector + credential + assignment for the worker (notion-oauth
    // is in ADAPTER_REGISTRY so the team block should surface its tools).
    const { connectors, credentials, agentConnectorAssignments } = await import('@nodalai/db');
    const [cred] = await db
      .insert(credentials)
      .values({
        ownerUserId: (await import('@nodalai/db')).users
          ? // re-fetch user id via the seedContext output not available here — query via entityId
            (
              await db
                .select({ id: (await import('@nodalai/db')).entities.userId })
                .from((await import('@nodalai/db')).entities)
                .where(eq((await import('@nodalai/db')).entities.id, entityId))
            )[0]!.id
          : '00000000-0000-0000-0000-000000000000',
        name: 'Test Notion Cred',
        type: 'notion-oauth',
        payload: 'enc:v1:fake',
      })
      .returning();
    const [conn] = await db
      .insert(connectors)
      .values({
        entityId,
        slug: 'notion-oauth',
        name: 'Notion (OAuth)',
        authType: 'oauth2',
        active: true,
        credentialId: cred!.id,
      })
      .returning();
    await db.insert(agentConnectorAssignments).values({
      agentId: w.id,
      connectorId: conn!.id,
      entityId,
      enabledOperations: null, // all enabled
    });

    const block = await buildTeamBlock(orch.id as AgentId, db);
    // Block must surface the connector slug AND at least one notion tool name
    // so the orchestrator's LLM knows the worker can do this work.
    expect(block).toContain('Tools:');
    expect(block).toContain('notion-oauth');
    expect(block).toMatch(/notion_/); // at least one notion_* tool slug
  });

  it('does not contain hardcoded agent slugs (invariant 1 spot-check)', async () => {
    const { entityId } = await seedContext(db);
    const orch = await seedAgent(
      db,
      entityId,
      `test-orch-inv1-${Date.now()}`,
      'orchestrator',
      'planner',
    );
    const w = await seedAgent(db, entityId, `test-worker-inv1-${Date.now()}`, 'agent');
    await assignChild(db, orch.id, w.id, entityId);

    const block = await buildTeamBlock(orch.id as AgentId, db);

    // The block content should come from DB — synthetic slugs, not legacy hardcoded names
    const FORBIDDEN = ['ender', 'pavel', 'boris', 'jennie', 'stanley', 'sherlock'];
    for (const slug of FORBIDDEN) {
      expect(block.toLowerCase()).not.toContain(slug);
    }
  });
});
