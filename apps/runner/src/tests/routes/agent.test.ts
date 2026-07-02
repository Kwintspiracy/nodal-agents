// agent.test.ts — POST /api/agent creates a row, returns jobId
// Asserts on the real DB row, not just call counts (invariant 5).

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider, seedLocalUser, LOCAL_ENTITY_ID } from '@nodal-agents/auth';
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
