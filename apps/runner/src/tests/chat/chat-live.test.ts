// chat-live.test.ts — se rebrancher sur un tour de chat en cours (#457).
//
// Le 23/09, la personne quitte la page pendant qu'Alfred écrit, revient : la
// question est là, la réponse non, et rien ne dit qu'elle s'écrit. Ce qui se
// prouve ici, sur les VRAIES routes (`/api/chat/stream`, `/api/chat/live`), le
// vrai tour, le vrai client et la vraie base — seul le modèle est simulé :
//   1. pendant le tour, une autre lecture reçoit ce qui a déjà été écrit, puis
//      la suite qui continue d'arriver, puis la fin ;
//   2. une fois le tour fini, il n'y a plus rien à lire (204) : c'est la ligne
//      en base qui fait foi ;
//   3. on ne lit jamais le tour d'une conversation d'une autre entité.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { conversations, entities } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { createApp } from '../../server.ts';
import { stopChatTurn } from '../../chat/turn-stop.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { readSse } from './_sse-reader.ts';

const { mockModel } = vi.hoisted(() => ({
  /** Le modèle simulé que le VRAI client construit (voir le mock d'OpenRouter). */
  mockModel: { current: null as unknown },
}));

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (
      _config: Parameters<typeof actual.createLlmClient>[0],
      opts: Parameters<typeof actual.createLlmClient>[1],
    ) =>
      actual.createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' }, opts),
  };
});

vi.mock('../../../../../packages/llm/src/providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildOpenRouterModel: () => mockModel.current };
});

/** Un modèle qui écrit sans jamais finir : un mot toutes les 10 ms. Seul Stop l'arrête. */
function endlessModel(): MockLanguageModelV3 {
  let tick: ReturnType<typeof setInterval> | undefined;
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.2',
    doStream: async () => ({
      stream: new ReadableStream<Record<string, unknown>>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          let n = 0;
          tick = setInterval(() => {
            n += 1;
            try {
              controller.enqueue({ type: 'text-delta', id: 't', delta: `mot${n} ` });
            } catch {
              clearInterval(tick);
            }
          }, 10);
        },
        // Stop annule le flux : le tic s'arrête avec lui, au lieu de tourner
        // jusqu'à la fin du processus de test (revue de la PR #502).
        cancel() {
          clearInterval(tick);
        },
      }) as never,
    }),
  });
}

const ROUTE_ENV: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
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

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  const registry = createToolRegistry();
  registerBuiltins(registry);
  app = createApp(
    {
      db: db as RunnerDeps['db'],
      llmClient: null as unknown as RunnerDeps['llmClient'],
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    },
    { ...ROUTE_ENV },
  );
});

async function newConversation(entityId = seed.entityId): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId, agentId: seed.agentId, title: 'Live' })
    .returning({ id: conversations.id });
  return conv!.id;
}

const post = (path: string, body: unknown): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
        body: JSON.stringify(body),
      }),
    ),
  );

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('se rebrancher sur un tour en cours (#457) @cap:parler-a-un-agent/moteur', () => {
  it('une autre lecture reçoit ce qui est écrit, puis la suite, puis la fin ; ensuite rien', async () => {
    mockModel.current = endlessModel();
    const conv = await newConversation();
    // La page qui a envoyé le message.
    const sender = readSse(
      await post('/api/chat/stream', {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv,
        message: 'Écris une très longue note',
      }),
    );
    await waitFor(() => sender.events.filter((e) => e.event === 'delta').length >= 5);

    // La page rouverte : elle se rebranche.
    const res = await post('/api/chat/live', { entityId: seed.entityId, conversationId: conv });
    expect(res.status).toBe(200);
    const reader = readSse(res);
    await waitFor(() => reader.events.length >= 1);
    const start = reader.events[0]!;
    expect(start.event).toBe('start');
    const already = (start.data as { text: string }).text;
    // Ce qui avait déjà été écrit, mot pour mot : le début de ce que l'envoyeur a reçu.
    expect(already.length).toBeGreaterThan(0);
    const sentSoFar = () =>
      sender.events
        .filter((e) => e.event === 'delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
    expect(sentSoFar().startsWith(already)).toBe(true);
    // Et la suite continue d'arriver, par cette lecture-ci.
    await waitFor(() => reader.events.filter((e) => e.event === 'delta').length >= 3);

    stopChatTurn(conv);
    await waitFor(() => reader.events.some((e) => e.event === 'end'));
    await waitFor(() => sender.events.some((e) => e.event === 'done'));
    // Le texte lu par la page rouverte EST celui du tour, du premier mot au dernier.
    const seenByLive =
      already +
      reader.events
        .filter((e) => e.event === 'delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
    expect(seenByLive).toBe(sentSoFar());

    // Le tour fini : plus rien à lire, la ligne en base fait foi.
    const after = await post('/api/chat/live', { entityId: seed.entityId, conversationId: conv });
    expect(after.status).toBe(204);
  });

  it('aucun tour en cours : 204, pas un flux vide', async () => {
    const conv = await newConversation();
    const res = await post('/api/chat/live', { entityId: seed.entityId, conversationId: conv });
    expect(res.status).toBe(204);
  });

  it('on ne lit jamais le tour d’une conversation d’une autre entité', async () => {
    mockModel.current = endlessModel();
    const conv = await newConversation();
    const sender = readSse(
      await post('/api/chat/stream', {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv,
        message: 'Écris',
      }),
    );
    await waitFor(() => sender.events.some((e) => e.event === 'delta'));
    const [other] = await db
      .insert(entities)
      .values({ name: 'Autre', slug: 'autre-live', userId: seed.userId })
      .returning({ id: entities.id });

    const res = await post('/api/chat/live', { entityId: other!.id, conversationId: conv });

    expect(res.status).toBe(404);
    stopChatTurn(conv);
    await waitFor(() => sender.events.some((e) => e.event === 'done'));
  });
});
