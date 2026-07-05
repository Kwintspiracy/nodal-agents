// agent.test.ts — POST /api/agent creates a row, returns jobId
// Asserts on the real DB row, not just call counts (invariant 5).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, entities } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider, seedLocalUser, LOCAL_ENTITY_ID } from '@nodal-agents/auth';
import type { AuthProvider, AuthSession } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MIN_TURNS: 3,
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
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Seed the local trust user+entity so LocalTrustProvider's entityId exists in DB
  await seedLocalUser(db as Parameters<typeof seedLocalUser>[0]);

  // Move seeded agent to the local-trust entity so agentRoute can find it
  // (LocalTrustProvider always returns LOCAL_ENTITY_ID as the entityId)
  await db
    .update(agents)
    .set({ entityId: LOCAL_ENTITY_ID, isDefault: true })
    .where(eq(agents.id, seed.agentId));

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const llmClient = createLlmClient({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6-20260217',
    apiKey: 'test-key',
  });

  const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient,
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

describe('POST /api/agent', () => {
  it('creates a job row and returns jobId', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Test task for agent route' }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; status: string };
    expect(body.status).toBe('pending');
    expect(body.jobId).toBeTruthy();

    // Assert on the real DB row (invariant 5)
    const rows = await db.select().from(agentJobs).where(eq(agentJobs.id, body.jobId));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.task).toBe('Test task for agent route');
    expect(row.status).toBe('pending');
    expect(row.channel).toBe('api');
  });

  it('returns 400 on missing task', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug: 'test' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 on task too long', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'x'.repeat(200_001) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown agent slug', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'hello', agentSlug: 'nonexistent-slug-xyz' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('agent_not_found');
  });

  it('respects specified channel', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'telegram task', channel: 'telegram', chatId: '12345' }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };

    const rows = await db
      .select({ channel: agentJobs.channel, chatId: agentJobs.chatId })
      .from(agentJobs)
      .where(eq(agentJobs.id, body.jobId));

    expect(rows[0]?.channel).toBe('telegram');
    expect(rows[0]?.chatId).toBe('12345');
  });
});

// ─── Entity authorization (findings #4/#5) ─────────────────────────────────
//
// agentSlug resolution has no entityId field in the body — the "entity of
// the request" is whatever the route derives. A trusted caller keeps the
// pre-existing session-or-null fallback (a WORKER_SECRET server call with no
// forwarded session resolves the slug GLOBALLY, across every entity — this
// is the pre-existing behavior for cron/internal/Telegram dispatch). An
// UNTRUSTED session bearer-token caller must never fall into that global
// resolution: its entity is always its own session's.

