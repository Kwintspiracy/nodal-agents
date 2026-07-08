// conversation-id.test.ts — resolveConversationId assigns the right
// conversation_id for the Jobs page grouping (migration 0059): same tuple +
// short gap → inherit; gap past the idle-reset window → fresh id; no prior
// job → fresh id.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, eq } from '@nodal-agents/db';
import { resolveConversationId } from '../../job/conversation-id.ts';
import { IDLE_RESET_MS } from '../../job/thread-history.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentJobs);
});

/** Insert a prior job in the given thread, `minutesAgo` before now, optionally
 * completed `completedMinutesAgo` before now (defaults to still-open — the
 * gap falls back to created_at, mirroring thread-history.ts's convention). */
async function insertPriorJob(opts: {
  chatId: string;
  conversationId: string | null;
  minutesAgo: number;
  completedMinutesAgo?: number;
}): Promise<void> {
  const createdAt = new Date(Date.now() - opts.minutesAgo * 60_000);
  await db.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'telegram',
    task: 'prior turn',
    chatId: opts.chatId,
    status: 'completed',
    conversationId: opts.conversationId ?? undefined,
    createdAt,
    ...(opts.completedMinutesAgo !== undefined
      ? { completedAt: new Date(Date.now() - opts.completedMinutesAgo * 60_000) }
      : {}),
  });
}

describe('resolveConversationId', () => {
  it('mints a fresh id when there is no prior job in the thread', async () => {
    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-fresh',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('inherits the prior job conversation_id when the gap is short', async () => {
    const priorConvId = '11111111-1111-4111-8111-111111111111';
    await insertPriorJob({
      chatId: 'chat-short-gap',
      conversationId: priorConvId,
      // Delivered 5 minutes ago — well under IDLE_RESET_MS.
      minutesAgo: 6,
      completedMinutesAgo: 5,
    });

    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-short-gap',
    });
    expect(id).toBe(priorConvId);
  });

  it('mints a fresh id when the gap exceeds the idle-reset window', async () => {
    const priorConvId = '22222222-2222-4222-8222-222222222222';
    const pastResetMinutes = IDLE_RESET_MS / 60_000 + 10;
    await insertPriorJob({
      chatId: 'chat-long-gap',
      conversationId: priorConvId,
      minutesAgo: pastResetMinutes + 1,
      completedMinutesAgo: pastResetMinutes,
    });

    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-long-gap',
    });
    expect(id).not.toBe(priorConvId);
  });

  it('mints a fresh id when the prior job predates the conversation_id column (null)', async () => {
    await insertPriorJob({
      chatId: 'chat-legacy',
      conversationId: null,
      minutesAgo: 2,
      completedMinutesAgo: 1,
    });

    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-legacy',
    });
    expect(id).toBeTruthy();
  });

  it('does not cross tuples — a different chat_id never inherits', async () => {
    const priorConvId = '33333333-3333-4333-8333-333333333333';
    await insertPriorJob({
      chatId: 'chat-a',
      conversationId: priorConvId,
      minutesAgo: 1,
      completedMinutesAgo: 0,
    });

    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-b',
    });
    expect(id).not.toBe(priorConvId);
  });
});

// Sanity check on the row's actual persisted value, not just the resolver's
// return — assert against a real DB row like the rest of this suite does.
describe('resolveConversationId — persisted end-to-end', () => {
  it('a job inserted with the resolved id round-trips through the DB', async () => {
    const priorConvId = '44444444-4444-4444-8444-444444444444';
    await insertPriorJob({
      chatId: 'chat-e2e',
      conversationId: priorConvId,
      minutesAgo: 3,
      completedMinutesAgo: 2,
    });

    const id = await resolveConversationId({
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'chat-e2e',
    });

    const [inserted] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        task: 'current turn',
        chatId: 'chat-e2e',
        conversationId: id,
      })
      .returning();

    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, inserted!.id));
    expect(row!.conversationId).toBe(priorConvId);
  });
});
