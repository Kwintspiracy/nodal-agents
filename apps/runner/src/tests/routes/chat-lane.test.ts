// chat-lane.test.ts — deux messages envoyés à la suite sur le même fil.
//
// Le dashboard n'attend plus la réponse pour envoyer le message suivant
// (Quentin, 18/09). Ce qui se prouve ici, sur la VRAIE route et la vraie base :
// le second tour n'appelle le modèle qu'une fois le premier fini, et son
// historique porte la réponse au premier. Sans la file par conversation, le
// second tour partait pendant que le premier attendait le modèle, avec un
// historique où la première réponse n'existait pas encore.
//
// Le modèle est un faux qui BLOQUE sa première réponse jusqu'à ce que le test
// la libère — c'est ce temps-là que le second message doit attendre.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
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
      if (!active) throw new Error('chat-lane.test: no active LLM client');
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

/** Tout le texte que le modèle a reçu, à plat. */
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

const FIRST = 'first question: what did we decide?';
const SECOND = 'second question: and then?';

/** Les appels reçus par le modèle, dans l'ordre, et la porte qui retient la
 *  première réponse. */
const captured: ModelMessage[][] = [];
let releaseFirst: () => void = () => {};
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});

function makeGatedLlmClient(): RunnerDeps['llmClient'] {
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: async (args) => {
      const messages = (args.messages ?? []) as ModelMessage[];
      captured.push(messages);
      const last = messages.at(-1);
      const asked = last ? flattenText([last]) : '';
      const reply = asked.includes(FIRST)
        ? 'FIRST REPLY: we chose the blue one.'
        : asked.includes(SECOND)
          ? 'SECOND REPLY: then we ordered it.'
          : 'other';
      if (reply.startsWith('FIRST')) await firstGate;
      const model = new MockLanguageModelV3({
        provider: 'mock',
        modelId: 'mock',
        doGenerate: async () => ({
          content: [{ type: 'text', text: reply }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        }),
      });
      return generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
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
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Two in a row' })
    .returning();
  if (!conv) throw new Error('conversation insert failed');
  conversationId = conv.id;
  // Deux messages déjà là : le fil n'est pas neuf, donc aucun appel de titre
  // ne vient se glisser entre les deux tours et brouiller le compte.
  await db.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'user',
      content: 'hello',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'assistant',
      content: 'hi',
    },
  ]);

  const registry = createToolRegistry();
  registerBuiltins(registry);
  const llmClient = makeGatedLlmClient();
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
      new Request('http://localhost/api/chat', {
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

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('POST /api/chat — deux messages à la suite @cap:parler-a-un-agent/moteur', () => {
  it('le second tour attend la réponse au premier, et la voit dans son historique', async () => {
    const first = post(FIRST);
    const second = post(SECOND);

    // Le premier tour a atteint le modèle et y attend. Le second, lui, n'a
    // RIEN demandé au modèle : c'est le point.
    await until(() => captured.length >= 1, 'the first call to the model');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured).toHaveLength(1);
    expect(flattenText(captured[0]!)).toContain(FIRST);

    releaseFirst();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { reply: string }).reply).toContain('FIRST REPLY');
    expect(((await r2.json()) as { reply: string }).reply).toContain('SECOND REPLY');

    // Le tour du second message a vu la première réponse.
    const secondCall = captured.find((m) => {
      const last = m.at(-1);
      return last !== undefined && flattenText([last]).includes(SECOND);
    });
    if (!secondCall) throw new Error('the second question never reached the model');
    expect(flattenText(secondCall)).toContain('FIRST REPLY: we chose the blue one.');

    // Et le fil est dans l'ordre où on a parlé.
    const rows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    expect(rows.map((r) => `${r.role}:${r.content}`)).toEqual([
      'user:hello',
      'assistant:hi',
      `user:${FIRST}`,
      'assistant:FIRST REPLY: we chose the blue one.',
      `user:${SECOND}`,
      'assistant:SECOND REPLY: then we ordered it.',
    ]);
  });
});
