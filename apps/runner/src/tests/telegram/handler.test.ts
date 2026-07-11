// handler.test.ts — handleTelegramUpdate creates jobs from updates,
// filters group chat noise, and routes /ask <slug> to the right agent.

import { mkdtemp, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  telegramAllowedChats,
  channelAllowedConversations,
} from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import { handleTelegramUpdate, pruneTelegramWorkspace } from '../../telegram/handler.ts';
import type { RunnerDeps } from '../../deps.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

// The job-creation / routing / filter tests below are not about H-1 authorization
// — so make the chats they use already-authorized, turning the new inbound
// allowlist check into a pass-through for them. The authorization behavior
// itself is covered by its own describe block (with a fresh agent) at the end.
beforeEach(async () => {
  await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  await db.insert(telegramAllowedChats).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '1',
      role: 'owner',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '555',
      role: 'member',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '999',
      role: 'member',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: '-100123',
      role: 'member',
      status: 'active',
    },
  ]);
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

function groupMessage(
  text: string,
  opts: { replyToBot?: boolean; replyToBotUsername?: string } = {},
): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100123, type: 'group' },
      from: { id: 7, first_name: 'Alice', is_bot: false },
      text,
      // A real bot's `from` always carries a username — default to 'test_bot'
      // (the bot username most group-chat tests configure as the receiver)
      // so existing "reply to the bot" tests keep matching by default; F-2
      // tests override it to simulate a reply to a DIFFERENT bot.
      ...(opts.replyToBot
        ? {
            reply_to_message: {
              from: { is_bot: true, username: opts.replyToBotUsername ?? 'test_bot' },
            },
          }
        : {}),
    },
  };
}

