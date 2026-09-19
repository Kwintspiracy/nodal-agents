// chat-stream.test.ts — la réponse du chat, dite au fur et à mesure (#152).
//
// Ce qui se prouve ici, sur la VRAIE route et la vraie base :
//   1. les fragments de texte arrivent, DANS L'ORDRE et avec leur texte exact,
//      avant la fin du tour ;
//   2. la ligne assistant écrite en base porte la réponse ENTIÈRE — le flux
//      change quand le texte se montre, pas ce qui est gardé ;
//   3. le recheck d'escalade, qui tourne après la réponse, ne fuit PAS dans le
//      flux : son texte n'apparaît nulle part dans les fragments ;
//   4. un second message sur le même fil ATTEND — la file par conversation
//      (#149) n'a pas bougé.
//
// Le modèle est un faux qui diffuse trois fragments, et qui RETIENT le premier
// tour jusqu'à ce que le test le libère : c'est ce temps-là que le second
// message doit attendre.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText, streamText, simulateReadableStream } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { asc, eq } from '@nodal-agents/db';
import { conversations, chatMessages } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import type { AuthProvider, AuthSession } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('chat-stream.test: no active LLM client');
      return active;
    },
  };
});

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

class NoSessionAuthProvider implements AuthProvider {
  getSession(_req: Request): Promise<AuthSession | null> {
    return Promise.resolve(null);
  }
}

/** Tout le texte qu'un appel a porté, à plat. */
function flattenText(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text') {
        const text = (p as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

const FIRST = 'first question: say it slowly';
const SECOND = 'second question: and then?';

/** Les trois fragments du premier tour — la réponse, découpée. */
const FIRST_CHUNKS = ['A reply ', 'in three ', 'pieces.'];
const FIRST_REPLY = FIRST_CHUNKS.join('');
const SECOND_CHUNKS = ['And ', 'then this.'];
const SECOND_REPLY = SECOND_CHUNKS.join('');

/** Ce que le recheck d'escalade répond — il ne doit JAMAIS être diffusé. */
const RECHECK_TEXT = 'RECHECK-ONLY TEXT, never streamed';

/** Ce que le modèle a reçu, appel par appel, et la porte du premier tour. */
const streamCalls: ModelMessage[][] = [];
let releaseFirst: () => void = () => {};
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});

function chunksFor(messages: ModelMessage[]): string[] {
  const last = messages.at(-1);
  const asked = last ? flattenText([last]) : '';
  if (asked.includes(FIRST)) return FIRST_CHUNKS;
  if (asked.includes(SECOND)) return SECOND_CHUNKS;
  return ['other'];
}

function streamingModel(chunks: readonly string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doStream: () => {
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: '1' },
            ...chunks.map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
            { type: 'text-end' as const, id: '1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
        }),
      });
    },
  });
}

function makeStreamingLlmClient(): RunnerDeps['llmClient'] {
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: true,
    },
    // Le recheck d'escalade et la relance sans outils passent par là. Ce texte
    // ne doit jamais sortir dans le flux.
    generateText: (args) => {
      const model = new MockLanguageModelV3({
        provider: 'mock',
        modelId: 'mock',
        doGenerate: () =>
          Promise.resolve({
            content: [{ type: 'text' as const, text: RECHECK_TEXT }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
            warnings: [],
          }),
      });
      return generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >;
    },
    streamText: (args) => {
      const messages = (args.messages ?? []) as ModelMessage[];
      streamCalls.push(messages);
      const chunks = chunksFor(messages);
      // Le premier tour reste bloqué jusqu'à `releaseFirst()` : un flux qui ne
      // rend pas la main, exactement ce que le second message doit attendre.
      const model =
        chunks === FIRST_CHUNKS
          ? new MockLanguageModelV3({
              provider: 'mock',
              modelId: 'mock',
              doStream: async () => {
                await firstGate;
                return streamingModel(chunks).doStream(
                  {} as Parameters<MockLanguageModelV3['doStream']>[0],
                );
              },
            })
          : streamingModel(chunks);
      return streamText({ ...args, model } as Parameters<typeof streamText>[0]) as ReturnType<
        RunnerDeps['llmClient']['streamText']
      >;
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { userId: string; entityId: string; agentId: string };
let conversationId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Word by word' })
    .returning();
  if (!conv) throw new Error('conversation insert failed');
  conversationId = conv.id;
  // Un fil déjà commencé : aucun appel de titre ne vient se glisser dans le
  // compte des appels au modèle. Datés à la main pour que l'ordre tienne.
  const earlier = new Date(Date.now() - 120_000);
  const later = new Date(Date.now() - 60_000);
  await db.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'user',
      content: 'hello',
      createdAt: earlier,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'assistant',
      content: 'hi',
      createdAt: later,
    },
  ]);

  const registry = createToolRegistry();
  registerBuiltins(registry);
  const llmClient = makeStreamingLlmClient();
  setActiveLlmClient(llmClient);
  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new NoSessionAuthProvider(),
    close: async () => {},
  };
  app = createApp(deps, testEnv);
});

