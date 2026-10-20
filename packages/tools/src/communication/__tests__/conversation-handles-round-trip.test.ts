// conversation-handles-round-trip.test.ts — the model reads a conversation by
// its HANDLE and the send tools take it back (#824), on a real database.
//
// What reaches the model: `list_conversations` on WhatsApp, Telegram and
// Discord carries handles, never the channel's ids (a WhatsApp DM's id is a
// phone number). What comes back: a send tool given a handle reaches the
// conversation and the channel it names, through today's allowlist check; a
// handle of another entity, an unknown one, or one that contradicts `channel`
// is refused; a raw id still works; the job's own chat as a handle skips the
// allowlist exactly like its raw id.
//
// Only the platform is faked (`getAdapter`): the database, the allowlist, the
// bindings and the handles are real.
//
// Mutations verified (each turns this file red):
//   - `conversationArgument` returns the handle untouched (no resolution) →
//     every handle send is refused or reaches the wrong id;
//   - list_conversations returns `e.conversationId` instead of the handle →
//     "never the channel's ids" goes red on all three channels;
//   - `withoutConversationId` returns `err` unchanged → the platform error
//     test sees the raw id.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spinUpTestDb, seedMinimal, type TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  channelAllowedConversations,
  channelBindings,
  conversationHandleFor,
  entities,
  eq,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { CONVERSATION_HANDLE_RE } from '@nodal-agents/shared';
import { DeliveryError } from '@nodal-agents/delivery';
import type { ToolContext } from '../../types';

// ─── The platform, faked ─────────────────────────────────────────────────────

type Sent = { channel: string; token: string | undefined; chatId: string; what: string };
const sent: Sent[] = [];
const failNextSendWith: { error: Error | null } = { error: null };

const { getAdapterMock } = vi.hoisted(() => ({ getAdapterMock: vi.fn() }));
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return { ...actual, getAdapter: getAdapterMock };
});

const DISCORD_DM = '1188000000000000001';
const DISCORD_UNAPPROVED = '1188000000000000002';
const WA_DM = '33612345678@s.whatsapp.net';
const WA_GROUP = '120363000000000001@g.us';

function fakeAdapter(channel: string) {
  return {
    sendText: vi.fn(async (creds: { botToken?: string }, chatId: string, text: string) => {
      if (failNextSendWith.error) {
        const e = failNextSendWith.error;
        failNextSendWith.error = null;
        throw e;
      }
      sent.push({ channel, token: creds.botToken, chatId, what: text });
      return { messageId: '1' };
    }),
    sendMedia: vi.fn(async (creds: { botToken?: string }, chatId: string, m: { kind: string }) => {
      sent.push({ channel, token: creds.botToken, chatId, what: m.kind });
      return { messageId: '1' };
    }),
    ...(channel === 'discord'
      ? {
          listConversations: vi.fn(async () => [
            { conversationId: DISCORD_DM, name: 'paul', kind: 'private' },
            { conversationId: DISCORD_UNAPPROVED, name: '#general', kind: 'channel' },
          ]),
        }
      : {}),
  };
}

// Imported after the mock is declared.
const { createTelegramSendMessageTool } = await import('../telegram-send-message');
const { createSendImageTool } = await import('../send-image');
const { createListConversationsTool } = await import('../../builtin/list-conversations');
const { resetDeliveryCounterForTests } = await import('../delivery-guard');

const sendMessage = createTelegramSendMessageTool();
const sendImage = createSendImageTool();
const listConversations = createListConversationsTool();

// ─── A real workspace ────────────────────────────────────────────────────────

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let secondAgentId: string;

/** A Telegram job whose own chat is 777 — with NO allowlist row for 777. */
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: '777',
    jobChatChannel: 'telegram',
    jobChannel: 'telegram',
    activeChannels: ['telegram', 'discord', 'whatsapp'],
    ...over,
  };
}

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db.update(agents).set({ telegramBotToken: 'tg-tok' }).where(eq(agents.id, seed.agentId));
  const [second] = await db
    .insert(agents)
    .values({ entityId: seed.entityId, name: 'Second', slug: 'second', personality: 'p' })
    .returning();
  secondAgentId = second!.id;
  // Telegram's token lives on the agent row; its binding row says it is enabled.
  for (const channel of ['telegram', 'discord', 'whatsapp'] as const) {
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      credentials: JSON.stringify(
        channel === 'discord'
          ? { botToken: 'dc-tok' }
          : channel === 'whatsapp'
            ? { sessionDir: '/tmp/wa' }
            : {},
      ),
      enabled: true,
    });
  }
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: '555',
    role: 'member',
    status: 'active',
    requesterName: 'Alice',
  });
  await db.insert(channelAllowedConversations).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'discord',
      conversationId: DISCORD_DM,
      kind: 'private',
      role: 'member',
      status: 'active',
      requesterName: 'Paul',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      conversationId: WA_DM,
      kind: 'private',
      role: 'owner',
      status: 'active',
      requesterName: 'Someone',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'whatsapp',
      conversationId: WA_GROUP,
      kind: 'group',
      role: 'member',
      status: 'active',
      requesterName: 'Family',
    },
  ]);
});

