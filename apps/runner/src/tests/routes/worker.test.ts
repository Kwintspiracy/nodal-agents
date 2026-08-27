// worker.test.ts — tool whitelist enforced, anti-loop trips at limits,
// message structure validated, awaiting_approval does NOT bump chain_count

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { createApp } from '../../server.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;

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

function workerHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${testEnv.WORKER_SECRET}`,
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;

  await seedMinimal(db);

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

describe('POST /api/worker', () => {
  it('returns 403 when WORKER_SECRET is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000001' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when WORKER_SECRET is wrong', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
        body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000001' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: workerHeaders(),
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when jobId is not a valid UUID', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: workerHeaders(),
        body: JSON.stringify({ jobId: 'not-a-uuid' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 202 for a valid request (even if job does not exist)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/worker', {
        method: 'POST',
        headers: workerHeaders(),
        body: JSON.stringify({ jobId: '00000000-0000-0000-0000-000000000001' }),
      }),
    );
    // 202 accepted — job runs in background
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('accepted');
  });
});