describe('POST /api/agent — entity authorization (bearer-token mode)', () => {
  let dbB: TestDb;
  let appBearer: ReturnType<typeof createApp>;
  let seedX: { userId: string; entityId: string; agentId: string; jobId: string };
  let seedXAgentSlug: string;
  let entityY: string;
  let agentYSlug: string;
  let agentYId: string;

  class StubSessionAuthProvider implements AuthProvider {
    constructor(private readonly session: AuthSession) {}
    getSession(req: Request): Promise<AuthSession | null> {
      // Mirrors production: a WORKER_SECRET server-to-server call carries no
      // user cookie/session; only an explicit test marker simulates one.
      if (req.headers.get('x-test-session') === '1') {
        return Promise.resolve(this.session);
      }
      return Promise.resolve(null);
    }
  }

  beforeAll(async () => {
    const result = await spinUpTestDb();
    dbB = result.db;
    seedX = await seedMinimal(dbB);
    const [seedXAgentRow] = await dbB
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, seedX.agentId));
    seedXAgentSlug = seedXAgentRow!.slug!;

    const [entityYRow] = await dbB
      .insert(entities)
      .values({ userId: seedX.userId, name: 'Entity Y', slug: `entity-y-${crypto.randomUUID()}` })
      .returning();
    entityY = entityYRow!.id;

    agentYSlug = `agent-y-${crypto.randomUUID()}`;
    const [agentYRow] = await dbB
      .insert(agents)
      .values({
        entityId: entityY,
        name: 'Agent Y',
        slug: agentYSlug,
        personality: 'You are agent Y.',
        active: true,
      })
      .returning();
    agentYId = agentYRow!.id;

    const registry = createToolRegistry();
    registerBuiltins(registry);
    const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' });
    const embeddingClient = createEmbeddingClient({ provider: 'keyword' });

    const depsBearer: RunnerDeps = {
      db: dbB as RunnerDeps['db'],
      llmClient,
      embeddingClient,
      registry,
      authProvider: new StubSessionAuthProvider({
        userId: seedX.userId,
        entityId: seedX.entityId,
      }),
      close: async () => {},
    };

    appBearer = createApp(depsBearer, { ...testEnv, AUTH_MODE: 'bearer-token' });
  });

  it('untrusted session caller cannot resolve another entity slug (blocked, no job created)', async () => {
    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({ task: 'cross-tenant attempt', agentSlug: agentYSlug }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('agent_not_found');

    const rows = await dbB.select().from(agentJobs).where(eq(agentJobs.agentId, agentYId));
    expect(rows).toHaveLength(0);
  });

  it('untrusted session caller can resolve its OWN entity slug', async () => {
    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({ task: 'own-entity task', agentSlug: seedXAgentSlug }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    const rows = await dbB
      .select({ agentId: agentJobs.agentId, entityId: agentJobs.entityId })
      .from(agentJobs)
      .where(eq(agentJobs.id, body.jobId));
    expect(rows[0]?.agentId).toBe(seedX.agentId);
    expect(rows[0]?.entityId).toBe(seedX.entityId);
  });

  it('trusted WORKER_SECRET caller keeps unchanged global slug resolution', async () => {
    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
        body: JSON.stringify({ task: 'trusted global lookup', agentSlug: agentYSlug }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    const rows = await dbB
      .select({ agentId: agentJobs.agentId })
      .from(agentJobs)
      .where(eq(agentJobs.id, body.jobId));
    expect(rows[0]?.agentId).toBe(agentYId);
  });

  // ─── F-2 (audit #2): parentJobId cross-entity injection ────────────────────
  //
  // Without an entity check on parentJobId, an untrusted bearer-token caller
  // for entity X could attach a new job as the child of entity Y's job, so
  // that when the new job completes, maybeResumeParent (execute.ts) injects
  // its result into entity Y's job — a cross-entity result injection.

  it('untrusted session caller cannot attach a new job as the child of another entity\'s job', async () => {
    const [entityYParentJob] = await dbB
      .insert(agentJobs)
      .values({
        entityId: entityY,
        agentId: agentYId,
        channel: 'api',
        task: 'entity Y parent job, awaiting delegation',
        status: 'awaiting_delegation',
      })
      .returning({ id: agentJobs.id });

    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({
          task: 'cross-entity parentJobId attempt',
          agentSlug: seedXAgentSlug,
          parentJobId: entityYParentJob!.id,
        }),
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('parent_job_entity_mismatch');

    // No child job was created pointing at entity Y's job.
    const rows = await dbB
      .select()
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, entityYParentJob!.id));
    expect(rows).toHaveLength(0);
  });

  it('untrusted session caller CAN attach a new job as the child of its OWN entity\'s job', async () => {
    const [ownParentJob] = await dbB
      .insert(agentJobs)
      .values({
        entityId: seedX.entityId,
        agentId: seedX.agentId,
        channel: 'api',
        task: 'own entity parent job, awaiting delegation',
        status: 'awaiting_delegation',
      })
      .returning({ id: agentJobs.id });

    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({
          task: 'own-entity parentJobId attempt',
          agentSlug: seedXAgentSlug,
          parentJobId: ownParentJob!.id,
        }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    const rows = await dbB
      .select({ parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(eq(agentJobs.id, body.jobId));
    expect(rows[0]?.parentJobId).toBe(ownParentJob!.id);
  });

  it('a non-existent parentJobId is refused for an untrusted caller', async () => {
    const res = await appBearer.fetch(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-session': '1' },
        body: JSON.stringify({
          task: 'bogus parentJobId',
          agentSlug: seedXAgentSlug,
          parentJobId: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('parent_job_not_found');
  });
});
