// channel-identity-queries.test.ts — S2 (multichannel plan).
//
// Coverage:
//  - channel_bindings: UNIQUE(agent_id, channel) enforced; getChannelBinding /
//    listChannelBindings read them back.
//  - channel_allowed_conversations: single-owner partial unique index scoped
//    to (agent_id, channel) — a 2nd owner on the SAME channel is rejected, but
//    the SAME agent gets its OWN owner on a DIFFERENT channel (the
//    multichannel property this whole brique exists for).
//  - resolveOwnerConversation / isConversationAllowed: work through
//    channel_allowed_conversations for a neutral channel (discord); for
//    channel='telegram' they read telegram_allowed_chats directly instead
//    (the S2 transitional split — see queries/channel-identity.ts's header),
//    proven by inserting ONLY in the legacy table and finding it via the
//    neutral functions.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import {
  channelBindings,
  channelAllowedConversations,
  telegramAllowedChats,
} from '../schema/index.ts';
import {
  resolveOwnerConversation,
  isConversationAllowed,
  getChannelBinding,
  listChannelBindings,
  countActiveConversations,
  listAllowedConversations,
} from '../queries/channel-identity.ts';

let db: TestDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
  agentId = seed.agentId;
});

describe('channel_bindings', () => {
  it('enforces UNIQUE(agent_id, channel)', async () => {
    await db.insert(channelBindings).values({
      entityId,
      agentId,
      channel: 'discord',
      credentials: '{"token":"a"}',
    });

    await expect(
      db.insert(channelBindings).values({
        entityId,
        agentId,
        channel: 'discord',
        credentials: '{"token":"b"}',
      }),
    ).rejects.toThrow();
  });

  it('allows the same agent to have bindings on different channels', async () => {
    await expect(
      db.insert(channelBindings).values({
        entityId,
        agentId,
        channel: 'slack',
        credentials: '{"token":"c"}',
      }),
    ).resolves.toBeDefined();
  });
});

describe('getChannelBinding / listChannelBindings', () => {
  it('getChannelBinding returns the binding for a bound channel, null otherwise', async () => {
    const binding = await getChannelBinding(db, agentId, 'discord');
    expect(binding?.channel).toBe('discord');
    expect(await getChannelBinding(db, agentId, 'whatsapp')).toBeNull();
  });

  it('listChannelBindings returns every binding configured for the agent', async () => {
    const bindings = await listChannelBindings(db, agentId);
    expect(bindings.map((b) => b.channel).sort()).toEqual(['discord', 'slack']);
  });
});

describe('channel_allowed_conversations: single-owner partial index scoped to (agent, channel)', () => {
  it('rejects a second owner row for the same (agent, channel)', async () => {
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'discord',
      conversationId: 'convo-1',
      role: 'owner',
      status: 'active',
    });

    await expect(
      db.insert(channelAllowedConversations).values({
        entityId,
        agentId,
        channel: 'discord',
        conversationId: 'convo-2',
        role: 'owner',
        status: 'active',
      }),
    ).rejects.toThrow();
  });

  it('allows the SAME agent to have its own owner on a DIFFERENT channel', async () => {
    await expect(
      db.insert(channelAllowedConversations).values({
        entityId,
        agentId,
        channel: 'slack',
        conversationId: 'convo-slack-1',
        role: 'owner',
        status: 'active',
      }),
    ).resolves.toBeDefined();
  });
});

describe('resolveOwnerConversation / isConversationAllowed — neutral channel (discord)', () => {
  it('resolveOwnerConversation finds the owner via channel_allowed_conversations', async () => {
    await expect(resolveOwnerConversation(db, agentId, 'discord')).resolves.toBe('convo-1');
  });

  it('isConversationAllowed returns true for the active owner conversation', async () => {
    await expect(
      isConversationAllowed(db, {
        entityId,
        agentId,
        channel: 'discord',
        conversationId: 'convo-1',
      }),
    ).resolves.toBe(true);
  });

  it('isConversationAllowed returns false for an unknown conversation', async () => {
    await expect(
      isConversationAllowed(db, {
        entityId,
        agentId,
        channel: 'discord',
        conversationId: 'convo-unknown',
      }),
    ).resolves.toBe(false);
  });
});

describe('resolveOwnerConversation / isConversationAllowed — transitional legacy read (telegram)', () => {
  it('reads telegram_allowed_chats directly, not channel_allowed_conversations', async () => {
    // Insert ONLY in the legacy table — S2 keeps nothing back-filling it live.
    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: 'legacy-chat-1',
      role: 'owner',
      status: 'active',
    });

    await expect(resolveOwnerConversation(db, agentId, 'telegram')).resolves.toBe('legacy-chat-1');
    await expect(
      isConversationAllowed(db, {
        entityId,
        agentId,
        channel: 'telegram',
        conversationId: 'legacy-chat-1',
      }),
    ).resolves.toBe(true);

    // Confirm the read is genuinely coming from the LEGACY table: no matching
    // row was ever created in channel_allowed_conversations for it.
    const neutralRows = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.conversationId, 'legacy-chat-1'),
        ),
      );
    expect(neutralRows).toHaveLength(0);
  });
});

describe('countActiveConversations / listAllowedConversations — neutral channel (discord)', () => {
  it('counts only ACTIVE rows, excluding pending', async () => {
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'discord',
      conversationId: 'convo-pending-1',
      role: 'member',
      status: 'pending',
    });
    await db.insert(channelAllowedConversations).values({
      entityId,
      agentId,
      channel: 'discord',
      conversationId: 'convo-member-1',
      role: 'member',
      status: 'active',
    });

    // discord now holds: convo-1 (owner, active), convo-member-1 (member,
    // active), convo-pending-1 (pending) — only the two active ones count.
    await expect(countActiveConversations(db, agentId, 'discord')).resolves.toBe(2);
  });

  it('listAllowedConversations returns every row (active + pending) with its real fields', async () => {
    const rows = await listAllowedConversations(db, agentId, 'discord');
    const byId = new Map(rows.map((r) => [r.conversationId, r]));
    expect(byId.get('convo-1')).toMatchObject({
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    expect(byId.get('convo-pending-1')).toMatchObject({ role: 'member', status: 'pending' });
  });
});

describe('countActiveConversations / listAllowedConversations — transitional legacy read (telegram)', () => {
  it('counts active telegram_allowed_chats rows and derives kind from the chat id sign', async () => {
    // legacy-chat-1 is already active/owner from the describe block above
    // (positive id → 'private'). Add a group (negative id, Telegram's own
    // convention) member row + a pending row that must NOT be counted.
    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: '-100200300',
      role: 'member',
      status: 'active',
    });
    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: 'legacy-chat-pending',
      role: 'member',
      status: 'pending',
    });

    await expect(countActiveConversations(db, agentId, 'telegram')).resolves.toBe(2);

    const rows = await listAllowedConversations(db, agentId, 'telegram');
    const byId = new Map(rows.map((r) => [r.conversationId, r]));
    expect(byId.get('legacy-chat-1')).toMatchObject({
      kind: 'private',
      role: 'owner',
      status: 'active',
    });
    expect(byId.get('-100200300')).toMatchObject({
      kind: 'group',
      role: 'member',
      status: 'active',
    });
    expect(byId.get('legacy-chat-pending')).toMatchObject({ status: 'pending' });
  });
});
