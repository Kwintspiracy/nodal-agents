// designated-chat.test.ts — a chat carries the channel it was RESOLVED on, or
// none (#649, review of #657 passes 2 and 3). Real pglite rows, no mocks.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { eq } from 'drizzle-orm';
import { telegramAllowedChats } from '../schema/telegram-allowed-chats.ts';
import { channelAllowedConversations } from '../schema/channel-allowed-conversations.ts';
import { designateChat, resolveScheduleNotifyChat } from '../queries/designated-chat.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: 'tg-owner',
    role: 'owner',
    status: 'active',
  });
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'discord',
    conversationId: 'discord-owner',
    role: 'owner',
    status: 'active',
  });
});

describe('designateChat / resolveScheduleNotifyChat @cap:parler-par-canal-externe/moteur', () => {
  it('designateChat: the channel travels with the chat, and only with one', () => {
    expect(designateChat('1', 'telegram')).toEqual({ chatId: '1', chatChannel: 'telegram' });
    expect(designateChat('1', null)).toEqual({ chatId: '1', chatChannel: null });
    for (const none of [null, undefined, '', '  ']) {
      expect(designateChat(none, 'telegram')).toEqual({ chatId: null, chatChannel: null });
    }
  });

  it('a routine: owner resolved on a channel → that channel; explicit id on auto → no channel; silent → nothing', async () => {
    const base = { agentId: seed.agentId, notifyOnSuccess: true };
    const cases = [
      [
        { ...base, notifyChannel: null, chatId: null },
        { chatId: 'tg-owner', chatChannel: 'telegram' },
      ],
      [
        { ...base, notifyChannel: 'discord', chatId: null },
        { chatId: 'discord-owner', chatChannel: 'discord' },
      ],
      // The schedule declared both the chat and its channel.
      [
        { ...base, notifyChannel: 'discord', chatId: 'team-42' },
        { chatId: 'team-42', chatChannel: 'discord' },
      ],
      // Auto with an explicit id: nothing says its platform.
      [
        { ...base, notifyChannel: null, chatId: 'team-group-999' },
        { chatId: 'team-group-999', chatChannel: null },
      ],
      // A chosen channel with no owner conversation: no chat (notify_unreachable upstream).
      [
        { ...base, notifyChannel: 'slack', chatId: null },
        { chatId: null, chatChannel: null },
      ],
      [
        { ...base, notifyOnSuccess: false, notifyChannel: null, chatId: 'x' },
        { chatId: null, chatChannel: null },
      ],
    ] as const;
    for (const [schedule, expected] of cases) {
      expect({ schedule, got: await resolveScheduleNotifyChat(db, schedule) }).toEqual({
        schedule,
        got: expected,
      });
    }
  });

  it('auto with no Telegram owner: no chat, not a guess on another channel', async () => {
    await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
    expect(
      await resolveScheduleNotifyChat(db, {
        agentId: seed.agentId,
        notifyOnSuccess: true,
        notifyChannel: null,
        chatId: null,
      }),
    ).toEqual({ chatId: null, chatChannel: null });
  });
});
