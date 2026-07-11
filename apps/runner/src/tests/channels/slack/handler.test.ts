// handler.test.ts — handleSlackMessage: bot-author guard, H-1 owner-claim /
// pending-authorization state machine, channel-mention gating (via the
// already-resolved 'channel' kind — Slack's own event routing is the mention
// gate, see types.ts), and /ask routing gated by the TARGET's own slack
// allowlist. Mirrors tests/channels/discord/handler.test.ts's structure.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents, channelAllowedConversations } from '@nodal-agents/db';
import { handleSlackMessage } from '../../../channels/slack/handler.ts';
import type { SlackInboundMessage } from '../../../channels/slack/types.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

const BOT_ID = 'U-BOT-1';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

function dm(
  text: string,
  conversationId: string,
  userId = 'U1',
  displayName = 'Bob',
): SlackInboundMessage {
  return {
    conversationId,
    channelType: 'im',
    text,
    user: { id: userId, bot: false, displayName },
  };
}

function mention(text: string, opts: { conversationId?: string } = {}): SlackInboundMessage {
  return {
    conversationId: opts.conversationId ?? 'C-CHAN-1',
    channelType: 'channel',
    text,
    user: { id: 'U7', bot: false, displayName: 'Alice' },
  };
}

/** A fresh agent with an empty allowlist slate, for H-1/F-1 tests. */
async function freshBot(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Slack Auth Bot',
      slug: `slack-auth-bot-${Date.now()}-${Math.floor(performance.now())}`,
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning({ id: agents.id });
  return row!.id;
}

const call = (agentId: string, message: SlackInboundMessage) =>
  handleSlackMessage({
    message,
    receivingAgentId: agentId,
    receivingAgentEntityId: seed.entityId,
    receivingAgentBotUserId: BOT_ID,
    tx: db as unknown as Parameters<typeof handleSlackMessage>[0]['tx'],
  });

describe('handleSlackMessage — bot-author hard rule', () => {
  it('always ignores a message whose author is a bot', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, {
      conversationId: 'D-1',
      channelType: 'im',
      text: 'hello',
      user: { id: 'U-OTHER-BOT', bot: true, displayName: 'otherbot' },
    });
    expect(result).toEqual({ skipped: 'bot_author' });

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'D-1'));
    expect(jobs).toHaveLength(0);
  });
});

describe('handleSlackMessage — H-1 owner-claim / pending authorization', () => {
  it('first DM with no owner claims ownership AND creates a job', async () => {
    const agentId = await freshBot();
    const result = await call(agentId, dm('hi', 'D-owner-1'));
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('slack');
    expect(job?.chatId).toBe('D-owner-1');
    expect(job?.task).toBe('hi');

    const rows = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'slack',
      conversationId: 'D-owner-1',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
  });

  it('an unknown DM when an owner exists creates NO job and returns a pendingAuth card intent to the owner', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 'D-owner-2'));
    const result = await call(agentId, dm('let me in', 'D-stranger-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'D-owner-2',
      requesterConversationId: 'D-stranger-2',
      requesterName: 'Bob',
    });

    const [pending] = await db
      .select()
      .from(channelAllowedConversations)
      .where(eq(channelAllowedConversations.conversationId, 'D-stranger-2'));
    expect(pending?.status).toBe('pending');
    expect(pending?.role).toBe('member');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.chatId, 'D-stranger-2'));
    expect(jobs).toHaveLength(0);
  });

  it('a repeat DM from an already-pending conversation does NOT re-ask the owner (no spam)', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 'D-owner-3'));
    await call(agentId, dm('let me in', 'D-stranger-3')); // first ask
    const again = await call(agentId, dm('please?', 'D-stranger-3')); // repeat

    expect(again.jobId).toBeUndefined();
    expect(again.skipped).toBe('awaiting_authorization');
    expect(again.pendingAuth).toBeUndefined();
  });

  it('an active member conversation creates a job', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('owner here', 'D-owner-4'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'slack',
      conversationId: 'D-member-4',
      kind: 'private',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, dm('hello', 'D-member-4'));
    expect(result.jobId).toBeDefined();
  });
});

describe('handleSlackMessage — no content', () => {
  it('skips a message with only whitespace text', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('bootstrap owner', 'D-owner-empty'));
    const result = await call(agentId, dm('   ', 'D-owner-empty'));
    expect(result).toEqual({ skipped: 'no_content' });
  });
});

