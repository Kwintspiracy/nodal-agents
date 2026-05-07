// handler.test.ts — handleTelegramUpdate creates jobs from updates,
// filters group chat noise, and routes /ask <slug> to the right agent.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import type { TelegramUpdate } from '@nodalai/delivery';
import { handleTelegramUpdate } from '../../telegram/handler.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

function privateMessage(text: string, chatId = 555): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, first_name: 'Alice', username: 'alice', is_bot: false },
      text,
    },
  };
}

function groupMessage(text: string, opts: { replyToBot?: boolean } = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100123, type: 'group' },
      from: { id: 7, first_name: 'Alice', is_bot: false },
      text,
      ...(opts.replyToBot ? { reply_to_message: { from: { is_bot: true } } } : {}),
    },
  };
}

describe('handleTelegramUpdate — private chats', () => {
  it('creates a telegram-channel job for the receiving agent', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('hello world', 999),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('telegram');
    expect(job?.task).toBe('hello world');
    expect(job?.chatId).toBe('999');
    expect(job?.agentId).toBe(seed.agentId);
    expect(job?.entityId).toBe(seed.entityId);
  });

  it('skips updates with no message body', async () => {
    const result = await handleTelegramUpdate({
      update: { update_id: 2 },
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'no_message' });
  });

  it('skips messages with no text', async () => {
    const result = await handleTelegramUpdate({
      update: {
        update_id: 3,
        message: { message_id: 1, chat: { id: 555, type: 'private' } },
      },
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'no_text' });
  });
});

describe('handleTelegramUpdate — group chats', () => {
  it('skips plain text in group chats (no command, no bot reply, no mention)', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('just chatting'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });

  it('handles a reply to the bot in a group chat', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('thanks for the answer', { replyToBot: true }),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    // Group messages get the sender prefix so the agent knows who said what
    expect(job?.task).toContain('[Message from Alice');
    expect(job?.task).toContain('thanks for the answer');
  });

  it('handles @mention in a group chat (case-insensitive, mention stripped)', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@Test_Bot dis bonjour'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain('[Message from Alice');
    // The mention itself must be stripped — only the actual ask remains
    expect(job?.task).toContain('dis bonjour');
    expect(job?.task).not.toContain('@Test_Bot');
    expect(job?.task).not.toContain('@test_bot');
  });

  it('skips @mention with no payload (just "@bot")', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@test_bot'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'mention_no_text' });
  });

  it('falls back to group_filter when bot username is unknown', async () => {
    // Bot configured but getMe never resolved username — should ignore
    // mention-shaped text rather than misroute it.
    const result = await handleTelegramUpdate({
      update: groupMessage('@some_other_bot do something'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: null,
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });
});

describe('handleTelegramUpdate — /ask command', () => {
  it('routes /ask <slug> <text> to the named agent in the same entity', async () => {
    // Seed a second agent the user might want to /ask
    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Other',
        slug: `ask-target-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    expect(otherAgent).toBeDefined();

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${otherAgent!.slug} what is the time`),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('what is the time');
  });

  it('skips /ask with no text payload', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('/ask agent-x'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'ask_no_text' });
  });

  it('skips /ask <unknown-slug> rather than blindly creating a job', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('/ask not-a-real-agent please help'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });

  it('refuses /ask <slug> when the slug belongs to a different entity', async () => {
    // Seed a user/entity/agent in a separate entity
    const [otherUser] = await db
      .insert((await import('@nodalai/db')).users)
      .values({ email: `ext-${Date.now()}@example.com` })
      .returning();
    const [otherEntity] = await db
      .insert((await import('@nodalai/db')).entities)
      .values({
        userId: otherUser!.id,
        name: 'Other Entity',
        slug: `ext-entity-${Date.now()}`,
      })
      .returning();
    const [foreignAgent] = await db
      .insert(agents)
      .values({
        entityId: otherEntity!.id,
        name: 'Foreign',
        slug: `foreign-${Date.now()}`,
        personality: 'I belong elsewhere.',
      })
      .returning();

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${foreignAgent!.slug} hello`),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    // Cross-entity routing must be denied — agents in another workspace are
    // not reachable.
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });
});
