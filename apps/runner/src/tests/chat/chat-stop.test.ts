// chat-stop.test.ts — le Stop d'un tour de chat en cours (#456).
//
// Un tour de chat qui répond sans outil n'est pas un job : le Stop de #449/#450
// (qui relit `agent_jobs.status`) ne l'atteint pas. Ce qui se prouve ici, sur
// le VRAI tour (`runChatTurn`, base de test réelle, `streamText` réel sur un
// modèle simulé) : Stop coupe la réponse en cours, garde ce qui a été écrit
// suivi de la ligne de plateforme, et ne lance aucun job même si le modèle
// avait déjà demandé une escalade.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { streamText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, chatMessages, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { stopChatTurn, stoppedReplyNote, withChatTurnStop } from '../../chat/turn-stop.ts';
import { createApp } from '../../server.ts';
import type { RunnerEnv } from '../../env.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';

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
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('chat-stop.test: no active LLM client');
      return active;
    },
  };
});

/**
 * Un modèle qui écrit sans jamais finir : un fragment toutes les 10 ms, et, si
 * demandé, une demande d'escalade (`run_task`) glissée après le troisième. Il
 * n'y a QUE le Stop pour terminer ce tour. `mute` : il ne dit jamais rien.
 */
/**
 * Un modèle qui répond vite, SANS escalade, puis dont la relance d'escalade
 * (`generateText`) prend du temps et finirait par demander un `run_task` —
 * sauf si le Stop l'abandonne.
 */
function slowRecheckClient(): RunnerDeps['llmClient'] {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doStream: async () => ({
      stream: new ReadableStream<Record<string, unknown>>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Je vais chercher ça.' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          });
          controller.close();
        },
      }) as never,
    }),
  });
  const client = endlessClient();
  return {
    ...client,
    streamText: (args) =>
      streamText({ ...args, model } as Parameters<typeof streamText>[0]) as ReturnType<
        RunnerDeps['llmClient']['streamText']
      >,
    generateText: ((_args: unknown, opts?: { abortSignal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () =>
            resolve({
              text: '',
              toolCalls: [{ toolName: 'run_task', input: { instruction: 'go' } }],
            }),
          300,
        );
        opts?.abortSignal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      })) as unknown as RunnerDeps['llmClient']['generateText'],
  };
}

function endlessClient(
  opts: { escalates?: boolean; mute?: boolean } = {},
): RunnerDeps['llmClient'] {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doStream: async () => ({
      stream: new ReadableStream<Record<string, unknown>>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          if (opts.mute) return;
          controller.enqueue({ type: 'text-start', id: 't' });
          let n = 0;
          const tick = setInterval(() => {
            n += 1;
            try {
              controller.enqueue({ type: 'text-delta', id: 't', delta: `mot${n} ` });
              if (opts.escalates && n === 3) {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'rt-1',
                  toolName: 'run_task',
                  input: JSON.stringify({ instruction: 'go research it' }),
                });
              }
            } catch {
              clearInterval(tick); // le lecteur est parti : Stop a coupé le flux
            }
          }, 10);
        },
      }) as never,
    }),
  });
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: true,
    },
    generateText: () => {
      throw new Error('chat-stop.test: generateText must not run after a Stop');
    },
    streamText: (args) =>
      streamText({ ...args, model } as Parameters<typeof streamText>[0]) as ReturnType<
        RunnerDeps['llmClient']['streamText']
      >,
    generateObject: () => {
      throw new Error('generateObject not used');
    },
  };
}

/** L'environnement d'un runner de test, pour la route `/api/chat`. */
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
let deps: RunnerDeps;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
});

beforeEach(async () => {
  await db.delete(chatMessages);
  await db.delete(conversations);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, seed.agentId));
});

async function newConversation(title = 'Stop test'): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title })
    .returning({ id: conversations.id });
  return conv!.id;
}

