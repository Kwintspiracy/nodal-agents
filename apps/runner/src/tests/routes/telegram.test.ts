// telegram.test.ts — webhook payload creates a job in DB

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createLlmClient, createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const WEBHOOK_SECRET = 'tg-test-secret';

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
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Update agent to have a webhook secret
  await db
    .update(agents)
    .set({ telegramWebhookSecret: WEBHOOK_SECRET })
    .where(eq(agents.id, seed.agentId));

  // Also set in process.env for the fallback path
  process.env['TELEGRAM_WEBHOOK_SECRET'] = WEBHOOK_SECRET;

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const llmClient = createLlmClient({ provider: 'anthropic', model: 'test', apiKey: 'key' });
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

describe('POST /api/telegram', () => {
  it('always returns 200 ok (Telegram requirement)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('creates a job when webhook secret is valid', async () => {
    const agentSlug = (
      await db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, seed.agentId))
    )[0]?.slug;

    const tasksBefore = await db
      .select({ count: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.channel, 'telegram'));

    const update = {
      message: {
        message_id: 1,
        from: { id: 123456, first_name: 'Alice', username: 'alice', is_bot: false },
        chat: { id: 987654, type: 'private' },
        text: 'Hello agent, do something useful',
      },
    };

    const url = `http://localhost/api/telegram${agentSlug ? `?agent_slug=${agentSlug}` : ''}`;

    const res = await app.fetch(
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify(update),
      }),
    );

    expect(res.status).toBe(200);

    // Wait briefly for background job creation (it's synchronous in our implementation)
    await new Promise((r) => setTimeout(r, 50));

    const tasksAfter = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));

    expect(tasksAfter.length).toBeGreaterThan(tasksBefore.length);

    const newJob = tasksAfter.find((j) => j.task.includes('Hello agent, do something useful'));
    expect(newJob).toBeDefined();
    expect(newJob?.chatId).toBe('987654');
  });

  it('rejects (silently) when webhook secret is invalid', async () => {
    const agentSlug = (
      await db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, seed.agentId))
    )[0]?.slug;

    const tasksBefore = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));

    const update = {
      message: {
        from: { id: 999, first_name: 'Hacker', is_bot: false },
        chat: { id: 111, type: 'private' },
        text: 'Malicious message',
      },
    };

    await app.fetch(
      new Request(`http://localhost/api/telegram${agentSlug ? `?agent_slug=${agentSlug}` : ''}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
        },
        body: JSON.stringify(update),
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const tasksAfter = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));

    // No new job created
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });
});
