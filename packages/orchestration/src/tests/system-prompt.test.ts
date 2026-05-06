// system-prompt.test.ts — buildSystemPrompt tests

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import { buildSystemPrompt } from '../system-prompt';
import type { Agent, AgentId, EntityId } from '../types';
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
    .values({ email: `test-sp-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodalai/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-sp-${Date.now()}` })
    .returning();
  return { userId: user!.id, entityId: entity!.id };
}

function makeAgent(
  id: string,
  entityId: string,
  personality: string,
  role: 'agent' | 'orchestrator' = 'agent',
): Agent {
  return {
    id: id as AgentId,
    name: 'Test Agent',
    slug: 'test-agent-sp',
    role,
    personality,
    entityId: entityId as EntityId,
    model: 'claude-sonnet-4-6-20260217',
    active: true,
    orchestratorMode: null,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes personality verbatim (never modified)', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Agent',
        slug: `test-sp-agent-${Date.now()}`,
        personality: 'You are a precise data analyst. Never guess.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).toContain('You are a precise data analyst. Never guess.');
  });

  it('appends team block when orchestrator has children', async () => {
    const { entityId } = await seedContext(db);
    const [orchRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Orchestrator',
        slug: `test-sp-orch-${Date.now()}`,
        personality: 'You coordinate work.',
        role: 'orchestrator',
        orchestratorMode: 'planner',
      })
      .returning();

    const [workerRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Worker',
        slug: `test-sp-worker-${Date.now()}`,
        personality: 'p',
        role: 'agent',
      })
      .returning();

    await db.insert(agentAssignments).values({
      orchestratorId: orchRow!.id,
      subAgentId: workerRow!.id,
      entityId,
    });

    const agent = makeAgent(orchRow!.id, entityId, orchRow!.personality, 'orchestrator');
    agent.orchestratorMode = 'planner';
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).toContain('You coordinate work.'); // personality preserved
    expect(prompt).toContain('Your team'); // team block appended
    expect(prompt).toContain('SP Worker'); // from DB
  });

  it('honours {{team}} placeholder in personality', async () => {
    const { entityId } = await seedContext(db);
    const [orchRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Orch Placeholder',
        slug: `test-sp-orch-ph-${Date.now()}`,
        personality: 'You coordinate.\n\n{{team}}\n\nEnd of personality.',
        role: 'orchestrator',
        orchestratorMode: 'planner',
      })
      .returning();

    const [workerRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Worker PH',
        slug: `test-sp-worker-ph-${Date.now()}`,
        personality: 'p',
        role: 'agent',
      })
      .returning();

    await db.insert(agentAssignments).values({
      orchestratorId: orchRow!.id,
      subAgentId: workerRow!.id,
      entityId,
    });

    const agent = makeAgent(orchRow!.id, entityId, orchRow!.personality, 'orchestrator');
    agent.orchestratorMode = 'planner';
    const prompt = await buildSystemPrompt(agent, db);

    // {{team}} replaced, not appended at end
    expect(prompt).not.toContain('{{team}}');
    expect(prompt).toContain('Your team');
    expect(prompt).toContain('End of personality.');
    // The team block should appear BEFORE "End of personality." (inline replacement)
    const teamIdx = prompt.indexOf('Your team');
    const endIdx = prompt.indexOf('End of personality.');
    expect(teamIdx).toBeLessThan(endIdx);
  });

  it('includes skills metadata block when agent has skills', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Skills Agent',
        slug: `test-sp-skills-${Date.now()}`,
        personality: 'You use tools.',
        role: 'agent',
      })
      .returning();

    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Google Sheets',
        slug: `google-sheets-sp-${Date.now()}`,
        content: 'skill',
      })
      .returning();

    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: agentRow!.id,
      skillId: skill!.id,
    });

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).toContain('Your available adapters');
    expect(prompt).toContain('Google Sheets');
  });

  describe('delivery context block', () => {
    it('omits the "Delivery context" block when no deliveryContext is passed (back-compat)', async () => {
      const { entityId } = await seedContext(db);
      const [agentRow] = await db
        .insert(agents)
        .values({
          entityId,
          name: 'SP Delivery Off',
          slug: `test-sp-deliv-off-${Date.now()}`,
          personality: 'baseline',
          role: 'agent',
        })
        .returning();

      const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
      const prompt = await buildSystemPrompt(agent, db);

      expect(prompt).not.toContain('Delivery context');
    });

    it('adds a Telegram-flavored delivery block for channel="telegram"', async () => {
      const { entityId } = await seedContext(db);
      const [agentRow] = await db
        .insert(agents)
        .values({
          entityId,
          name: 'SP Delivery TG',
          slug: `test-sp-deliv-tg-${Date.now()}`,
          personality: 'baseline',
          role: 'agent',
        })
        .returning();

      const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
      const prompt = await buildSystemPrompt(agent, db, { channel: 'telegram' });

      expect(prompt).toContain('## Delivery context');
      expect(prompt).toContain('Telegram');
      expect(prompt).toContain('return_result');
      // Reassures the LLM that no separate "send" tool is needed
      expect(prompt).toContain('do not need a separate "send" tool');
    });

    it('adds a cron-flavored delivery block for channel="cron"', async () => {
      const { entityId } = await seedContext(db);
      const [agentRow] = await db
        .insert(agents)
        .values({
          entityId,
          name: 'SP Delivery Cron',
          slug: `test-sp-deliv-cron-${Date.now()}`,
          personality: 'baseline',
          role: 'agent',
        })
        .returning();

      const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
      const prompt = await buildSystemPrompt(agent, db, { channel: 'cron' });

      expect(prompt).toContain('## Delivery context');
      expect(prompt).toContain('automated run');
    });

    it('uses parent-orchestrator wording for channel="task-board" (no "user")', async () => {
      const { entityId } = await seedContext(db);
      const [agentRow] = await db
        .insert(agents)
        .values({
          entityId,
          name: 'SP Delivery TB',
          slug: `test-sp-deliv-tb-${Date.now()}`,
          personality: 'baseline',
          role: 'agent',
        })
        .returning();

      const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
      const prompt = await buildSystemPrompt(agent, db, { channel: 'task-board' });

      // Find the delivery context paragraph and assert against just that slice;
      // other parts of the prompt may legitimately mention "user".
      const idx = prompt.indexOf('## Delivery context');
      expect(idx).toBeGreaterThan(-1);
      const deliverySection = prompt.slice(idx);
      expect(deliverySection).toContain('parent orchestrator');
      expect(deliverySection.toLowerCase()).not.toContain('to the user');
    });

    it('falls back to a generic description for an unknown future channel', async () => {
      const { entityId } = await seedContext(db);
      const [agentRow] = await db
        .insert(agents)
        .values({
          entityId,
          name: 'SP Delivery Unknown',
          slug: `test-sp-deliv-unknown-${Date.now()}`,
          personality: 'baseline',
          role: 'agent',
        })
        .returning();

      const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
      const prompt = await buildSystemPrompt(agent, db, { channel: 'unknown-future-channel' });

      expect(prompt).toContain('## Delivery context');
      expect(prompt).toContain('the channel configured for this job');
    });
  });

  it('no team block for worker agent', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP Pure Worker',
        slug: `test-sp-pure-worker-${Date.now()}`,
        personality: 'You execute tasks.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    // No team block for a pure worker
    expect(prompt).not.toContain('Your team');
    expect(prompt).toContain('You execute tasks.'); // personality preserved
  });
});
