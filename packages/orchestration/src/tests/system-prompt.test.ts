// system-prompt.test.ts — buildSystemPrompt tests

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodalai/db/test-utils';
import { agents, agentAssignments, agentSkillAssignments, agentSkills } from '@nodalai/db';
import { buildSystemPrompt } from '../system-prompt';
import type { JobContext } from '../system-prompt';
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

    const skillContent =
      'When asked to read or write a Google Sheet, use the gsheets_read or gsheets_write tool with the spreadsheet ID from the request.';
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Google Sheets',
        slug: `google-sheets-sp-${Date.now()}`,
        content: skillContent,
      })
      .returning();

    await db.insert(agentSkillAssignments).values({
      entityId,
      agentId: agentRow!.id,
      skillId: skill!.id,
    });

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    // Brique 32: skills inject FULL content under a "## Skills" section, with
    // each skill's instructions under a `### <name>` subheading. Pre-32 only
    // the skill name was emitted in a bullet list — the actual content was
    // silently dropped.
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('### Google Sheets');
    expect(prompt).toContain(skillContent);
    // The legacy "Your available adapters" header is gone.
    expect(prompt).not.toContain('Your available adapters');
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

  // ─── Brique 31: jobContext block tests ─────────────────────────────────────

  it('appends ## Job context block with telegramChatId when jobContext is provided', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP JC Agent',
        slug: `test-sp-jc-${Date.now()}`,
        personality: 'You use context.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const jobContext: JobContext = { origin: 'telegram', telegramChatId: '99887766' };
    const prompt = await buildSystemPrompt(agent, db, jobContext);

    expect(prompt).toContain('## Job context');
    expect(prompt).toContain('- origin: telegram');
    expect(prompt).toContain('- telegram_chat_id: 99887766');
  });

  it('appends ## Job context with origin only when telegramChatId is absent', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP JC No Chat Agent',
        slug: `test-sp-jc-nochat-${Date.now()}`,
        personality: 'You use context.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const jobContext: JobContext = { origin: 'api' };
    const prompt = await buildSystemPrompt(agent, db, jobContext);

    expect(prompt).toContain('## Job context');
    expect(prompt).toContain('- origin: api');
    expect(prompt).not.toContain('telegram_chat_id');
  });

  it('does NOT include ## Job context when jobContext is not provided', async () => {
    const { entityId } = await seedContext(db);
    const [agentRow] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'SP No JC Agent',
        slug: `test-sp-nojc-${Date.now()}`,
        personality: 'You are standalone.',
        role: 'agent',
      })
      .returning();

    const agent = makeAgent(agentRow!.id, entityId, agentRow!.personality);
    const prompt = await buildSystemPrompt(agent, db);

    expect(prompt).not.toContain('## Job context');
  });
});
