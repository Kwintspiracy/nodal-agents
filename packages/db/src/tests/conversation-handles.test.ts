// conversation-handles.test.ts — l'adresse qu'un modèle lit pour une
// conversation (#824) : tirée au hasard, stable, une par (entité, canal,
// conversation), relue dans son entité seulement.
//
// Mutations vérifiées :
//   - `onConflictDoNothing()` retiré de `conversationHandlesFor` → le
//     get-or-create concurrent lève sur la clé unique ;
//   - le filtre `entityId` retiré de `conversationsOfHandles` → le handle d'une
//     autre entité se résout, « un handle d'une autre entité ne nomme rien ici »
//     rougit.

import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { CONVERSATION_HANDLE_RE } from '@nodal-agents/shared';
import { spinUpTestDb, seedMinimal, type TestDb } from './helpers.ts';
import * as schema from '../schema/index.ts';
import {
  conversationHandleFor,
  conversationHandlesFor,
  conversationsOfHandles,
  resolveConversationHandle,
  showConversationsTo,
  conversationIdsAsHandles,
} from '../queries/conversation-handles.ts';

const WA_DM = '33612345678@s.whatsapp.net';

let db: TestDb;
let entityId: string;
let agentId: string;
let userId: string;

beforeEach(async () => {
  ({ db } = await spinUpTestDb());
  ({ entityId, agentId, userId } = await seedMinimal(db));
});

async function otherEntity(): Promise<string> {
  const [e] = await db
    .insert(schema.entities)
    .values({ userId, name: 'Other', slug: `other-${Date.now()}-${Math.random()}` })
    .returning();
  return e!.id;
}

