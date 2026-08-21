// handler.test.ts — handleDiscordMessage: bot-author guard, H-1 owner-claim /
// pending-authorization state machine, guild mention-gating, and /ask routing
// gated by the TARGET's own discord allowlist. Mirrors
// tests/telegram/handler.test.ts's structure for the discord-shaped handler.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents, channelAllowedConversations } from '@nodal-agents/db';
import { handleDiscordMessage } from '../../../channels/discord/handler.ts';
import type { DiscordInboundMessage } from '../../../channels/discord/types.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

const BOT_ID = 'bot-user-1';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

function dm(
  text: string,
  channelId: string,
  authorId = 'u1',
  globalName = 'Bob',
): DiscordInboundMessage {
  return {
    channelId,
    channelType: 'dm',
    content: text,
    author: { id: authorId, bot: false, username: 'bob', globalName },
    mentionedUserIds: [],
    attachments: [],
  };
}

function guildMessage(
  text: string,
  opts: {
    mention?: boolean;
    /** Mention via the bot's guild-managed ROLE (`<@&id>`) — what Discord's autocomplete actually inserts. */
    roleMention?: string;
    replyToBotId?: string;
    channelId?: string;
  } = {},
): DiscordInboundMessage {
  const selfMentionTokens = [
    ...(opts.mention ? [`<@${BOT_ID}>`, `<@!${BOT_ID}>`] : []),
    ...(opts.roleMention ? [`<@&${opts.roleMention}>`] : []),
  ];
  return {
    channelId: opts.channelId ?? 'guild-chan-1',
    channelType: 'guild_text',
    content: text,
    author: { id: 'u7', bot: false, username: 'alice', globalName: 'Alice' },
    mentionedUserIds: opts.mention ? [BOT_ID] : [],
    mentionsSelf: opts.mention === true || opts.roleMention !== undefined ? true : undefined,
    selfMentionTokens: selfMentionTokens.length > 0 ? selfMentionTokens : undefined,
    referencedMessageAuthorId: opts.replyToBotId,
    attachments: [],
  };
}

