// manager.test.ts — startTelegramManager spawns one poller per agent with a
// bot token, restarts a poller on token change, and cleans up on stop.
//
// We mock fetch so the pollers immediately return [] (no updates), but the
// active count + DB scan logic is exercised end-to-end against pglite.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { eq } from '@nodalai/db';
import { agents } from '@nodalai/db';
import { startTelegramManager } from '../../telegram/manager.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

type FetchSpy = MockInstance<typeof globalThis.fetch>;

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'test',
  LLM_API_KEY: 'k',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 's',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
};

function makeDeps(db: TestDb): RunnerDeps {
  return {
    db: db as unknown as RunnerDeps['db'],
    llmClient: {} as RunnerDeps['llmClient'],
    embeddingClient: {} as RunnerDeps['embeddingClient'],
    registry: {} as RunnerDeps['registry'],
    authProvider: {} as RunnerDeps['authProvider'],
    close: async () => {},
  };
}

function emptyUpdatesResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('startTelegramManager', () => {
  let db: TestDb;
  let seed: { entityId: string; agentId: string };
  let fetchSpy: FetchSpy;

  beforeEach(async () => {
    const result = await spinUpTestDb();
    db = result.db;
    const minimal = await seedMinimal(db);
    seed = { entityId: minimal.entityId, agentId: minimal.agentId };
    // All fetch calls return empty updates so pollers stay idle.
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(() => Promise.resolve(emptyUpdatesResponse()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with zero pollers when no agent has a bot token', async () => {
    const manager = startTelegramManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('spawns a poller for each agent with a bot token', async () => {
    await db.update(agents).set({ telegramBotToken: '111:abc' }).where(eq(agents.id, seed.agentId));

    const manager = startTelegramManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);
    await manager.stop();
    expect(manager.activeCount()).toBe(0);
  });

  it('removes a poller when the agent token is cleared', async () => {
    await db.update(agents).set({ telegramBotToken: '111:abc' }).where(eq(agents.id, seed.agentId));

    const manager = startTelegramManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);

    // User disconnected the bot — clear the token
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));

    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });

  it('restarts a poller when the bot token is rotated', async () => {
    await db.update(agents).set({ telegramBotToken: '111:old' }).where(eq(agents.id, seed.agentId));

    const manager = startTelegramManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(1);

    await db.update(agents).set({ telegramBotToken: '222:new' }).where(eq(agents.id, seed.agentId));

    await manager.refreshNow();
    // Same agent, count stays 1, but the underlying poller was rotated.
    expect(manager.activeCount()).toBe(1);

    await manager.stop();
    expect(manager.activeCount()).toBe(0);
  });

  it('skips agents that are inactive even if they have a token', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: '111:abc', active: false })
      .where(eq(agents.id, seed.agentId));

    const manager = startTelegramManager(makeDeps(db), {
      env: testEnv,
      refreshIntervalMs: 999_999,
    });
    await manager.refreshNow();
    expect(manager.activeCount()).toBe(0);
    await manager.stop();
  });
});