describe('handleSlackMessage — channel messages arrive only via app_mention (already gated)', () => {
  it('strips the mention token and prefixes the sender name', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('bootstrap owner', 'D-owner-guild-2'));
    // This test is about the mention/prefix behavior, not H-1 — pre-authorize
    // the channel itself (mirrors discord/handler.test.ts's pattern).
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'slack',
      conversationId: 'C-CHAN-2',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    const result = await call(
      agentId,
      mention(`<@${BOT_ID}> what time is it`, { conversationId: 'C-CHAN-2' }),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.channel).toBe('slack');
    expect(job?.chatId).toBe('C-CHAN-2');
    expect(job?.task).toContain('[Message from Alice]');
    expect(job?.task).toContain('what time is it');
    expect(job?.task).not.toContain(`<@${BOT_ID}>`);
  });

  it('also strips the labeled mention form `<@ID|name>`', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('bootstrap owner', 'D-owner-guild-labeled'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'slack',
      conversationId: 'C-CHAN-labeled',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    const result = await call(
      agentId,
      mention(`<@${BOT_ID}|nodal> ping`, { conversationId: 'C-CHAN-labeled' }),
    );
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.task).toBe('[Message from Alice]: ping');
  });

  it('a mention with no remaining text is skipped (mention_no_text)', async () => {
    const agentId = await freshBot();
    await call(agentId, dm('bootstrap owner', 'D-owner-guild-empty'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId,
      channel: 'slack',
      conversationId: 'C-CHAN-empty',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });
    const result = await call(agentId, mention(`<@${BOT_ID}>`, { conversationId: 'C-CHAN-empty' }));
    expect(result).toEqual({ skipped: 'mention_no_text' });
  });

  it('a channel mention when the bot has no owner yet is skipped (no_owner_group)', async () => {
    const agentId = await freshBot();
    const result = await call(
      agentId,
      mention(`<@${BOT_ID}> hello`, { conversationId: 'C-CHAN-4' }),
    );
    expect(result).toEqual({ skipped: 'no_owner_group' });
  });
});

describe('handleSlackMessage — /ask routing gated by the TARGET agent allowlist', () => {
  it('routes /ask <slug> <text> to the named agent when the conversation is already active for it', async () => {
    const receiverId = await freshBot();
    await call(receiverId, dm('bootstrap receiver owner', 'D-ask-1'));

    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Ask Target',
        slug: `ask-target-slack-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: otherAgent!.id,
      channel: 'slack',
      conversationId: 'D-ask-1',
      kind: 'private',
      role: 'member',
      status: 'active',
    });

    const result = await call(
      receiverId,
      dm(`/ask ${otherAgent!.slug} what is the time`, 'D-ask-1'),
    );
    expect(result.jobId).toBeDefined();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('what is the time');
  });

  it('/ask via an @mention in a channel routes to the named agent (mention stripped first)', async () => {
    const receiverId = await freshBot();
    await call(receiverId, dm('bootstrap receiver owner', 'D-ask-mention-owner'));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: receiverId,
      channel: 'slack',
      conversationId: 'C-ASK-MENTION',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });

    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Ask Target Channel',
        slug: `ask-target-chan-${Date.now()}`,
        personality: 'I am the target.',
      })
      .returning();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: otherAgent!.id,
      channel: 'slack',
      conversationId: 'C-ASK-MENTION',
      kind: 'channel',
      role: 'member',
      status: 'active',
    });

    const result = await call(
      receiverId,
      mention(`<@${BOT_ID}> /ask ${otherAgent!.slug} help please`, {
        conversationId: 'C-ASK-MENTION',
      }),
    );
    expect(result.jobId).toBeDefined();
    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, result.jobId!));
    expect(job?.agentId).toBe(otherAgent!.id);
    expect(job?.task).toBe('help please');
  });

  it('/ask to a sibling the conversation has never talked to: NO job, pending member created, owner notified', async () => {
    const receiverId = await freshBot();
    await call(receiverId, dm('bootstrap receiver owner', 'D-ask-2'));

    const targetAgentId = await freshBot();
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: targetAgentId,
      channel: 'slack',
      conversationId: 'D-ask-target-owner',
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    const [targetRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, targetAgentId));

    const result = await call(receiverId, dm(`/ask ${targetRow!.slug} please help`, 'D-ask-2'));

    expect(result.jobId).toBeUndefined();
    expect(result.skipped).toBe('awaiting_authorization');
    expect(result.pendingAuth).toMatchObject({
      ownerConversationId: 'D-ask-target-owner',
      requesterConversationId: 'D-ask-2',
    });

    const [pendingRow] = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, targetAgentId),
          eq(channelAllowedConversations.conversationId, 'D-ask-2'),
        ),
      );
    expect(pendingRow?.role).toBe('member');
    expect(pendingRow?.status).toBe('pending');

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.agentId, targetAgentId));
    expect(jobs).toHaveLength(0);
  });

  it('skips /ask <unknown-slug> rather than blindly creating a job', async () => {
    const receiverId = await freshBot();
    await call(receiverId, dm('bootstrap receiver owner', 'D-ask-3'));
    const result = await call(receiverId, dm('/ask not-a-real-agent please help', 'D-ask-3'));
    expect(result).toEqual({ skipped: 'ask_unknown_agent' });
  });
});