beforeEach(() => {
  sent.length = 0;
  failNextSendWith.error = null;
  resetDeliveryCounterForTests();
  getAdapterMock.mockImplementation((channel: string) => {
    const a = fakeAdapter(channel);
    // WhatsApp cannot list DMs: the allowlist is what the tool shows.
    if (channel === 'whatsapp') return { sendText: a.sendText, sendMedia: a.sendMedia };
    return a;
  });
});

/** The address the model RECEIVED for a conversation: its entry in list_conversations, by name. */
async function handleReceived(channel: 'discord' | 'telegram', name: string): Promise<string> {
  const out = await listConversations.execute({ channel }, ctx());
  const entry = out.conversations.find((c) => c.name === name);
  if (!entry) throw new Error(`no ${channel} conversation named ${name}`);
  return entry.conversationId;
}

describe('conversation handles, model ↔ send tools @cap:parler-par-canal-externe/moteur', () => {
  it('list_conversations never hands the model a channel id — WhatsApp, Telegram, Discord', async () => {
    const wa = await listConversations.execute({ channel: 'whatsapp' }, ctx());
    const tg = await listConversations.execute({ channel: 'telegram' }, ctx());
    const dc = await listConversations.execute({ channel: 'discord' }, ctx());
    const ids = {
      whatsapp: [WA_DM, WA_GROUP, '33612345678'],
      telegram: ['555'],
      discord: [DISCORD_DM, DISCORD_UNAPPROVED],
    };
    for (const [channel, out] of [
      ['whatsapp', wa],
      ['telegram', tg],
      ['discord', dc],
    ] as const) {
      const raw = JSON.stringify(out);
      for (const id of ids[channel])
        expect({ channel, leaks: raw.includes(id) }).toEqual({ channel, leaks: false });
      for (const c of out.conversations) expect(c.conversationId).toMatch(CONVERSATION_HANDLE_RE);
    }
    // Each handle is THE handle of its conversation in this entity.
    expect(wa.conversations.find((c) => c.name === 'Someone')?.conversationId).toBe(
      await conversationHandleFor(db as unknown as ToolContext['db'], {
        entityId: seed.entityId,
        channel: 'whatsapp',
        conversationId: WA_DM,
      }),
    );
    expect(dc.conversations.map((c) => [c.name, c.approved])).toEqual([
      ['paul', true],
      ['#general', false],
    ]);
  });

  it('a send tool given a handle reaches the conversation AND the channel it names', async () => {
    const handle = await handleReceived('discord', 'paul');
    await sendMessage.execute({ chatId: handle, text: 'hello Paul' }, ctx());
    // A Telegram job, a Discord conversation: the handle carries its channel,
    // the token and the adapter follow it.
    expect(sent).toEqual([
      { channel: 'discord', token: 'dc-tok', chatId: DISCORD_DM, what: 'hello Paul' },
    ]);
  });

  it('the allowlist check still applies behind a handle', async () => {
    const handle = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: seed.entityId,
      channel: 'discord',
      conversationId: DISCORD_UNAPPROVED,
    });
    await expect(sendMessage.execute({ chatId: handle, text: 'x' }, ctx())).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });
    expect(sent).toEqual([]);
  });

  it('a media tool takes a handle the same way', async () => {
    const file = path.join(tmpdir(), `handle-${Date.now()}.png`);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handle = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: seed.entityId,
      channel: 'telegram',
      conversationId: '555',
    });
    await sendImage.execute({ source: file, chatId: handle }, ctx());
    expect(sent).toEqual([{ channel: 'telegram', token: 'tg-tok', chatId: '555', what: 'photo' }]);
  });

  it('a handle of another entity is refused — it names nothing here', async () => {
    const [other] = await db
      .insert(entities)
      .values({ userId: seed.userId, name: 'Other', slug: `other-${Date.now()}` })
      .returning();
    const theirs = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: other!.id,
      channel: 'telegram',
      conversationId: '555',
    });
    await expect(sendMessage.execute({ chatId: theirs, text: 'x' }, ctx())).rejects.toMatchObject({
      name: 'conversation_handle_unknown',
    });
    expect(sent).toEqual([]);
  });

  it('an unknown handle is refused, loud', async () => {
    await expect(
      sendMessage.execute({ chatId: 'conv_zzzzzzzzzz', text: 'x' }, ctx()),
    ).rejects.toMatchObject({ name: 'conversation_handle_unknown' });
  });

  it('a handle whose channel contradicts `channel` is refused', async () => {
    const handle = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: seed.entityId,
      channel: 'discord',
      conversationId: DISCORD_DM,
    });
    await expect(
      sendMessage.execute({ chatId: handle, text: 'x', channel: 'telegram' }, ctx()),
    ).rejects.toMatchObject({ name: 'conversation_handle_channel_mismatch' });
    // The same channel named explicitly is no contradiction.
    await sendMessage.execute({ chatId: handle, text: 'y', channel: 'discord' }, ctx());
    expect(sent.map((s) => [s.channel, s.chatId])).toEqual([['discord', DISCORD_DM]]);
  });

  it('a raw id still works as before, allowlist check included', async () => {
    await sendMessage.execute({ chatId: '555', text: 'raw' }, ctx());
    expect(sent).toEqual([{ channel: 'telegram', token: 'tg-tok', chatId: '555', what: 'raw' }]);
    await expect(sendMessage.execute({ chatId: '999', text: 'x' }, ctx())).rejects.toMatchObject({
      name: 'telegram_chat_not_allowed',
    });
  });

  it("the job's own chat as a handle skips the allowlist check, like its raw id", async () => {
    // 777 has NO allowlist row: only the job's-own-chat rule lets it through.
    const own = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: seed.entityId,
      channel: 'telegram',
      conversationId: '777',
    });
    await sendMessage.execute({ chatId: own, text: 'by handle' }, ctx());
    await sendMessage.execute({ chatId: '777', text: 'by id' }, ctx());
    expect(sent.map((s) => [s.channel, s.chatId, s.what])).toEqual([
      ['telegram', '777', 'by handle'],
      ['telegram', '777', 'by id'],
    ]);
    // On a job with ANOTHER chat, the same handle is an ordinary target, checked.
    await expect(
      sendMessage.execute({ chatId: own, text: 'x' }, ctx({ jobChatId: '888' })),
    ).rejects.toMatchObject({ name: 'telegram_chat_not_allowed' });
  });

  it("a platform's error text never hands the model the channel id", async () => {
    const handle = await conversationHandleFor(db as unknown as ToolContext['db'], {
      entityId: seed.entityId,
      channel: 'discord',
      conversationId: DISCORD_DM,
    });
    failNextSendWith.error = new DeliveryError(
      'send_failed',
      `send_failed: Discord HTTP error 404: /channels/${DISCORD_DM}/messages`,
    );
    const err = (await sendMessage
      .execute({ chatId: handle, text: 'x' }, ctx())
      .catch((e: unknown) => e)) as DeliveryError;
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toBe(`send_failed: Discord HTTP error 404: /channels/${handle}/messages`);
  });

  it('one conversation, one handle: across two jobs, two bots of one entity, a recreated row', async () => {
    const first = await listConversations.execute({ channel: 'discord' }, ctx());
    const again = await listConversations.execute({ channel: 'discord' }, ctx({ jobId: 'job-2' }));
    expect(again.conversations).toEqual(first.conversations);

    // A second bot of the same owner on the same Discord DM: its own binding,
    // its own allowlist row — and the SAME handle.
    await db.insert(channelBindings).values({
      entityId: seed.entityId,
      agentId: secondAgentId,
      channel: 'discord',
      credentials: JSON.stringify({ botToken: 'dc-tok-2' }),
      enabled: true,
    });
    const [row] = await db
      .insert(channelAllowedConversations)
      .values({
        entityId: seed.entityId,
        agentId: secondAgentId,
        channel: 'discord',
        conversationId: DISCORD_DM,
        kind: 'private',
        status: 'active',
        requesterName: 'Paul',
      })
      .returning();
    const asSecond = () =>
      listConversations.execute(
        { channel: 'discord' },
        ctx({ agentId: secondAgentId, jobId: 'job-3' }),
      );
    const paulOf = (out: Awaited<ReturnType<typeof asSecond>>) =>
      out.conversations.find((c) => c.name === 'paul')?.conversationId;
    expect(paulOf(await asSecond())).toBe(paulOf(first));

    // Its allowlist row deleted and recreated: still the same handle.
    await db.delete(channelAllowedConversations).where(eq(channelAllowedConversations.id, row!.id));
    await db.insert(channelAllowedConversations).values({
      entityId: seed.entityId,
      agentId: secondAgentId,
      channel: 'discord',
      conversationId: DISCORD_DM,
      kind: 'private',
      status: 'active',
    });
    expect(paulOf(await asSecond())).toBe(paulOf(first));
  });
});