describe('conversation handles @cap:parler-par-canal-externe/moteur', () => {
  it('a handle has the opaque form and carries nothing of the id', async () => {
    for (const [channel, conversationId] of [
      ['whatsapp', WA_DM],
      ['telegram', '123456789'],
      ['discord', '1188000000000000001'],
      ['slack', 'D0123ABCD'],
    ] as const) {
      const h = await conversationHandleFor(db, { entityId, channel, conversationId });
      expect(h).toMatch(CONVERSATION_HANDLE_RE);
      // Ni le numéro, ni un morceau de l'id.
      expect(h).not.toContain(conversationId.slice(0, 6).toLowerCase());
    }
  });

  it('the same conversation gives the same handle, every call — never a second row', async () => {
    const a = await conversationHandleFor(db, {
      entityId,
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    const b = await conversationHandleFor(db, {
      entityId,
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    expect(b).toBe(a);
    const rows = await db.select().from(schema.conversationHandles);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a, entityId, channel: 'whatsapp', conversationId: WA_DM });
  });

  it('is random, never derived: the same id in two entities gives two handles', async () => {
    const other = await otherEntity();
    const a = await conversationHandleFor(db, {
      entityId,
      channel: 'telegram',
      conversationId: '42',
    });
    const b = await conversationHandleFor(db, {
      entityId: other,
      channel: 'telegram',
      conversationId: '42',
    });
    expect(b).not.toBe(a);
  });

  it('the channel is part of the key: one id on two channels is two conversations', async () => {
    const a = await conversationHandleFor(db, {
      entityId,
      channel: 'telegram',
      conversationId: '42',
    });
    const b = await conversationHandleFor(db, {
      entityId,
      channel: 'discord',
      conversationId: '42',
    });
    expect(b).not.toBe(a);
    expect(await resolveConversationHandle(db, { entityId, handle: b })).toEqual({
      channel: 'discord',
      conversationId: '42',
    });
  });

  it('survives a deleted and recreated allowlist row', async () => {
    const insertRow = () =>
      db
        .insert(schema.channelAllowedConversations)
        .values({ entityId, agentId, channel: 'whatsapp', conversationId: WA_DM, status: 'active' })
        .returning();
    const [row] = await insertRow();
    const before = await conversationHandleFor(db, {
      entityId,
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    await db
      .delete(schema.channelAllowedConversations)
      .where(eq(schema.channelAllowedConversations.id, row!.id));
    const [recreated] = await insertRow();
    expect(recreated!.id).not.toBe(row!.id);
    expect(
      await conversationHandleFor(db, { entityId, channel: 'whatsapp', conversationId: WA_DM }),
    ).toBe(before);
  });

  it('a concurrent get-or-create gives ONE row, and every caller reads it', async () => {
    const handles = await Promise.all(
      Array.from({ length: 12 }, () =>
        conversationHandleFor(db, { entityId, channel: 'whatsapp', conversationId: WA_DM }),
      ),
    );
    expect(new Set(handles).size).toBe(1);
    const rows = await db
      .select()
      .from(schema.conversationHandles)
      .where(
        and(
          eq(schema.conversationHandles.entityId, entityId),
          eq(schema.conversationHandles.conversationId, WA_DM),
        ),
      );
    expect(rows.map((r) => r.id)).toEqual([handles[0]]);
  });

  it('a batch names each conversation once, mixing known and new ones', async () => {
    const known = await conversationHandleFor(db, {
      entityId,
      channel: 'slack',
      conversationId: 'C01',
    });
    const map = await conversationHandlesFor(db, {
      entityId,
      channel: 'slack',
      conversationIds: ['C01', 'C02', 'C02', 'C03'],
    });
    expect([...map.keys()].sort()).toEqual(['C01', 'C02', 'C03']);
    expect(map.get('C01')).toBe(known);
    expect(new Set(map.values()).size).toBe(3);
  });

  it('a handle of another entity names nothing here', async () => {
    const other = await otherEntity();
    const theirs = await conversationHandleFor(db, {
      entityId: other,
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    expect(await resolveConversationHandle(db, { entityId, handle: theirs })).toBeNull();
    expect(await resolveConversationHandle(db, { entityId: other, handle: theirs })).toEqual({
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    expect(await resolveConversationHandle(db, { entityId, handle: 'conv_aaaaaaaaaa' })).toBeNull();
  });

  it('refuses to name a conversation without an entity — loud, never a handle out of nowhere', async () => {
    await expect(
      conversationHandleFor(db, { entityId: null, channel: 'telegram', conversationId: '1' }),
    ).rejects.toThrow(/conversation_handle_no_entity/);
    await expect(
      conversationHandleFor(db, { entityId: '', channel: 'telegram', conversationId: '1' }),
    ).rejects.toThrow(/conversation_handle_no_entity/);
  });

  it('a person reads the real conversation where a model read the handle, in its entity only', async () => {
    const mine = await conversationHandleFor(db, {
      entityId,
      channel: 'whatsapp',
      conversationId: WA_DM,
    });
    const other = await otherEntity();
    const theirs = await conversationHandleFor(db, {
      entityId: other,
      channel: 'telegram',
      conversationId: '999',
    });
    const at = new Date('2026-10-20T10:00:00Z');
    const shown = await showConversationsTo(db, entityId, {
      input: { chatId: mine, text: 'hello' },
      notice: `[livraison effectuée : telegram_send_message → chat ${mine}]`,
      foreign: theirs,
      at,
      list: [mine],
    });
    expect(shown).toEqual({
      input: { chatId: WA_DM, text: 'hello' },
      notice: `[livraison effectuée : telegram_send_message → chat ${WA_DM}]`,
      // Un handle d'une autre entité n'est pas relu : rien n'est deviné.
      foreign: theirs,
      at,
      list: [WA_DM],
    });
    expect(shown.at).toBeInstanceOf(Date);
    expect((await conversationsOfHandles(db, { entityId, handles: [mine, theirs] })).size).toBe(1);
  });

  it('the database keeps the form: a row that is not a handle is refused', async () => {
    await expect(
      db
        .insert(schema.conversationHandles)
        .values({ id: WA_DM, entityId, channel: 'whatsapp', conversationId: WA_DM }),
    ).rejects.toThrow();
  });
});

// ─── #824, passe 1 : le texte DÉJÀ écrit, à la frontière du modèle ──────────
//
// Mutations vérifiées :
//   - `conversationIdsAsHandles` rendant `value` tel quel → « every id the
//     entity knows » rougit ;
//   - la garde de bord retirée de `conversationIdsPattern` (motif sans
//     lookbehind/lookahead) → « only a WHOLE id » rougit.
describe('stored text reaches the model with handles, never the ids @cap:parler-par-canal-externe/moteur', () => {
  async function allow(channel: string, conversationId: string, status = 'active') {
    if (channel === 'telegram') {
      await db
        .insert(schema.telegramAllowedChats)
        .values({ entityId, agentId, chatId: conversationId, status });
      return;
    }
    await db
      .insert(schema.channelAllowedConversations)
      .values({ entityId, agentId, channel, conversationId, status });
  }

  it('every id the entity knows — allowlists, pending requests, discovered conversations — becomes its handle', async () => {
    await allow('whatsapp', WA_DM);
    await allow('telegram', '199791464');
    await allow('discord', '1188000000000000001', 'pending');
    // Discovered by list_conversations, never approved: it has a handle row.
    const discovered = await conversationHandleFor(db, {
      entityId,
      channel: 'slack',
      conversationId: 'C0SLACK01',
    });
    const stored = {
      system: `Memory: Marie's WhatsApp is ${WA_DM}.`,
      messages: [
        { role: 'user', content: 'reply to 199791464' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'telegram_send_message',
              input: { chatId: '1188000000000000001', text: 'hi' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'list_conversations',
              output: { type: 'json', value: { conversations: [{ conversationId: 'C0SLACK01' }] } },
            },
          ],
        },
      ],
    };
    const shown = await conversationIdsAsHandles(db, entityId, stored);
    const text = JSON.stringify(shown);
    for (const id of [WA_DM, '199791464', '1188000000000000001', 'C0SLACK01']) {
      expect({ id, leaks: text.includes(id) }).toEqual({ id, leaks: false });
    }
    const handleOf = (channel: string, conversationId: string) =>
      conversationHandleFor(db, { entityId, channel, conversationId });
    expect(shown.system).toBe(`Memory: Marie's WhatsApp is ${await handleOf('whatsapp', WA_DM)}.`);
    expect(text).toContain(await handleOf('telegram', '199791464'));
    expect(text).toContain(discovered);
    // The stored value is untouched: the dashboard reads the truth.
    expect(stored.system).toContain(WA_DM);
  });

  it('only a WHOLE id: a longer number, a negative one, an id inside a JID stay as they are', async () => {
    await allow('telegram', '555');
    const text = 'chat 555, not 5551, not -555, not 555@s.whatsapp.net, not a555, not 555_x; (555)';
    const shown = await conversationIdsAsHandles(db, entityId, text);
    const h = await conversationHandleFor(db, {
      entityId,
      channel: 'telegram',
      conversationId: '555',
    });
    expect(shown).toBe(
      `chat ${h}, not 5551, not -555, not 555@s.whatsapp.net, not a555, not 555_x; (${h})`,
    );
  });

  it("another entity's conversation, an unknown id, a provider signature: untouched", async () => {
    const [other] = await db
      .insert(schema.entities)
      .values({ userId, name: 'Other', slug: `other-${Date.now()}` })
      .returning();
    const [theirAgent] = await db
      .insert(schema.agents)
      .values({
        entityId: other!.id,
        name: 'Their bot',
        slug: `their-${Date.now()}`,
        personality: 'p',
      })
      .returning();
    await db.insert(schema.channelAllowedConversations).values({
      entityId: other!.id,
      agentId: theirAgent!.id,
      channel: 'discord',
      conversationId: '777000000000000001',
      status: 'active',
    });
    await allow('whatsapp', WA_DM);
    const bytes = new Uint8Array([1, 2, 3]);
    const value = {
      prompt: 'see 777000000000000001 and 33600000000@s.whatsapp.net',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: WA_DM, providerOptions: { google: { sig: WA_DM } } }],
        },
        { role: 'user', content: [{ type: 'image', image: bytes }] },
      ],
    };
    const shown = await conversationIdsAsHandles(db, entityId, value);
    expect(shown.prompt).toBe(value.prompt);
    expect(shown.messages[0]!.content[0]).toMatchObject({
      text: expect.stringMatching(CONVERSATION_HANDLE_RE),
      providerOptions: { google: { sig: WA_DM } },
    });
    expect((shown.messages[1]!.content[0] as { image: unknown }).image).toBe(bytes);
  });

  it('an id known on two channels says nothing of which one: left as it is', async () => {
    await allow('telegram', '424242');
    await allow('discord', '424242');
    expect(await conversationIdsAsHandles(db, entityId, 'to 424242')).toBe('to 424242');
  });

  it('no entity, nothing known: the value comes back as it is', async () => {
    expect(await conversationIdsAsHandles(db, null, `x ${WA_DM}`)).toBe(`x ${WA_DM}`);
    expect(await conversationIdsAsHandles(db, entityId, `x ${WA_DM}`)).toBe(`x ${WA_DM}`);
  });
});