/** A fresh agent with an empty allowlist slate, for H-1/F-1 tests. */
async function freshBot(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Discord Auth Bot',
      slug: `discord-auth-bot-${Date.now()}-${Math.floor(performance.now())}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning({ id: agents.id });
  return row!.id;
}

const call = (agentId: string, message: DiscordInboundMessage) =>
  handleDiscordMessage({
    message,
    receivingAgentId: agentId,
    receivingAgentEntityId: seed.entityId,
    receivingAgentBotUserId: BOT_ID,
    tx: db as unknown as Parameters<typeof handleDiscordMessage>[0]['tx'],
  });

/**
 * Bring an agent to "has an ACTIVE owner" — what a single bootstrap DM used to
 * do by itself. Since CHANNEL-001 the first DM only RECORDS the claim
 * (owner/pending); a human approves it in the dashboard. Tests that need an
 * established owner do both halves, exactly like a real setup now does.
 */
async function claimOwner(agentId: string, message: DiscordInboundMessage): Promise<void> {
  await call(agentId, message);
  await db
    .update(channelAllowedConversations)
    .set({ status: 'active' })
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.conversationId, message.channelId),
        eq(channelAllowedConversations.role, 'owner'),
      ),
    );
}

describe('handleDiscordMessage — bot-author hard rule', () => {
  it('always ignores a message whose author is a bot', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, {
      channelId: 'dm-1',
      channelType: 'dm',
      content: 'hello',
      author: { id: 'some-bot', bot: true, username: 'otherbot', globalName: null },
      mentionedUserIds: [],
      attachments: [],
    });
    expect(result).toEqual({ skipped: 'bot_author' });

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'dm-1'));
    expect(jobs).toHaveLength(0);
  });
});

describe('handleDiscordMessage — H-1 owner-claim / pending authorization', () => {
  // CHANNEL-001: was "first DM claims ownership AND creates a job" — trust on
  // first use, i.e. whoever DMed the public bot handle first became its owner.
  it('first DM with no owner records a PENDING owner claim and creates NO job', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('hi', 'dm-owner-1'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: null,
      requesterConversationId: 'dm-owner-1',
    });
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'dm-owner-1'));
    expect(jobs).toHaveLength(0);

    const rows = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'discord',
      conversationId: 'dm-owner-1',
      kind: 'private',
      role: 'owner',
      status: 'pending',
    });
  });

  it('once the owner claim is approved, that conversation creates jobs', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('hi', 'dm-approved-1'));
    const result = await call(agentId, dm('do something', 'dm-approved-1'));
    expect(result.jobId).toBeDefined();
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('discord');
    expect(job?.task).toBe('do something');
  });

  it('an unknown DM when an owner exists creates NO job and returns a pendingAuth card intent to the owner', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-2'));
    const result = await call(agentId, dm('let me in', 'dm-stranger-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'dm-owner-2',
      requesterConversationId: 'dm-stranger-2',
      requesterName: 'Bob',
    });

    const [pending] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, 'dm-stranger-2'));
    expect(pending?.status).toBe('pending');
    expect(pending?.role).toBe('member');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'dm-stranger-2'));
    expect(jobs).toHaveLength(0);
  });

  it('a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam)', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-3'));
    await call(agentId, dm('let me in', 'dm-stranger-3')); // first ask
    const again = await call(agentId, dm('please?', 'dm-stranger-3')); // repeat

    expect(again.jobId).toBeUndefined();
    expect(again.skipped).toBe('awaiting_authorization');
    expect(again.pendingAuth).toBeUndefined();
  });

  it('an active member conversation creates a job', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('owner here', 'dm-owner-4'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'discord',
      conversationId: 'dm-member-4',
      kind: 'private',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, dm('hello', 'dm-member-4'));
    expect(result.jobId).toBeDefined();
  });
});

describe('handleDiscordMessage — guild channel mention gating', () => {
  it('ignores plain text with no mention, no reply, no command', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-1'));
    const result = await call(agentId, guildMessage('just chatting'));
    expect(result).toEqual({ skipped: 'group_filter' });
  });

  it('responds to an @mention, stripping the mention and prefixing the sender name', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-2'));
    // This test is about the mention/prefix behavior, not H-1 — pre-authorize
    // the guild channel itself (mirrors tests/telegram/handler.test.ts's
    // top-level beforeEach seeding -100123 as an already-active member).
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'discord',
      conversationId: 'guild-chan-2',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    const result = await call(
      agentId,
      guildMessage(`<@${BOT_ID}> what time is it`, { mention: true, channelId: 'guild-chan-2' }),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('discord');
    expect(job?.chatId).toBe('guild-chan-2');
    expect(job?.task).toContain('[Message from Alice]');
    expect(job?.task).toContain('what time is it');
    expect(job?.task).not.toContain(`<@${BOT_ID}>`);
  });

  it('responds to a ROLE mention of the bot (what Discord autocomplete actually inserts) — live incident 2026-07-11', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-role'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'discord',
      conversationId: 'guild-chan-role',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    // No user mention at all — mentionedUserIds is empty; only the managed
    // role token, exactly the wire shape observed live (`<@&…> t la ?`).
    const result = await call(
      agentId,
      guildMessage('<@&role-777> t la ?', {
        roleMention: 'role-777',
        channelId: 'guild-chan-role',
      }),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toContain('[Message from Alice]');
    expect(job?.task).toContain('t la ?');
    expect(job?.task).not.toContain('<@&');
  });

  it('a ROLE mention from an UNKNOWN guild channel opens the pending-approval flow (no silent drop)', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-role2'));
    const result = await call(
      agentId,
      guildMessage('<@&role-888> hello', {
        roleMention: 'role-888',
        channelId: 'guild-chan-unknown',
      }),
    );
    expect(result.jobId).toBeUndefined();
    expect(result.pendingAuth).toBeDefined();
    expect(result.pendingAuth?.requesterConversationId).toBe('guild-chan-unknown');

    const rows = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.conversationId, 'guild-chan-unknown'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.kind).toBe('channel');
  });

  it('responds to a reply targeting the bot even without a mention', async () => {
    const agentId = await freshBot();
    await claimOwner(agentId, dm('bootstrap owner', 'dm-owner-guild-3'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'discord',
      conversationId: 'guild-chan-3',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    const result = await call(
      agentId,
      guildMessage('thanks!', { replyToBotId: BOT_ID, channelId: 'guild-chan-3' }),
    );
    expect(result.jobId).toBeDefined();
  });

  it('a guild message when the bot has no owner yet is skipped (no_owner_group)', async () => {
    const agentId = await freshBot();
    const result = await call(
      agentId,
      guildMessage(`<@${BOT_ID}> hello`, { mention: true, channelId: 'guild-chan-4' }),
    );
    expect(result).toEqual({ skipped: 'no_owner_group' });
  });
});

describe('handleDiscordMessage — /ask routing gated by the TARGET agent allowlist', () => {
  it('routes /ask <slug> <text> to the named agent when the conversation is already active for it', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-1'));

    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Ask Target',
        slug: `ask-target-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: otherAgent!.id,
      channel: 'discord',
      conversationId: 'dm-ask-1',
      kind: 'private',
      role: 'member',
      status: 'active',
    });

    const result = await call(
      receiverId,
      dm(`/ask ${otherAgent!.slug} what is the time`, 'dm-ask-1'),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('what is the time');
  });

  it('/ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-2'));

    const targetAgentId = await freshBot();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: targetAgentId,
      channel: 'discord',
      conversationId: 'dm-ask-target-owner',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    const result = await call(receiverId, dm(`/ask ${targetRow!.slug} please help`, 'dm-ask-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'dm-ask-target-owner',
      requesterConversationId: 'dm-ask-2',
    });

    const [pendingRow] = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, targetAgentId),
          eq(channelAllowedConversations.conversationId, 'dm-ask-2'),
        ),
      );
    expect(pendingRow?.role).toBe('member');
    expect(pendingRow?.status).toBe('pending');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.agentId, targetAgentId));
    expect(jobs).toHaveLength(0);
  });

  it('skips /ask <unknown-slug> rather than blindly creating a job', async () => {
    const receiverId = await freshBot();
    await claimOwner(receiverId, dm('bootstrap receiver owner', 'dm-ask-3'));
    const result = await call(receiverId, dm('/ask not-a-real-agent please help', 'dm-ask-3'));
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });
});