/** A fresh agent with an empty telegram_allowed_chats slate, for H-1/F-1/F-4 tests. */
async function freshBot(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Auth Bot',
      slug: `auth-bot-${Date.now()}-${Math.floor(performance.now())}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning({ id: agents.id });
  return row!.id;
}

function dm(text: string, chatId: number): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, first_name: 'Bob', username: 'bob', is_bot: false },
      text,
    },
  };
}

/** Like dm(), but with an attacker-controlled `first_name` — L2 sanitation tests. */
function dmFrom(text: string, chatId: number, firstName: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, first_name: firstName, username: 'someuser', is_bot: false },
      text,
    },
  };
}

/** Like groupMessage(), but with an attacker-controlled `first_name` — L2 sanitation tests. */
function groupMessageFrom(text: string, firstName: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100123, type: 'group' },
      from: { id: 7, first_name: firstName, is_bot: false },
      text,
      reply_to_message: { from: { is_bot: true, username: 'test_bot' } },
    },
  };
}

const call = (agentId: string, update: TelegramUpdate) =>
  handleTelegramUpdate({
    update,
    receivingAgentId: agentId,
    receivingAgentEntityId: seed.entityId,
    receivingAgentBotUsername: 'auth_bot',
    tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
  });

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

describe('handleTelegramUpdate — conversation grouping (migration 0059)', () => {
  it('stamps a conversation_id on a fresh thread', async () => {
    const result = await handleTelegramUpdate({
      update: privateMessage('first message', 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.conversationId).toBeTruthy();
  });

  it('a second message shortly after in the SAME chat inherits the same conversation_id', async () => {
    const first = await handleTelegramUpdate({
      update: privateMessage('are you there?', 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    // Mark the first job completed (delivered) just now, so the gap since
    // delivery is ~0 — well under the idle-reset window.
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: 'yes', completedAt: new Date() })
      .where(eq(agentJobs.id, first.jobId!));

    const second = await handleTelegramUpdate({
      update: privateMessage('good, one more thing', 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

    const [firstJob] = await db.select().from(agentJobs).where(eq(agentJobs.id, first.jobId!));
    const [secondJob] = await db.select().from(agentJobs).where(eq(agentJobs.id, second.jobId!));
    expect(secondJob?.conversationId).toBe(firstJob?.conversationId);
  });

  it("a message in a DIFFERENT chat never inherits another thread's conversation_id", async () => {
    const a = await handleTelegramUpdate({
      update: privateMessage('hello from chat 555', 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    const b = await handleTelegramUpdate({
      update: privateMessage('hello from chat 999', 999),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

    const [jobA] = await db.select().from(agentJobs).where(eq(agentJobs.id, a.jobId!));
    const [jobB] = await db.select().from(agentJobs).where(eq(agentJobs.id, b.jobId!));
    expect(jobA?.conversationId).not.toBe(jobB?.conversationId);
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

  // F-2: a plain substring match would let bot `@news` fire on `@newsroom`.
  it('does NOT trigger on a longer handle that merely starts with the bot name', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@newsroom hello'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'news',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });

  it('DOES trigger on the exact handle, even when a longer one shares the same prefix', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('@news hello'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'news',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain('hello');
    expect(job?.task).not.toContain('@news');
  });

  // F-2: `reply_to_message.from.is_bot` alone can't distinguish which bot —
  // a reply to a DIFFERENT bot's message in the same group must not wake
  // THIS one up.
  it("ignores a reply to a DIFFERENT bot's message in the group", async () => {
    const result = await handleTelegramUpdate({
      update: groupMessage('thanks for that', {
        replyToBot: true,
        replyToBotUsername: 'some_other_bot',
      }),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result).toEqual({ skipped: 'group_filter' });
  });
});

describe('handleTelegramUpdate — F-3 lastSeenChatIdTelegram (private only)', () => {
  it('updates lastSeenChatIdTelegram for a private message but not for a group message', async () => {
    const agentId = await freshBot();
    await db.insert(telegramAllowedChats).values([
      { entityId: seed.entityId, agentId, chatId: '7001', role: 'owner', status: 'active' },
      { entityId: seed.entityId, agentId, chatId: '-7002', role: 'member', status: 'active' },
    ]);

    // Group message first — must NOT touch lastSeenChatIdTelegram.
    const groupResult = await handleTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: -7002, type: 'group' },
          from: { id: 7, first_name: 'Bob', is_bot: false },
          text: '/agents',
        },
      },
      receivingAgentId: agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'auth_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(groupResult.jobId).toBeDefined();
    const [afterGroup] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(afterGroup?.lastSeenChatIdTelegram).toBeNull();

    // Private message — MUST update it.
    const privateResult = await call(agentId, dm('hello', 7001));
    expect(privateResult.jobId).toBeDefined();
    const [afterPrivate] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(afterPrivate?.lastSeenChatIdTelegram).toBe('7001');
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
    // F-1: /ask is now gated by the TARGET agent's own allowlist too — this
    // chat (555, the default privateMessage() chat) must be active for the
    // target, not just for the receiver, for the relay to proceed.
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: otherAgent!.id,
      chatId: '555',
      role: 'member',
      status: 'active',
    });

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

  // F-1: a chat authorized to talk to the RECEIVING agent must not reach a
  // SIBLING agent just by asking the receiver to relay — the sibling's own
  // allowlist gates it independently.
  it('/ask to a sibling the chat has never talked to: NO job, pending member created, owner notified', async () => {
    const targetAgentId = await freshBot();
    // Target already has its own owner, on a DIFFERENT chat than the one asking.
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: targetAgentId,
      chatId: '8001',
      role: 'owner',
      status: 'active',
    });
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    // Chat 555 is active for the RECEIVER (seeded in the top-level beforeEach)
    // but has never talked to the target agent at all.
    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${targetRow!.slug} please help`, 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerChatId: '8001',
      requesterChatId: '555',
      targetAgentName: 'Auth Bot',
    });

    const [pendingRow] = await db
      .select()
      .from(telegramAllowedChats)
      .where(
        and(
          eq(telegramAllowedChats.agentId, targetAgentId),
          eq(telegramAllowedChats.chatId, '555'),
        ),
      );
    expect(pendingRow?.role).toBe('member');
    expect(pendingRow?.status).toBe('pending');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.agentId, targetAgentId));
    expect(jobs).toHaveLength(0);
  });

  it('/ask to a sibling where this chat is already pending on the target: NO job, no re-ask', async () => {
    const targetAgentId = await freshBot();
    await db.insert(telegramAllowedChats).values([
      {
        entityId: seed.entityId,
        agentId: targetAgentId,
        chatId: '8002',
        role: 'owner',
        status: 'active',
      },
      {
        entityId: seed.entityId,
        agentId: targetAgentId,
        chatId: '555',
        role: 'member',
        status: 'pending',
      },
    ]);
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${targetRow!.slug} please help`, 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toBeUndefined(); // no re-spam
  });

  it('/ask to a sibling with NO owner at all: the chat becomes a pending MEMBER, never owner', async () => {
    const targetAgentId = await freshBot(); // zero allowlist rows
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    const result = await handleTelegramUpdate({
      update: privateMessage(`/ask ${targetRow!.slug} please help`, 555),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    // No owner exists to notify — the request still lands pending, silently.
    expect(result.pendingAuth).toBeUndefined();

    const rows = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, targetAgentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('member');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.chatId).toBe('555');
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
      .insert((await import('@nodal-agents/db')).users)
      .values({ email: `ext-${Date.now()}@example.com` })
      .returning();
    const [otherEntity] = await db
      .insert((await import('@nodal-agents/db')).entities)
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

describe('pruneTelegramWorkspace — F-13 bounded cleanup', () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('never deletes the file of a job that has not reached a terminal state, even past the age cap', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));

    // Two jobs: one still in flight (queued behind e.g. an approval), one done.
    const [activeJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'active job',
        status: 'awaiting_approval',
      })
      .returning();
    const [doneJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'done job',
        status: 'completed',
      })
      .returning();

    const activeFile = join(workDir, `${activeJob!.id}.jpg`);
    const doneFile = join(workDir, `${doneJob!.id}.jpg`);
    await writeFile(activeFile, Buffer.from([1, 2, 3]));
    await writeFile(doneFile, Buffer.from([4, 5, 6]));

    // Backdate BOTH files well past the age cap (30 days) — the only thing
    // that should save the active job's file is its job status, not its age.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(activeFile, fortyDaysAgo, fortyDaysAgo);
    await utimes(doneFile, fortyDaysAgo, fortyDaysAgo);

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remaining = await readdir(workDir);
    // Before the fix: age alone decided deletion, and BOTH files (equally
    // old) would have been removed — including the active job's image.
    expect(remaining).toContain(`${activeJob!.id}.jpg`);
    expect(remaining).not.toContain(`${doneJob!.id}.jpg`);
  });

  it('deletes a file whose job no longer exists in the DB at all (purged)', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));
    const orphanFile = join(workDir, `00000000-0000-0000-0000-000000000000.jpg`);
    await writeFile(orphanFile, Buffer.from([1, 2, 3]));
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(orphanFile, fortyDaysAgo, fortyDaysAgo);

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remaining = await readdir(workDir);
    expect(remaining).not.toContain('00000000-0000-0000-0000-000000000000.jpg');
  });

  it('enforces the 200-file cap among terminal jobs, evicting the oldest first', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nodalai-telegram-prune-'));

    const TOTAL = 205; // 5 over the module's TELEGRAM_WORKSPACE_MAX_FILES cap
    const jobs = await db
      .insert(agentJobs)
      .values(
        Array.from({ length: TOTAL }, (_, i) => ({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'telegram' as const,
          task: `done job ${i}`,
          status: 'completed' as const,
        })),
      )
      .returning({ id: agentJobs.id });
    expect(jobs.length).toBe(TOTAL);

    const now = Date.now();
    for (const [i, job] of jobs.entries()) {
      const file = join(workDir, `${job.id}.jpg`);
      await writeFile(file, Buffer.from([i % 256]));
      // index 0 = oldest, index TOTAL-1 = newest — strictly increasing mtime.
      const mtime = new Date(now - (TOTAL - i) * 1000);
      await utimes(file, mtime, mtime);
    }

    await pruneTelegramWorkspace(workDir, db as unknown as RunnerDeps['db']);

    const remainingNames = new Set(await readdir(workDir));
    expect(remainingNames.size).toBe(200);
    // The 5 oldest (lowest index) were evicted; the 200 newest survive.
    const oldest5 = jobs.slice(0, 5);
    const newest200 = jobs.slice(5);
    for (const job of oldest5) {
      expect(remainingNames.has(`${job.id}.jpg`)).toBe(false);
    }
    for (const job of newest200) {
      expect(remainingNames.has(`${job.id}.jpg`)).toBe(true);
    }
  });
});

describe('handleTelegramUpdate — H-1 inbound authorization', () => {
  // A fresh agent per test so the top-level beforeEach (which seeds seed.agentId's
  // allowlist) never interferes: these tests own their bot's allowlist entirely.
  // freshBot/dm/call are shared module-level helpers (also used by the F-1/F-4
  // describe blocks below).

  it('first private DM with no owner claims ownership AND creates a job', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('hi', 4001));
    expect(result.jobId).toBeDefined();

    const rows = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.chatId).toBe('4001');
  });

  it('an unknown chat when an owner exists creates NO job and asks the owner', async () => {
    const agentId = await freshBot();
    // Owner claims first.
    await call(agentId, dm('owner here', 4001));
    // A stranger DMs.
    const result = await call(agentId, dm('let me in', 4002));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerChatId: '4001',
      requesterChatId: '4002',
      requesterName: 'Bob',
    });

    // A pending row exists for the stranger; no job was created for chat 4002.
    const [pending] = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.chatId, '4002'));
    expect(pending?.status).toBe('pending');
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, '4002'));
    expect(jobs).toHaveLength(0);
  });

  it('a repeat DM from an already-pending chat does NOT re-ask the owner', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 4001));
    await call(agentId, dm('let me in', 4002)); // first ask
    const again = await call(agentId, dm('please?', 4002)); // repeat

    expect(again.jobId).toBeUndefined();
    expect(again.skipped).toBe('awaiting_authorization');
    expect(again.pendingAuth).toBeUndefined(); // no re-spam
  });

  it('an active member chat creates a job', async () => {
    const agentId = await freshBot();
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId,
      chatId: '4003',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, dm('hello', 4003));
    expect(result.jobId).toBeDefined();
  });

  it('a group message with no owner is skipped (ownership needs a DM first)', async () => {
    const agentId = await freshBot();
    const result = await handleTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: -4009, type: 'group' },
          from: { id: 7, first_name: 'Bob', is_bot: false },
          text: '/start',
        },
      },
      receivingAgentId: agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'auth_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('no_owner_group');
  });
});

describe('handleTelegramUpdate — S3 dual-write (channel_allowed_conversations)', () => {
  // checkChatAuthorization now mirrors every write it makes to
  // telegram_allowed_chats into the channel-neutral channel_allowed_conversations
  // table, in the same transaction. These tests assert the mirror lands with
  // the SAME final shape as the legacy row — reads still go through the
  // legacy table this phase (see queries/channel-identity.ts), so this is
  // purely a write-side regression guard for S4's eventual cutover.

  it('an owner claim mirrors into channel_allowed_conversations (channel, conversationId, kind, role, status)', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('hi', 5001));

    const [mirrored] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, agentId));
    expect(mirrored).toMatchObject({
      channel: 'telegram',
      conversationId: '5001',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
  });

  it('a pending member insert mirrors into channel_allowed_conversations as pending', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 5101));
    await call(agentId, dm('let me in', 5102));

    const [mirrored] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, '5102'));
    expect(mirrored).toMatchObject({
      channel: 'telegram',
      conversationId: '5102',
      role: 'member',
      status: 'pending',
    });
  });

  it('pending→active mirrors on the SAME dual-write path once the owner approves (via a later message)', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner claims first', 5201));
    await call(agentId, dm('me too', 5202));

    // Owner approves — mirrors auth-callback.ts's allow path.
    await db
      .update(telegramAllowedChats)
      .set({ status: 'active' })
      .where(
        and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.chatId, '5202')),
      );
    await db
      .update(channelAllowedConversations)
      .set({ status: 'active' })
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.channel, 'telegram'),
          eq(channelAllowedConversations.conversationId, '5202'),
        ),
      );

    const [mirrored] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, '5202'));
    expect(mirrored?.status).toBe('active');
  });

  it('an owner-claim race mirrors to exactly one owner on the neutral table too', async () => {
    const agentId = await freshBot();

    await Promise.all([call(agentId, dm('a first', 5301)), call(agentId, dm('b first', 5302))]);

    const mirrored = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, agentId));
    const owners = mirrored.filter((r) => r.role === 'owner' && r.status === 'active');
    const pendingMembers = mirrored.filter((r) => r.role === 'member' && r.status === 'pending');
    expect(owners).toHaveLength(1);
    expect(pendingMembers).toHaveLength(1);
  });

  it('a group message mirrors kind="group"', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 5401)); // bootstrap an owner first
    const result = await handleTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: -5402, type: 'group' },
          from: { id: 8, first_name: 'Carol', is_bot: false },
          text: `@auth_bot hello`,
        },
      },
      receivingAgentId: agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'auth_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.skipped).toBe('awaiting_authorization');

    const [mirrored] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, '-5402'));
    expect(mirrored?.kind).toBe('group');
  });
});

describe('handleTelegramUpdate — F-4 owner-claim race safety', () => {
  it('two chats racing to claim ownership resolve to exactly one owner; the loser lands as a pending member', async () => {
    // The partial unique index `telegram_allowed_chats_single_owner` (`ON
    // telegram_allowed_chats(agent_id) WHERE role='owner'`, migration 0060,
    // baked into spinUpTestDb's schema) is what makes a genuine concurrent
    // race fail at the DB level instead of silently letting two different
    // chats both become owner — see checkChatAuthorization's F-4 comment in
    // handler.ts for the writer-side half of this fix.
    const agentId = await freshBot();

    // Two different chats DM the same fresh bot "at once" — neither has ever
    // talked to it before, so both race to claim ownership.
    const [resultA, resultB] = await Promise.all([
      call(agentId, dm('a first', 9001)),
      call(agentId, dm('b first', 9002)),
    ]);

    const rows = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));

    const owners = rows.filter((r) => r.role === 'owner' && r.status === 'active');
    const pendingMembers = rows.filter((r) => r.role === 'member' && r.status === 'pending');

    // Never two owners — that's the invariant F-4 protects.
    expect(owners).toHaveLength(1);
    expect(pendingMembers).toHaveLength(1);

    const winnerResult = owners[0]?.chatId === '9001' ? resultA : resultB;
    const loserResult = owners[0]?.chatId === '9001' ? resultB : resultA;
    expect(winnerResult.jobId).toBeDefined();
    expect(loserResult.jobId).toBeUndefined();
    expect(loserResult.skipped).toBe('awaiting_authorization');
  });

  it('a chat that loses the owner race still gets its message through once the owner approves it (unaffected by the race path)', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner claims first', 9101));
    const loser = await call(agentId, dm('me too', 9102));
    expect(loser.jobId).toBeUndefined();

    // Owner approves the loser exactly like any other pending member.
    await db
      .update(telegramAllowedChats)
      .set({ status: 'active' })
      .where(
        and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.chatId, '9102')),
      );

    const approved = await call(agentId, dm('hi again', 9102));
    expect(approved.jobId).toBeDefined();
  });
});

