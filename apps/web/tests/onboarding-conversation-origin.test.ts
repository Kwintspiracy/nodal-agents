// @vitest-environment node
/**
 * Integration tests — onboarding conversation must never leak into the
 * dashboard's Chats list (migration 0065, `conversations.origin`).
 *
 * Uses a real pglite in-memory DB (spinUpTestDb / seedMinimal from
 * @nodal-agents/db/test-utils) so assertions target actual DB rows — not
 * mocks of mocks. Mirrors the harness in audit2-db-integrity-actions.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { conversations, chatMessages, entities, eq } from '@nodal-agents/db';
import type * as NodalMemory from '@nodal-agents/memory';

// ─── Module-level state ───────────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';
let _rootAgentId = 'placeholder-agent-id';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async (_req: Request) => ({
      userId: _testUserId,
      entityId: _testEntityId,
    }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUserWithEntity: vi.fn(),
  applyActiveEntity: vi.fn(async (session: unknown) => session),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
}));

vi.mock('../src/lib/cli-config.ts', () => ({
  NODALAI_CONFIG_PATH: '/tmp/test/config.json',
  readNodalaiConfig: vi.fn(),
  mergeNodalaiConfig: vi.fn(),
}));

vi.mock('@nodal-agents/memory', async () => {
  const actual = await vi.importActual<typeof NodalMemory>('@nodal-agents/memory');
  return {
    ...actual,
    listMemories: vi.fn(),
    deleteMemory: vi.fn(),
    updateMemory: vi.fn(),
  };
});

vi.mock('@nodal-agents/adapter-mcp', () => ({
  connectMcp: vi.fn(),
}));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
  process.env['RUNNER_URL'] = 'http://localhost:3001';
  process.env['WORKER_SECRET'] = 'test-bearer-789';

  _setMasterKeyForTests(randomBytes(32));

  const { db } = await spinUpTestDb();
  _testDb = db;

  const seed = await seedMinimal(db);
  _testUserId = seed.userId;
  _testEntityId = seed.entityId;
  _rootAgentId = seed.agentId;

  // createConversationAction/listConversationsAction both resolve the
  // entity's ROOT via entities.rootAgentId.
  await db
    .update(entities)
    .set({ rootAgentId: _rootAgentId })
    .where(eq(entities.id, _testEntityId));
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

describe('onboarding conversation — origin marker (migration 0065)', () => {
  it('an onboarding conversation is created with origin="onboarding" and stays functional (real DB row)', async () => {
    const { createConversationAction } = await import('../src/lib/actions.ts');
    const res = await createConversationAction({ origin: 'onboarding' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [row] = await _testDb!
      .select({ origin: conversations.origin, entityId: conversations.entityId })
      .from(conversations)
      .where(eq(conversations.id, res.data.id));
    expect(row?.origin).toBe('onboarding');
    expect(row?.entityId).toBe(_testEntityId);

    // "stays functional during onboarding" — chat_messages can still be
    // attached to it exactly like a normal conversation (FK holds).
    const [msg] = await _testDb!
      .insert(chatMessages)
      .values({
        entityId: _testEntityId,
        agentId: _rootAgentId,
        conversationId: res.data.id,
        role: 'user',
        content: 'hello',
      })
      .returning();
    expect(msg?.conversationId).toBe(res.data.id);
  });

  it('listConversationsAction never returns the onboarding conversation — whether it was skipped or finished', async () => {
    const { createConversationAction, listConversationsAction } =
      await import('../src/lib/actions.ts');

    // Case 1: started then skipped — the conversation is never touched again
    // after creation (no "mark as skipped" write path exists, by design —
    // the marker is stamped once, at creation).
    const skipped = await createConversationAction({ origin: 'onboarding' });
    expect(skipped.ok).toBe(true);

    // Case 2: started, interview fully completed (more messages, same
    // conversation row — completion never rewrites origin either).
    const finished = await createConversationAction({ origin: 'onboarding' });
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      await _testDb!.insert(chatMessages).values({
        entityId: _testEntityId,
        agentId: _rootAgentId,
        conversationId: finished.data.id,
        role: 'assistant',
        content: 'Nice to meet you! [[INTERVIEW_DONE]]',
      });
    }

    // A real user chat, created the normal way (no origin passed).
    const userChat = await createConversationAction();
    expect(userChat.ok).toBe(true);

    const list = await listConversationsAction();
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    const ids = list.data.conversations.map((c) => c.id);
    if (skipped.ok) expect(ids).not.toContain(skipped.data.id);
    if (finished.ok) expect(ids).not.toContain(finished.data.id);
    if (userChat.ok) expect(ids).toContain(userChat.data.id);

    // Both onboarding rows still exist in the DB — only hidden from the list.
    const onboardingRows = await _testDb!
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.origin, 'onboarding'));
    const onboardingIds = onboardingRows.map((r) => r.id);
    if (skipped.ok) expect(onboardingIds).toContain(skipped.data.id);
    if (finished.ok) expect(onboardingIds).toContain(finished.data.id);
  });

  it('a normal chat conversation (origin default) has origin="user" in DB', async () => {
    const { createConversationAction } = await import('../src/lib/actions.ts');
    const res = await createConversationAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [row] = await _testDb!
      .select({ origin: conversations.origin })
      .from(conversations)
      .where(eq(conversations.id, res.data.id));
    expect(row?.origin).toBe('user');
  });
});
