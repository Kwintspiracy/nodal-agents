// chat.test.ts — POST /api/chat entity authorization (findings #4/#5).
//
// A trusted caller (WORKER_SECRET) keeps the pre-existing behavior: the body's
// entityId is trusted as-is. An untrusted session bearer-token caller may only
// run a turn for its OWN entity (session.entityId) — a mismatched body entityId
// must be rejected BEFORE any chat turn runs (no read/write for the other
// entity), not merely fail later for an unrelated reason.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { entities, entityLlmKeys, agents, conversations, chatMessages } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import type { AuthProvider, AuthSession } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seedA: { userId: string; entityId: string; agentId: string; jobId: string };
let entityB: string;
let agentB: string;
let conversationB: string;

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'bearer-token',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: 'unused-in-this-test',
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

// Simulates a real end-user session-bearer-token call: getSession only
// resolves a session when the request carries the 'x-test-session' marker
// (mirroring production, where a WORKER_SECRET server-to-server call carries
// no user cookie and therefore no session at all).
class StubSessionAuthProvider implements AuthProvider {
  constructor(private readonly session: AuthSession) {}
  getSession(req: Request): Promise<AuthSession | null> {
    if (req.headers.get('x-test-session') === '1') {
      return Promise.resolve(this.session);
    }
    return Promise.resolve(null);
  }
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seedA = await seedMinimal(db);

  // Force the "own entity, own agent" test down the fast, deterministic
  // agent_no_llm_configured path instead of a real network call — this test
  // only needs to prove the authorization gate did NOT block it.
  await db.update(agents).set({ llmKeyId: null }).where(eq(agents.id, seedA.agentId));

  // Entity B: a fully separate tenant with its own agent + conversation, so a
  // would-be cross-tenant call has a real target to (illegitimately) act on.
  const [entityBRow] = await db
    .insert(entities)
    .values({ userId: seedA.userId, name: 'Entity B', slug: `entity-b-${crypto.randomUUID()}` })
    .returning();
  entityB = entityBRow!.id;

  const [llmKeyB] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: entityB,
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1', // unroutable — fails fast if ever reached
      nickname: 'Entity B LLM Key',
      isActive: true,
    })
    .returning();

  const [agentBRow] = await db
    .insert(agents)
    .values({
      entityId: entityB,
      name: 'Agent B',
      slug: `agent-b-${crypto.randomUUID()}`,
      personality: 'You are agent B.',
      llmKeyId: llmKeyB!.id,
      active: true,
    })
    .returning();
  agentB = agentBRow!.id;

  const [conversationBRow] = await db
    .insert(conversations)
    .values({ entityId: entityB, agentId: agentB, title: 'Conversation B' })
    .returning();
  conversationB = conversationBRow!.id;

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' });
  const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient,
    registry,
    authProvider: new StubSessionAuthProvider({ userId: seedA.userId, entityId: seedA.entityId }),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

describe('POST /api/chat — entity authorization', () => {
  it('untrusted session caller with mismatched body entityId gets 403 and runs no chat turn', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({
          entityId: entityB,
          agentId: agentB,
          conversationId: conversationB,
          message: 'cross-tenant attempt',
        }),
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');

    // No effect: entity B's conversation was never touched.
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationB));
    expect(rows).toHaveLength(0);
  });

  it('untrusted session caller may act on its OWN entity', async () => {
    const [ownConversation] = await db
      .insert(conversations)
      .values({ entityId: seedA.entityId, agentId: seedA.agentId, title: 'Own conversation' })
      .returning();

    const res = await app.fetch(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({
          entityId: seedA.entityId,
          agentId: seedA.agentId,
          conversationId: ownConversation!.id,
          message: 'hello',
        }),
      }),
    );

    // Not blocked by authorization — whatever happens next is pre-existing
    // business logic (this agent's LLM key isn't wired for a real call here).
    expect(res.status).not.toBe(403);
  });

  // 30s: the trusted path exercises the real LLM attempt loop against a dead
  // endpoint — the 2026-07-18 retry policy makes that 4 attempts with backoff,
  // which overruns the 5s default when the host is loaded.
  it(
    'trusted WORKER_SECRET caller keeps unchanged behavior (body entityId trusted as-is)',
    { timeout: 30_000 },
    async () => {
      const res = await app.fetch(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
          body: JSON.stringify({
            entityId: entityB,
            agentId: agentB,
            conversationId: conversationB,
            message: 'trusted call for entity B',
          }),
        }),
      );

      // Not rejected by the authorization gate — the trusted path is unchanged.
      expect(res.status).not.toBe(403);
    },
  );
});
