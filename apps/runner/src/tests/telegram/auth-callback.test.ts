// auth-callback.test.ts — H-1 inbound-chat authorization via inline buttons.
//
// Focus: the SECURITY boundary — only the bot's OWNER may allow/deny a pending
// chat — and the real DB effect (allow → row active, deny → row deleted).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { telegramAllowedChats, channelAllowedConversations, agents } from '@nodal-agents/db';
import type { TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import {
  handleAuthCallback,
  parseAuthCallbackData,
  buildAuthConfirmKeyboard,
} from '../../telegram/auth-callback.ts';

// Telegram API calls (answerCallbackQuery / editMessageText) hit fetch — stub ok.
vi.stubGlobal(
  'fetch',
  vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
);

const OWNER_CHAT = '900001';
const STRANGER_CHAT = '900002';

let db: TestDb;
let deps: RunnerDeps;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ telegramBotToken: '123:fake' }).where(eq(agents.id, seed.agentId));
  deps = { db: db as RunnerDeps['db'] } as RunnerDeps;
});

/** Seed the owner + a fresh pending stranger row; returns the pending row id. */
async function seedPending(): Promise<string> {
  await db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.agentId, seed.agentId));
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    chatId: OWNER_CHAT,
    role: 'owner',
    status: 'active',
  });
  const [pending] = await db
    .insert(telegramAllowedChats)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: STRANGER_CHAT,
      role: 'member',
      status: 'pending',
      requesterName: 'Bob',
    })
    .returning({ id: telegramAllowedChats.id });
  return pending!.id;
}

function tap(rowId: string, decision: 'a' | 'd', fromChat: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb-1',
      data: `tgauth:${rowId}:${decision}`,
      message: { message_id: 5, chat: { id: Number(fromChat), type: 'private' } },
    },
  } as unknown as TelegramUpdate;
}

describe('parseAuthCallbackData', () => {
  it('parses allow/deny and rejects foreign or malformed data', () => {
    expect(parseAuthCallbackData('tgauth:abc:a')).toEqual({
      allowedChatId: 'abc',
      decision: 'allow',
    });
    expect(parseAuthCallbackData('tgauth:abc:d')).toEqual({
      allowedChatId: 'abc',
      decision: 'deny',
    });
    expect(parseAuthCallbackData('apr:abc:a')).toBeNull(); // an approval tap, not ours
    expect(parseAuthCallbackData('tgauth:abc')).toBeNull();
    expect(parseAuthCallbackData(undefined)).toBeNull();
  });
});

describe('buildAuthConfirmKeyboard', () => {
  it('carries the row id in both button payloads', () => {
    const kb = buildAuthConfirmKeyboard('row-9');
    expect(kb[0]![0]!.callback_data).toBe('tgauth:row-9:a');
    expect(kb[0]![1]!.callback_data).toBe('tgauth:row-9:d');
  });
});

describe('handleAuthCallback — security + effect', () => {
  it('OWNER allow → the pending row goes active', async () => {
    const rowId = await seedPending();
    const res = await handleAuthCallback({
      update: tap(rowId, 'a', OWNER_CHAT),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });
    expect(res).toMatchObject({ handled: true, decision: 'allow', chatId: STRANGER_CHAT });

    const [row] = await db
      .select({ status: telegramAllowedChats.status })
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.id, rowId));
    expect(row?.status).toBe('active');
  });

  it('OWNER deny → the pending row is deleted (chat stays blocked)', async () => {
    const rowId = await seedPending();
    const res = await handleAuthCallback({
      update: tap(rowId, 'd', OWNER_CHAT),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });
    expect(res).toMatchObject({ handled: true, decision: 'deny' });

    const rows = await db
      .select()
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.id, rowId));
    expect(rows).toHaveLength(0);
  });

  it('a NON-owner tap is refused and leaves the row pending', async () => {
    const rowId = await seedPending();
    const res = await handleAuthCallback({
      update: tap(rowId, 'a', STRANGER_CHAT), // the stranger taps their own request
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });
    expect(res).toMatchObject({ handled: false, reason: 'not_owner' });

    const [row] = await db
      .select({ status: telegramAllowedChats.status })
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.id, rowId));
    expect(row?.status).toBe('pending'); // unchanged
  });

  it("a tap on another bot's row is refused (agent mismatch)", async () => {
    const rowId = await seedPending();
    const res = await handleAuthCallback({
      update: tap(rowId, 'a', OWNER_CHAT),
      receivingAgentId: '00000000-0000-0000-0000-0000000000ff', // not this row's agent
      botToken: '123:fake',
      deps,
    });
    expect(res).toMatchObject({ handled: false, reason: 'agent_mismatch' });

    // Row untouched.
    const [row] = await db
      .select({ status: telegramAllowedChats.status })
      .from(telegramAllowedChats)
      .where(and(eq(telegramAllowedChats.id, rowId)));
    expect(row?.status).toBe('pending');
  });
});

// ─── S3 dual-write mirror (channel_allowed_conversations) ──────────────────
// handler.ts's checkChatAuthorization dual-writes the neutral table on
// insert; these tests seed that mirror the way it would exist in production
// and assert handleAuthCallback's allow/deny paths keep it in sync too.

async function seedNeutralMirror(): Promise<void> {
  await db
    .delete(channelAllowedConversations)
    .where(eq(channelAllowedConversations.agentId, seed.agentId));
  await db.insert(channelAllowedConversations).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      conversationId: OWNER_CHAT,
      kind: 'private',
      role: 'owner',
      status: 'active',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      conversationId: STRANGER_CHAT,
      kind: 'private',
      role: 'member',
      status: 'pending',
      requesterName: 'Bob',
    },
  ]);
}

describe('handleAuthCallback — S3 dual-write mirror', () => {
  it('OWNER allow also flips the channel_allowed_conversations mirror to active', async () => {
    const rowId = await seedPending();
    await seedNeutralMirror();

    await handleAuthCallback({
      update: tap(rowId, 'a', OWNER_CHAT),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });

    const [mirrored] = await db
      .select({ status: channelAllowedConversations.status })
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, seed.agentId),
          eq(channelAllowedConversations.channel, 'telegram'),
          eq(channelAllowedConversations.conversationId, STRANGER_CHAT),
        ),
      );
    expect(mirrored?.status).toBe('active');
  });

  it('OWNER deny also deletes the channel_allowed_conversations mirror row', async () => {
    const rowId = await seedPending();
    await seedNeutralMirror();

    await handleAuthCallback({
      update: tap(rowId, 'd', OWNER_CHAT),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });

    const mirrored = await db
      .select()
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, seed.agentId),
          eq(channelAllowedConversations.channel, 'telegram'),
          eq(channelAllowedConversations.conversationId, STRANGER_CHAT),
        ),
      );
    expect(mirrored).toHaveLength(0);
  });

  it('a refused (non-owner) tap leaves the mirror row pending, untouched', async () => {
    const rowId = await seedPending();
    await seedNeutralMirror();

    await handleAuthCallback({
      update: tap(rowId, 'a', STRANGER_CHAT),
      receivingAgentId: seed.agentId,
      botToken: '123:fake',
      deps,
    });

    const [mirrored] = await db
      .select({ status: channelAllowedConversations.status })
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, seed.agentId),
          eq(channelAllowedConversations.channel, 'telegram'),
          eq(channelAllowedConversations.conversationId, STRANGER_CHAT),
        ),
      );
    expect(mirrored?.status).toBe('pending');
  });
});
