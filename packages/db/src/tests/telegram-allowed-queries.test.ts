// telegram-allowed-queries.test.ts
// Unit tests for packages/db/src/queries/telegram-allowed.ts (isChatAllowed, F1).
// Uses pglite (spinUpTestDb) so no external DB is needed.
//
// Coverage:
//  - active row scoped to the agent → allowed
//  - active row scoped to the entity (different agent, same entity) → allowed
//    (delegated worker inheriting the entity ROOT's bot token)
//  - pending row → not allowed
//  - no row at all → not allowed
//  - active row for a DIFFERENT entity/agent → not allowed (no cross-tenant leak)

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { telegramAllowedChats, agents } from '../schema/index.ts';
import { isChatAllowed } from '../queries/telegram-allowed.ts';

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

describe('isChatAllowed', () => {
  it('returns true for an active row scoped to the agent', async () => {
    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: 'chat-agent-active',
      role: 'member',
      status: 'active',
    });

    await expect(
      isChatAllowed(db, { entityId, agentId, chatId: 'chat-agent-active' }),
    ).resolves.toBe(true);
  });

  it('returns true for an active row scoped to the entity but a DIFFERENT agent (delegated worker)', async () => {
    // A second agent in the same entity — the row is approved on it, but a
    // delegated worker calling with the entity's root token should still see
    // it as allowed because the lookup is OR'd on entityId.
    const [otherAgent] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Other Agent',
        slug: `other-agent-${Date.now()}`,
        personality: 'You are another test agent.',
      })
      .returning();
    if (!otherAgent) throw new Error('Failed to seed other agent');

    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId: otherAgent.id,
      chatId: 'chat-entity-scoped',
      role: 'member',
      status: 'active',
    });

    // Called with the ORIGINAL agentId (a different agent than the row's
    // agentId) but the same entityId — must still resolve to allowed.
    await expect(
      isChatAllowed(db, { entityId, agentId, chatId: 'chat-entity-scoped' }),
    ).resolves.toBe(true);
  });

  it('returns false for a pending row', async () => {
    await db.insert(telegramAllowedChats).values({
      entityId,
      agentId,
      chatId: 'chat-pending',
      role: 'member',
      status: 'pending',
    });

    await expect(isChatAllowed(db, { entityId, agentId, chatId: 'chat-pending' })).resolves.toBe(
      false,
    );
  });

  it('returns false when no row exists for the chat', async () => {
    await expect(isChatAllowed(db, { entityId, agentId, chatId: 'chat-unknown' })).resolves.toBe(
      false,
    );
  });

  it('returns false for a chat approved on an unrelated entity/agent (no cross-tenant leak)', async () => {
    const otherSeed = await seedMinimal(db);

    await db.insert(telegramAllowedChats).values({
      entityId: otherSeed.entityId,
      agentId: otherSeed.agentId,
      chatId: 'chat-other-tenant',
      role: 'member',
      status: 'active',
    });

    await expect(
      isChatAllowed(db, { entityId, agentId, chatId: 'chat-other-tenant' }),
    ).resolves.toBe(false);
  });
});
