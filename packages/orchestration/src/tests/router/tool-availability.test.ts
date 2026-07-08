// router/tool-availability.test.ts — computeAgentToolNames + findUnavailableToolMentions
// Tests:
//   - always-on tools are always present
//   - own telegramBotToken unlocks delivery tools when hasDeliveryRecipient
//   - B3: an agent WITHOUT its own token inherits delivery tools from its
//     entity's root agent's token, when hasDeliveryRecipient is true
//   - skill requiredBuiltins are unioned in
//   - findUnavailableToolMentions: exact-word match, no false positive on
//     plain English, no warning once the tool IS available

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentSkills, agentSkillAssignments, entities, users } from '@nodal-agents/db';
import { computeAgentToolNames, findUnavailableToolMentions } from '../../router/tool-availability';
import type { AgentId, EntityId } from '../../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

async function seedEntityWithAgent(opts: { telegramBotToken?: string | null } = {}) {
  const ts = Date.now() + Math.random();
  const [user] = await db
    .insert(users)
    .values({ email: `test-ta-${ts}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: `e-ta-${ts}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Agent',
      slug: `test-agent-ta-${ts}`,
      personality: 'p',
      role: 'agent',
      active: true,
      telegramBotToken: opts.telegramBotToken ?? null,
    })
    .returning();
  return { entityId: entity!.id as EntityId, agentId: agent!.id as AgentId };
}

describe('computeAgentToolNames', () => {
  it('always includes the always-on tools', async () => {
    const { entityId, agentId } = await seedEntityWithAgent();
    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: false,
    });
    expect(names.has('return_result')).toBe(true);
    expect(names.has('save_memory')).toBe(true);
  });

  it('does NOT include delivery tools when hasDeliveryRecipient is false, even with own token', async () => {
    const { entityId, agentId } = await seedEntityWithAgent({ telegramBotToken: 'own-token' });
    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: false,
    });
    expect(names.has('send_image')).toBe(false);
    expect(names.has('telegram_send_message')).toBe(false);
  });

  it('includes delivery tools when the agent has its own token AND hasDeliveryRecipient', async () => {
    const { entityId, agentId } = await seedEntityWithAgent({ telegramBotToken: 'own-token' });
    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: true,
    });
    expect(names.has('send_image')).toBe(true);
    expect(names.has('telegram_send_message')).toBe(true);
  });

  it('B3: inherits delivery tools from the entity root agent when the agent has no token of its own', async () => {
    const { entityId, agentId } = await seedEntityWithAgent({ telegramBotToken: null });
    // Seed a SEPARATE root agent for the same entity, with its own token.
    const [rootAgent] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Root',
        slug: `root-ta-${Date.now()}`,
        personality: 'p',
        role: 'orchestrator',
        active: true,
        telegramBotToken: 'root-token',
      })
      .returning();
    await db.update(entities).set({ rootAgentId: rootAgent!.id }).where(eq(entities.id, entityId));

    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: true,
    });
    expect(names.has('send_image')).toBe(true);
    expect(names.has('telegram_send_message')).toBe(true);
  });

  it('does NOT inherit across entities', async () => {
    const { entityId, agentId } = await seedEntityWithAgent({ telegramBotToken: null });
    // A DIFFERENT entity's root agent has a token — must not leak in.
    const [otherUser] = await db
      .insert(users)
      .values({ email: `test-ta-other-${Date.now()}@ex.com` })
      .returning();
    const [otherEntity] = await db
      .insert(entities)
      .values({ userId: otherUser!.id, name: 'Other', slug: `e-ta-other-${Date.now()}` })
      .returning();
    const [otherRoot] = await db
      .insert(agents)
      .values({
        entityId: otherEntity!.id,
        name: 'Other Root',
        slug: `other-root-ta-${Date.now()}`,
        personality: 'p',
        role: 'orchestrator',
        active: true,
        telegramBotToken: 'other-root-token',
      })
      .returning();
    await db
      .update(entities)
      .set({ rootAgentId: otherRoot!.id })
      .where(eq(entities.id, otherEntity!.id));

    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: true,
    });
    expect(names.has('send_image')).toBe(false);
  });

  it('unions in a skill assignment requiredBuiltins', async () => {
    const { entityId, agentId } = await seedEntityWithAgent();
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId,
        name: 'Office Skill',
        slug: `office-skill-ta-${Date.now()}`,
        content: 'c',
        requiredBuiltins: ['office_write_docx'],
      })
      .returning();
    await db.insert(agentSkillAssignments).values({ entityId, agentId, skillId: skill!.id });

    const names = await computeAgentToolNames(agentId, entityId, db, {
      hasDeliveryRecipient: false,
    });
    expect(names.has('office_write_docx')).toBe(true);
  });
});

describe('findUnavailableToolMentions', () => {
  it('flags a real tool name that is not in the available set', () => {
    const missing = findUnavailableToolMentions(
      'Once done, call send_image to deliver the chart to the user.',
      new Set(['return_result']),
    );
    expect(missing).toContain('send_image');
  });

  it('does not flag it once it IS available', () => {
    const missing = findUnavailableToolMentions(
      'Once done, call send_image to deliver the chart to the user.',
      new Set(['return_result', 'send_image']),
    );
    expect(missing).toHaveLength(0);
  });

  it('does not flag plain English words (no false positive, no NLP)', () => {
    const missing = findUnavailableToolMentions(
      'Send an image of the dashboard and summarize the images found.',
      new Set(['return_result']),
    );
    expect(missing).toHaveLength(0);
  });

  it('ignores a snake_case word that is not a real tool name', () => {
    const missing = findUnavailableToolMentions(
      'Please double_check the totals before finishing.',
      new Set(['return_result']),
    );
    expect(missing).toHaveLength(0);
  });
});