function post(message: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request('http://localhost/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer test-secret' },
        body: JSON.stringify({
          entityId: seed.entityId,
          agentId: seed.agentId,
          conversationId,
          message,
        }),
      }),
    ),
  );
}

interface Collected {
  deltas: string[];
  done: { reply: string; spawnedJobId: string | null } | null;
  errors: string[];
}

/** Lit le flux SSE d'une réponse et range ce qu'il a dit. */
async function collect(res: Response): Promise<Collected> {
  const out: Collected = { deltas: [], done: null, errors: [] };
  const body = res.body;
  if (!body) throw new Error('the response carried no stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event === 'delta') out.deltas.push((JSON.parse(data) as { text: string }).text);
      else if (event === 'done')
        out.done = JSON.parse(data) as { reply: string; spawnedJobId: string | null };
      else if (event === 'error') out.errors.push((JSON.parse(data) as { error: string }).error);
      sep = buffer.indexOf('\n\n');
    }
  }
  return out;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('POST /api/chat/stream — la réponse mot à mot @cap:parler-a-un-agent/moteur', () => {
  it('dit le texte fragment par fragment, garde la réponse entière, et fait attendre le tour suivant', async () => {
    const first = post(FIRST);
    const second = post(SECOND);

    // Le premier tour est au modèle et y attend. Le second n'a RIEN demandé :
    // la file par conversation (#149) le retient, le flux n'y change rien.
    await until(() => streamCalls.length >= 1, 'the first call to the model');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(streamCalls).toHaveLength(1);
    expect(flattenText(streamCalls[0]!)).toContain(FIRST);

    releaseFirst();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toContain('text/event-stream');

    const c1 = await collect(r1);
    // Les fragments, dans l'ordre et mot pour mot.
    expect(c1.deltas).toEqual(FIRST_CHUNKS);
    expect(c1.errors).toEqual([]);
    expect(c1.done).toEqual({ reply: FIRST_REPLY, spawnedJobId: null });
    // Le recheck d'escalade tourne après la réponse et ne fuit pas dans le flux.
    expect(c1.deltas.join('')).not.toContain(RECHECK_TEXT);

    const c2 = await collect(r2);
    expect(c2.deltas).toEqual(SECOND_CHUNKS);
    expect(c2.done?.reply).toBe(SECOND_REPLY);

    // Le second tour a vu la réponse au premier : la file tient toujours.
    const secondCall = streamCalls.find((m) => {
      const last = m.at(-1);
      return last !== undefined && flattenText([last]).includes(SECOND);
    });
    if (!secondCall) throw new Error('the second question never reached the model');
    expect(flattenText(secondCall)).toContain(FIRST_REPLY);

    // Et la base porte les réponses ENTIÈRES, pas des morceaux.
    const rows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    expect(rows.map((r) => `${r.role}:${r.content}`)).toEqual([
      'user:hello',
      'assistant:hi',
      `user:${FIRST}`,
      `assistant:${FIRST_REPLY}`,
      `user:${SECOND}`,
      `assistant:${SECOND_REPLY}`,
    ]);
  });
});
