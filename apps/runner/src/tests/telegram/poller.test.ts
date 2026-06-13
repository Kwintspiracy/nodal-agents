// poller.test.ts — runTelegramPoller's loop semantics: offset advances atomically,
// invalid token exits, transient errors back off and retry, abort signal stops cleanly.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agents, agentJobs } from '@nodal-agents/db';
import { runTelegramPoller } from '../../telegram/poller.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

type FetchFn = typeof globalThis.fetch;
type FetchSpy = MockInstance<FetchFn>;

const FAKE_TOKEN = '111:tok';

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
  REFLECTION_ENABLED: 'false',
  REFLECTION_MIN_TURNS: 3,
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
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

function makeUpdate(updateId: number, text: string, chatId = 555): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: 7, first_name: 'A', is_bot: false },
      text,
    },
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runTelegramPoller', () => {
  let db: TestDb;
  let seed: { entityId: string; agentId: string };
  let fetchSpy: FetchSpy;

  beforeEach(async () => {
    const result = await spinUpTestDb();
    db = result.db;
    const minimal = await seedMinimal(db);
    seed = { entityId: minimal.entityId, agentId: minimal.agentId };
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes a batch of updates, advances offset, creates one job per update', async () => {
    // The poller's fetch surface includes both getUpdates calls AND the
    // fire-and-forget triggerWorker calls, so we filter by URL to keep the
    // test deterministic.
    const controller = new AbortController();
    let getUpdatesCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/worker')) {
        // triggerWorker — ignore, runner isn't really up
        return Promise.resolve(new Response('ok'));
      }
      // Telegram getUpdates
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return Promise.resolve(
          fakeResponse(200, {
            ok: true,
            result: [makeUpdate(100, 'first'), makeUpdate(101, 'second')],
          }),
        );
      }
      // Second poll: stop the loop
      controller.abort();
      return Promise.resolve(fakeResponse(200, { ok: true, result: [] }));
    });

    const exit = await runTelegramPoller({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: FAKE_TOKEN,
      botUsername: 'test_bot',
      startOffset: 0,
      signal: controller.signal,
      deps: makeDeps(db),
      env: testEnv,
      longPollSeconds: 1,
    });

    expect(exit.reason).toBe('aborted');
    expect(exit.finalOffset).toBe(102);

    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));
    expect(jobs.length).toBe(2);
    expect(jobs.map((j) => j.task).sort()).toEqual(['first', 'second']);

    const [agentRow] = await db
      .select({
        telegramOffset: agents.telegramOffset,
        lastSeenChatIdTelegram: agents.lastSeenChatIdTelegram,
      })
      .from(agents)
      .where(eq(agents.id, seed.agentId));
    expect(agentRow?.telegramOffset).toBe(102);
    // lastSeenChatIdTelegram must be set to the chat.id from the fixture (555)
    expect(agentRow?.lastSeenChatIdTelegram).toBe('555');
  });

  it('exits with reason="invalid_token" when Telegram rejects the token', async () => {
    fetchSpy.mockResolvedValueOnce(fakeResponse(401, { ok: false, description: 'Unauthorized' }));

    const controller = new AbortController();
    const exit = await runTelegramPoller({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: FAKE_TOKEN,
      botUsername: 'test_bot',
      startOffset: 0,
      signal: controller.signal,
      deps: makeDeps(db),
      env: testEnv,
      longPollSeconds: 1,
    });

    expect(exit.reason).toBe('invalid_token');
    // No jobs created
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));
    expect(jobs.length).toBe(0);
  });

  it('backs off on transient failure then resumes; offset NOT advanced on failure', async () => {
    // First call fails with 500, second call succeeds with empty list, then abort.
    fetchSpy
      .mockResolvedValueOnce(fakeResponse(500, { ok: false, description: 'down' }))
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(fakeResponse(200, { ok: true, result: [] }));
      });

    const controller = new AbortController();
    const exit = await runTelegramPoller({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: FAKE_TOKEN,
      botUsername: 'test_bot',
      startOffset: 42,
      signal: controller.signal,
      deps: makeDeps(db),
      env: testEnv,
      longPollSeconds: 1,
    });

    expect(exit.reason).toBe('aborted');
    expect(exit.finalOffset).toBe(42); // No updates handled → offset unchanged
    // Both fetch calls happened (transient + retry)
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('respects abort signal — exits cleanly when signal aborts before polling', async () => {
    const controller = new AbortController();
    controller.abort();

    // Even if fetch is mocked, the loop should exit on first iteration check.
    fetchSpy.mockResolvedValue(fakeResponse(200, { ok: true, result: [] }));

    const exit = await runTelegramPoller({
      agentId: seed.agentId,
      agentEntityId: seed.entityId,
      botToken: FAKE_TOKEN,
      botUsername: 'test_bot',
      startOffset: 0,
      signal: controller.signal,
      deps: makeDeps(db),
      env: testEnv,
      longPollSeconds: 1,
    });

    expect(exit.reason).toBe('aborted');
    expect(exit.finalOffset).toBe(0);
  });
});
