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

  it('M-16: dead-letters a poison update after MAX_UPDATE_ATTEMPTS, advancing offset and processing the next update', async () => {
    // Before the fix: a message that throws while being handled never advances
    // the offset, so the SAME update_id is fetched and retried forever — the
    // bot goes mute for every chat it serves. This proves the poller instead
    // gives up after a bounded number of attempts, persists the offset past
    // the poison update, and keeps processing what comes after it.
    vi.useFakeTimers();
    try {
      const POISON_UPDATE_ID = 200;
      const controller = new AbortController();
      let transactionCalls = 0;
      let secondBatchDelivered = false;

      const realDb = db as unknown as { transaction: (cb: unknown) => Promise<unknown> };
      const dbWithPoison = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            return async (cb: Parameters<typeof realDb.transaction>[0]) => {
              transactionCalls += 1;
              // Fail the poison update's first 5 attempts (deterministic — matches
              // MAX_UPDATE_ATTEMPTS), then let everything through — including the
              // update that follows it.
              if (transactionCalls <= 5) {
                throw new Error('simulated poison failure');
              }
              return realDb.transaction(cb);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      fetchSpy.mockImplementation((input, init) => {
        const url = String(input);
        if (url.includes('/api/worker')) {
          return Promise.resolve(new Response('ok'));
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
        const requestedOffset = body.offset ?? 0;
        // Offset hasn't advanced past the poison update yet — Telegram keeps
        // handing it back, exactly like the real getUpdates semantics.
        if (requestedOffset <= POISON_UPDATE_ID) {
          return Promise.resolve(
            fakeResponse(200, { ok: true, result: [makeUpdate(POISON_UPDATE_ID, 'poison')] }),
          );
        }
        if (!secondBatchDelivered) {
          secondBatchDelivered = true;
          return Promise.resolve(
            fakeResponse(200, {
              ok: true,
              result: [makeUpdate(POISON_UPDATE_ID + 1, 'after-poison')],
            }),
          );
        }
        controller.abort();
        return Promise.resolve(fakeResponse(200, { ok: true, result: [] }));
      });

      const pollerPromise = runTelegramPoller({
        agentId: seed.agentId,
        agentEntityId: seed.entityId,
        botToken: FAKE_TOKEN,
        botUsername: 'test_bot',
        startOffset: 0,
        signal: controller.signal,
        deps: { ...makeDeps(db), db: dbWithPoison as unknown as RunnerDeps['db'] },
        env: testEnv,
        longPollSeconds: 1,
      });
      // 5 attempts means 4 real backoff sleeps (1s+2s+4s+8s = 15s) before the
      // dead-letter fires — fast-forward through them instead of eating 15s
      // of real wall-clock time per test run.
      await vi.runAllTimersAsync();
      const exit = await pollerPromise;

      expect(exit.reason).toBe('aborted');
      // Offset landed past BOTH the dead-lettered poison update and the one after it.
      expect(exit.finalOffset).toBe(POISON_UPDATE_ID + 2);
      expect(transactionCalls).toBe(6); // 5 failed attempts + 1 real (successful) one

      // The poison update never created a job; the one after it did.
      const jobs = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));
      expect(jobs.map((j) => j.task)).toEqual(['after-poison']);

      // The dead-letter path persists the offset advance itself (the failed
      // transaction never got to write it), so a restart resumes AFTER the poison
      // update instead of refetching it forever.
      const [agentRow] = await db
        .select({ telegramOffset: agents.telegramOffset })
        .from(agents)
        .where(eq(agents.id, seed.agentId));
      expect(agentRow?.telegramOffset).toBe(POISON_UPDATE_ID + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-16 infra-classifier: a transient DB/infra error (ECONNREFUSED-style) is NEVER dead-lettered, no matter how many times it repeats — the message eventually gets through once the DB recovers', async () => {
    // getTelegramUpdates talks to Telegram, not the DB — during a DB-only
    // outage it keeps succeeding and handing back the same update every poll.
    // Before this classifier existed, that update's own per-update failure
    // counter would climb exactly like a poison message's and get
    // permanently dead-lettered ~15s into an outage that has nothing to do
    // with its content. This proves an error carrying a recognized
    // infra/connection code is excluded from that counter entirely: it keeps
    // retrying indefinitely (well past MAX_UPDATE_ATTEMPTS) until the
    // "DB" stops failing, at which point the message is delivered normally.
    vi.useFakeTimers();
    try {
      const INFRA_UPDATE_ID = 400;
      const controller = new AbortController();
      let transactionCalls = 0;
      const FAILURES_BEFORE_RECOVERY = 10; // well past MAX_UPDATE_ATTEMPTS (5)

      const realDb = db as unknown as { transaction: (cb: unknown) => Promise<unknown> };
      const dbWithInfraBlip = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction') {
            return async (cb: Parameters<typeof realDb.transaction>[0]) => {
              transactionCalls += 1;
              if (transactionCalls <= FAILURES_BEFORE_RECOVERY) {
                const err = new Error('connection refused') as Error & { code: string };
                err.code = 'ECONNREFUSED'; // Node socket-level error — infra, not content
                throw err;
              }
              return realDb.transaction(cb);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      let secondBatchDelivered = false;
      fetchSpy.mockImplementation((input, init) => {
        const url = String(input);
        if (url.includes('/api/worker')) {
          return Promise.resolve(new Response('ok'));
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
        const requestedOffset = body.offset ?? 0;
        if (requestedOffset <= INFRA_UPDATE_ID) {
          return Promise.resolve(
            fakeResponse(200, { ok: true, result: [makeUpdate(INFRA_UPDATE_ID, 'legit-during-outage')] }),
          );
        }
        if (!secondBatchDelivered) {
          secondBatchDelivered = true;
          return Promise.resolve(fakeResponse(200, { ok: true, result: [] }));
        }
        controller.abort();
        return Promise.resolve(fakeResponse(200, { ok: true, result: [] }));
      });

      const pollerPromise = runTelegramPoller({
        agentId: seed.agentId,
        agentEntityId: seed.entityId,
        botToken: FAKE_TOKEN,
        botUsername: 'test_bot',
        startOffset: 0,
        signal: controller.signal,
        deps: { ...makeDeps(db), db: dbWithInfraBlip as unknown as RunnerDeps['db'] },
        env: testEnv,
        longPollSeconds: 1,
      });
      await vi.runAllTimersAsync();
      const exit = await pollerPromise;

      expect(exit.reason).toBe('aborted');
      // NOT dead-lettered at attempt 5: it kept retrying past that threshold,
      // all the way to the (11th) attempt that finally succeeds.
      expect(transactionCalls).toBe(FAILURES_BEFORE_RECOVERY + 1);
      expect(exit.finalOffset).toBe(INFRA_UPDATE_ID + 1);

      // The message was NOT dropped — it made it through once "the DB" recovered.
      const jobs = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));
      expect(jobs.map((j) => j.task)).toEqual(['legit-during-outage']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-16 CRITICAL: a transient (non-permanent) failure on the first update of a batch must not let a later update in the same batch skip the offset past it', async () => {
    // This is the bug the adversarial reviewer caught: `offset` is ONE shared
    // variable across the whole `updates` batch. If update A fails but the
    // handler moves on (`continue`) and update B — LATER in the same batch —
    // then succeeds, B writes `offset` past A's still-unresolved update_id.
    // Telegram's offset semantics confirm everything below it, so A would be
    // PERMANENTLY erased from the queue without ever being retried or logged
    // — a silent drop, worse than the bug M-16 set out to fix. The correct
    // behavior: on a non-terminal failure, stop processing the rest of THIS
    // batch (`break`) so a later update can never leapfrog a pending retry.
    const controller = new AbortController();
    let transactionAttempt = 0;
    let batchesAfterConfirmation = 0;

    const realDb = db as unknown as { transaction: (cb: unknown) => Promise<unknown> };
    const dbWithOneTransientFailure = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (cb: Parameters<typeof realDb.transaction>[0]) => {
            transactionAttempt += 1;
            // Only the very FIRST transaction call (update 100's first attempt)
            // fails. Everything after — including its own retry — succeeds.
            // Deliberately a plain Error with no `.code`: the infra classifier
            // (isTransientInfraError) treats this as a DETERMINISTIC/content
            // failure, not an infra blip — so this test exercises the
            // per-update attempts/break path, same as before the classifier
            // was added. The infra-specific path is covered separately by the
            // "M-16 infra-classifier" test above.
            if (transactionAttempt === 1) {
              throw new Error('simulated transient failure');
            }
            return realDb.transaction(cb);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    fetchSpy.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/api/worker')) {
        return Promise.resolve(new Response('ok'));
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { offset?: number };
      const requestedOffset = body.offset ?? 0;
      // Telegram keeps handing back BOTH updates as long as 100 isn't confirmed
      // — exactly the real semantics that make the shared-offset bug reachable
      // (100 and 101 arrive together in one batch, repeatedly, until 100 is done).
      if (requestedOffset <= 100) {
        return Promise.resolve(
          fakeResponse(200, { ok: true, result: [makeUpdate(100, 'first'), makeUpdate(101, 'second')] }),
        );
      }
      batchesAfterConfirmation += 1;
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
      deps: { ...makeDeps(db), db: dbWithOneTransientFailure as unknown as RunnerDeps['db'] },
      env: testEnv,
      longPollSeconds: 1,
    });

    expect(exit.reason).toBe('aborted');
    // Offset only advances past 100 once 100 itself actually succeeds — never
    // jumps straight to 102 on the back of 101 alone.
    expect(exit.finalOffset).toBe(102);
    expect(transactionAttempt).toBe(3); // 100 fails, 100 retried (succeeds), 101 (succeeds)
    expect(batchesAfterConfirmation).toBe(1);

    // BOTH updates ended up as real jobs — 100 was retried and delivered, not
    // silently dropped because 101 (later in the batch) happened to succeed first.
    const jobs = await db.select().from(agentJobs).where(eq(agentJobs.channel, 'telegram'));
    expect(jobs.map((j) => j.task).sort()).toEqual(['first', 'second']);
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