/** Joue un tour streamé avec son Stop, et rend le texte montré mot à mot. */
function playTurn(conversationId: string) {
  const shown: string[] = [];
  const turn = withChatTurnStop(conversationId, (abortSignal) =>
    runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'Écris une très longue note',
      onTextDelta: (d) => shown.push(d),
      abortSignal,
    }),
  );
  return { turn, shown };
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Stop dans le chat @cap:parler-a-un-agent/moteur', () => {
  it('coupe une réponse qui écrit sans fin, et garde ce qui a été écrit', async () => {
    setActiveLlmClient(endlessClient());
    const conv = await newConversation();
    const { turn, shown } = playTurn(conv);

    await waitFor(() => shown.length >= 5);
    expect(stopChatTurn(conv)).toBe(true);
    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true });
    if (!result.ok) throw new Error('unreachable');
    const written = shown.join('').trim();
    // Ce qui a été écrit, et RIEN d'ajouté : l'arrêt est un fait, pas une
    // phrase du runner (invariant #2, revue Codex de #459).
    expect(result.reply).toBe(written);
    const rows = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        stopped: chatMessages.stopped,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    // Le message de la personne, puis UNE réponse : ce qui avait été écrit, arrêté.
    expect(rows.filter((r) => r.role === 'assistant')).toEqual([
      { role: 'assistant', content: result.reply, stopped: true },
    ]);
  });

  it('ne lance AUCUN job, même si le modèle avait déjà demandé une escalade', async () => {
    setActiveLlmClient(endlessClient({ escalates: true }));
    const conv = await newConversation();
    const { turn, shown } = playTurn(conv);

    await waitFor(() => shown.length >= 6);
    stopChatTurn(conv);
    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true });
    const jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conv));
    expect(jobs).toEqual([]);
  });

  it('un Stop pendant la relance d’escalade : aucun job, la réponse gardée', async () => {
    setActiveLlmClient(slowRecheckClient());
    const conv = await newConversation();
    const { turn, shown } = playTurn(conv);

    // La réponse est écrite ; la relance d'escalade tourne (300 ms).
    await waitFor(() => shown.join('').includes('chercher'));
    await new Promise((r) => setTimeout(r, 50));
    expect(stopChatTurn(conv)).toBe(true);
    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.reply).toBe('Je vais chercher ça.');
    const jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conv));
    expect(jobs).toEqual([]);
  });

  it('un Stop pendant la génération du TITRE : la réponse enregistrée est marquée arrêtée', async () => {
    const conv = await newConversation('');
    const client = slowRecheckClient();
    setActiveLlmClient({
      ...client,
      generateText: ((args: { system?: string }, opts?: { abortSignal?: AbortSignal }) => {
        if (typeof args.system === 'string' && args.system.length > 0) {
          // L'appel qui nomme la conversation : la personne appuie sur Stop.
          stopChatTurn(conv);
          return opts?.abortSignal?.aborted
            ? Promise.reject(new Error('aborted'))
            : Promise.resolve({ text: 'Titre' });
        }
        // La relance d'escalade : pas d'escalade.
        return Promise.resolve({ text: '', toolCalls: [] });
      }) as unknown as RunnerDeps['llmClient']['generateText'],
    });
    const { turn } = playTurn(conv);

    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true, reply: 'Je vais chercher ça.' });
    const rows = await db
      .select({ content: chatMessages.content, stopped: chatMessages.stopped })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(rows.filter((r) => r.stopped)).toEqual([
      { content: 'Je vais chercher ça.', stopped: true },
    ]);
  });

  it('sans flux, un Stop pendant la relance d’escalade garde la réponse déjà reçue', async () => {
    const conv = await newConversation();
    let rechecking: () => void = () => {};
    const inRecheck = new Promise<void>((r) => {
      rechecking = r;
    });
    let calls = 0;
    setActiveLlmClient({
      ...endlessClient(),
      generateText: ((_args: unknown, opts?: { abortSignal?: AbortSignal }) => {
        calls += 1;
        // 1er appel : la réponse entière, d'un bloc (le chemin sans flux).
        if (calls === 1) return Promise.resolve({ text: 'Réponse complète.', toolCalls: [] });
        // 2e : la relance d'escalade, qui attend… jusqu'au Stop.
        rechecking();
        return new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as RunnerDeps['llmClient']['generateText'],
    });
    const turn = withChatTurnStop(conv, (abortSignal) =>
      runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv,
        message: 'Une question',
        abortSignal,
      }),
    );

    await inRecheck;
    stopChatTurn(conv);
    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true, reply: 'Réponse complète.' });
    const rows = await db
      .select({ content: chatMessages.content, stopped: chatMessages.stopped })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(rows.filter((r) => r.stopped)).toEqual([
      { content: 'Réponse complète.', stopped: true },
    ]);
  });

  it('le chemin de secours /api/chat s’arrête lui aussi', async () => {
    const conv = await newConversation();
    let called: () => void = () => {};
    const turnStarted = new Promise<void>((r) => {
      called = r;
    });
    // Le tour sans flux attend son modèle… jusqu'au Stop.
    setActiveLlmClient({
      ...endlessClient(),
      generateText: ((_args: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          called();
          opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as RunnerDeps['llmClient']['generateText'],
    });
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const app = createApp(
      {
        db: db as RunnerDeps['db'],
        llmClient: getActiveLlmClient()!,
        embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
        registry,
        authProvider: new LocalTrustProvider(),
        close: async () => {},
      },
      { ...ROUTE_ENV },
    );
    const post = (path: string, body: unknown) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
          body: JSON.stringify(body),
        }),
      );

    const chat = post('/api/chat', {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv,
      message: 'Écris une très longue note',
    });
    await turnStarted;
    const stop = await post('/api/chat/stop', { entityId: seed.entityId, conversationId: conv });

    expect(await stop.json()).toEqual({ stopped: true });
    expect((await chat).status).toBe(200);
    const rows = await db
      .select({ role: chatMessages.role, stopped: chatMessages.stopped })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(rows.filter((r) => r.role === 'assistant')).toEqual([
      { role: 'assistant', stopped: true },
    ]);
  });

  it('arrête aussi un modèle encore muet, avant son premier mot', async () => {
    setActiveLlmClient(endlessClient({ mute: true }));
    const conv = await newConversation();
    const { turn } = playTurn(conv);

    await new Promise((r) => setTimeout(r, 50));
    expect(stopChatTurn(conv)).toBe(true);
    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true, reply: '' });
  });

  it('un Stop pendant la CRÉATION du job d’escalade : le job est annulé, jamais lancé', async () => {
    // Sans titre : le tour le nommera, et c'est pendant cet appel que Stop tombe.
    const conv = await newConversation('');
    // La relance demande une escalade ; le Stop tombe pendant l'appel qui nomme
    // la conversation — APRÈS la création du job, AVANT son lancement.
    const client = slowRecheckClient();
    setActiveLlmClient({
      ...client,
      generateText: ((args: { system?: string }) => {
        if (typeof args.system === 'string' && args.system.length > 0) {
          stopChatTurn(conv);
          return Promise.resolve({ text: 'Titre' });
        }
        return Promise.resolve({
          text: '',
          toolCalls: [{ toolName: 'run_task', input: { instruction: 'go' } }],
        });
      }) as unknown as RunnerDeps['llmClient']['generateText'],
    });
    const { turn } = playTurn(conv);

    const result = await turn;

    expect(result).toMatchObject({ ok: true, stopped: true });
    expect(result.ok && result.spawnedJobId).toBeFalsy();
    const jobs = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conv));
    expect(jobs).toEqual([{ status: 'cancelled' }]);
    const acks = await db
      .select({ stopped: chatMessages.stopped })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(acks.filter((r) => r.stopped)).toHaveLength(1);
  });

  it('un Stop après l’escalade : le tour suivant dit au modèle que la personne a arrêté', async () => {
    // Même scénario que ci-dessus : l'accusé porte un job ET l'arrêt.
    const conv = await newConversation('');
    const client = slowRecheckClient();
    setActiveLlmClient({
      ...client,
      generateText: ((args: { system?: string }) => {
        if (typeof args.system === 'string' && args.system.length > 0) {
          stopChatTurn(conv);
          return Promise.resolve({ text: 'Titre' });
        }
        return Promise.resolve({
          text: '',
          toolCalls: [{ toolName: 'run_task', input: { instruction: 'go' } }],
        });
      }) as unknown as RunnerDeps['llmClient']['generateText'],
    });
    await playTurn(conv).turn;

    // Le tour suivant : on lit l'historique que le modèle reçoit.
    let seen: unknown = null;
    const next = endlessClient();
    setActiveLlmClient({
      ...next,
      streamText: (args) => {
        seen = (args as { messages?: unknown }).messages;
        return next.streamText(args);
      },
    });
    const { turn } = playTurn(conv);
    await waitFor(() => seen !== null);
    stopChatTurn(conv);
    await turn;

    const toolResults = (seen as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toContain(JSON.stringify(stoppedReplyNote()).slice(1, -1));
  });

  it('n’arrête que SA conversation, et dit quand rien ne tournait', async () => {
    setActiveLlmClient(endlessClient());
    const a = await newConversation();
    const b = await newConversation();
    const first = playTurn(a);
    const second = playTurn(b);
    await waitFor(() => first.shown.length >= 2 && second.shown.length >= 2);

    stopChatTurn(a);
    const stoppedA = await first.turn;
    const lenB = second.shown.length;
    await waitFor(() => second.shown.length > lenB + 2);

    expect(stoppedA).toMatchObject({ ok: true, stopped: true });
    // B écrit toujours ; on l'arrête pour finir proprement.
    expect(stopChatTurn(b)).toBe(true);
    await second.turn;
    expect(stopChatTurn(a)).toBe(false);
  });
});
