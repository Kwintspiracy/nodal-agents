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
import { stopChatTurn, withChatTurnStop } from '../../chat/turn-stop.ts';

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
