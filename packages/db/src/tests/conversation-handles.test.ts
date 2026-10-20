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