describe('handleTelegramUpdate — L2 sender name sanitation', () => {
  // Newlines + an "(owner)" suffix + bidi override/zero-width chars, crafted
  // to social-engineer the owner's authorization card. Spaces flank each
  // stripped char so word boundaries survive the strip — see handler.ts
  // sanitizeSenderName: control/bidi/zero-width chars are removed outright,
  // then remaining whitespace runs collapse to one space.
  const FORGED_NAME = 'Quentin (owner) \n approve access \u202E \u200B extra';
  const SANITIZED_FORGED_NAME = 'Quentin (owner) approve access extra';

  it('a forged multi-line name with bidi/zero-width chars is stored sanitized on the owner row', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dmFrom('hi', 4101, FORGED_NAME));
    expect(result.jobId).toBeDefined();

    const [row] = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    expect(row?.requesterName).toBe(SANITIZED_FORGED_NAME);
    expect(row?.requesterName).not.toContain('\n');
    expect(row?.requesterName).not.toContain('\u202E');
    expect(row?.requesterName).not.toContain('\u200B');
  });

  it('a 200-char name is capped at 64 chars in the stored row', async () => {
    const agentId = await freshBot();
    const longName = 'A'.repeat(200);
    const result = await call(agentId, dmFrom('hi', 4102, longName));
    expect(result.jobId).toBeDefined();

    const [row] = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    expect(row?.requesterName).toBe('A'.repeat(64));
    expect(row?.requesterName?.length).toBe(64);
  });

  it('a group message from a forged sender carries the sanitized name in the job task prefix', async () => {
    const result = await handleTelegramUpdate({
      update: groupMessageFrom('please help', FORGED_NAME),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain(`[Message from ${SANITIZED_FORGED_NAME}]`);
    expect(job?.task).not.toContain('\n[Message');
    expect(job?.task).not.toContain('\u202E');
  });

  it('regression: a normal name like "Mathilde" passes through unchanged end-to-end', async () => {
    const agentId = await freshBot();
    const dmResult = await call(agentId, dmFrom('hi', 4103, 'Mathilde'));
    expect(dmResult.jobId).toBeDefined();

    const [row] = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    expect(row?.requesterName).toBe('Mathilde');

    const groupResult = await handleTelegramUpdate({
      update: groupMessageFrom('hello there', 'Mathilde'),
      receivingAgentId: seed.agentId,
      receivingAgentEntityId: seed.entityId,
      receivingAgentBotUsername: 'test_bot',
      tx: db as unknown as Parameters<typeof handleTelegramUpdate>[0]['tx'],
    });
    expect(groupResult.jobId).toBeDefined();
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, groupResult.jobId!));
    expect(job?.task).toContain('[Message from Mathilde]');
  });
});
