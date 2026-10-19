// handoff-verbatim.test.ts — la demande de la personne arrive au travailleur
// TELLE QU'ELLE L'A ÉCRITE ; ce que le modèle qui la remet ajoute est SA NOTE,
// à part, sous un cadre (handoff.ts, @nodal-agents/shared).
//
// L'incident du 18/10 (conversation 9377edf0, job 039f8666) : le propriétaire
// demande une feuille d'exercice d'écriture « avant de l'imprimer », puis
// corrige le tracé des chiffres. Le front du chat lance le travail avec SON
// texte, qui cite la correction puis ajoute, comme si c'était la demande :
// « Vérifie visuellement le rendu (capture d'écran) avant de répondre ». Le
// travailleur ne pouvait pas distinguer les deux, et `original_task` était
// NULL. Ici, sur le chemin RÉEL — `runChatTurn` puis `executeJob`, vraie base
// de test, vrai client LLM construit depuis la clé de l'agent, et la requête
// telle que le fournisseur la reçoit, lue à la frontière `fetch` :
//
//   - tableau de bord : la tâche est le message de la personne, tel qu'elle
//     l'a écrit ; l'instruction du front est sa note. Le travailleur reçoit
//     les tours d'avant de la conversation comme tout canal (historique du fil,
//     la personne mot pour mot et datée), puis le message seul, puis la note
//     sous son cadre — la forme de l'incident (la correction lance un NOUVEAU
//     job) comme celle d'une première réponse en texte ;
//   - un front qui n'ajoute rien : aucune note, un seul message ;
//   - une langue autre que le français, avec et sans note ;
//   - l'historique borné comme celui d'un canal (MAX_TURNS, BUDGET_CHARS) ;
//   - Telegram et Discord : un tour de réponse né d'une correction transmet au
//     travail en cours les mots TAPÉS, et son propre texte comme sa note.
//
// Mutations vérifiées (chacune rougit au moins un cas ci-dessous) :
//   - `task: message` remplacé par l'instruction du modèle (l'ancien
//     comportement) → les cas du tableau de bord rougissent ;
//   - l'historique réservé aux jobs qui ont un `chat_id` (l'ancienne garde
//     d'execute.ts) → les deux cas de correction rougissent ;
//   - le message du tour laissé dans l'historique → idem (il y est deux fois) ;
//   - le budget retiré de `loadDashboardHistory` → « bounded » rougit ;
//   - `openingMessages` qui colle la note au message de la personne → les
//     requêtes du travailleur rougissent ;
//   - `message_conversation_run` qui remet le texte du modèle comme les mots
//     → les cas Telegram et Discord rougissent.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  conversations,
  entityLlmKeys,
  drainJobInbox,
  recordClaim,
  withinRunScope,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { HANDOFF_NOTE_FRAME, isHandoffNoteMessage, isInboxMessage } from '@nodal-agents/shared';
import {
  createToolRegistry,
  messageConversationRunTool,
  registerBuiltins,
} from '@nodal-agents/tools';
import type { ToolContext } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { TITLE_SYSTEM_PROMPT } from '../../chat/conversation-title.ts';
import { executeJob } from '../../job/execute.ts';
import { BUDGET_CHARS } from '../../job/thread-history.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';
import { takeChannelTurn } from '../../channels/turn.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentId = '';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  const [key] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-test-key'),
      baseUrl: null,
      nickname: 'OpenRouter (test)',
      isActive: true,
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Alfred',
      slug: `alfred-${randomUUID().slice(0, 8)}`,
      personality: 'You are a test agent.',
      role: 'orchestrator',
      llmKeyId: key!.id,
      model: 'z-ai/glm-5.3',
    })
    .returning();
  agentId = agent!.id;
});

// Provider calls leave through packages/llm's own transport (#608): routed back
// to the global fetch, so the stub below is the network boundary.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

type Sent = Array<{ role: string; content: unknown }>;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

const userTexts = (messages: Sent) =>
  messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
const assistantTexts = (messages: Sent) =>
  messages.filter((m) => m.role === 'assistant').map((m) => textOf(m.content));

/**
 * Le réseau. Le FRONT (l'appel qui propose `run_task`) répond par `front` :
 * un texte seul, ou un `run_task` avec cette instruction. Le titrage et la
 * relecture d'action répondent sans rien faire. Tout autre appel est celui du
 * TRAVAILLEUR : sa requête est gardée telle que le fournisseur la reçoit.
 */
function network(front: { text?: string; instruction?: string }) {
  const worker: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as {
        stream?: boolean;
        messages: Sent;
        tools?: Array<{ function: { name: string } }>;
      };
      const system = textOf(body.messages.find((m) => m.role === 'system')?.content);
      const last = textOf(body.messages[body.messages.length - 1]?.content);
      const isFront = (body.tools ?? []).some((t) => t.function.name === 'run_task');
      let text = 'ok';
      let toolCall: { name: string; args: Record<string, unknown> } | null = null;
      if (system.startsWith(TITLE_SYSTEM_PROMPT.slice(0, 40))) text = 'Feuille de chiffres';
      else if (last.endsWith(ACTION_RECHECK)) text = 'ok';
      else if (isFront) {
        text = front.text ?? '';
        if (front.instruction !== undefined) {
          toolCall = { name: 'run_task', args: { instruction: front.instruction } };
        }
      } else {
        worker.push(body.messages);
        text = 'Done.';
      }
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const finish = toolCall ? 'tool_calls' : 'stop';
      const calls = toolCall
        ? [
            {
              id: 'call_1',
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
            },
          ]
        : undefined;
      if (body.stream === true) {
        const delta: Record<string, unknown> = { role: 'assistant' };
        if (text) delta['content'] = text;
        if (calls) delta['tool_calls'] = calls.map((c, index) => ({ index, ...c }));
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const message: Record<string, unknown> = { role: 'assistant', content: text };
      if (calls) message['tool_calls'] = calls;
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message, finish_reason: finish }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return { worker };
}

function makeDeps(): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function dashboardConversation(): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId, title: '', channel: 'dashboard' })
    .returning({ id: conversations.id });
  return conv!.id;
}

/** Un tour du chat : le front répond par `front`. Rend le job lancé, s'il y en a un. */
async function chatTurn(
  conversationId: string,
  message: string,
  front: { text?: string; instruction?: string },
): Promise<string | undefined> {
  network(front);
  const r = await runChatTurn({
    deps: makeDeps(),
    entityId: seed.entityId,
    agentId,
    conversationId,
    message,
  });
  expect(r.ok).toBe(true);
  return r.ok ? r.spawnedJobId : undefined;
}

async function jobRow(jobId: string) {
  const [row] = await db
    .select({ task: agentJobs.task, handoffNote: agentJobs.handoffNote })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row;
}

/** La requête du travailleur qui exécute `jobId`, telle que le fournisseur la reçoit. */
async function workerRequest(jobId: string): Promise<Sent> {
  const net = network({});
  await executeJob(jobId as JobId, makeDeps());
  expect(net.worker.length).toBeGreaterThan(0);
  return net.worker[0]!;
}

const REQUEST =
  "Je voudrais imprimer une feuille d'exercice d'écriture des chiffres de 0 à 9. " +
  "Fais-moi une proposition que je puisse l'avoir avant de l'imprimer.";
const CORRECTION = 'Les chiffres doivent se tracer en un seul trait : pas de barre au 7, ni au 1.';
const PROPOSAL = 'Voici la proposition : feuille_chiffres.pdf. Rien n’est imprimé.';
const FRONT_NOTE =
  'Corrige la feuille : chiffres en un seul trait. Vérifie visuellement le rendu ' +
  "(capture d'écran) avant de répondre. NE PAS IMPRIMER : l'utilisateur veut valider l'aperçu.";

describe('the chat front hands the person’s request on as they wrote it; what it adds is its note @cap:parler-a-un-agent/moteur', () => {
  it('dashboard — the incident’s shape: the correction starts a NEW job, whose worker reads the first request verbatim in the thread history, and the front’s additions apart under their frame', async () => {
    const conversationId = await dashboardConversation();
    // Premier message : le front lance un job, qui livre une proposition.
    const first = await chatTurn(conversationId, REQUEST, {
      text: 'Je lance la création de la proposition.',
      instruction: 'Prépare une proposition de feuille, sans imprimer.',
    });
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: PROPOSAL })
      .where(eq(agentJobs.id, first!));
    // La correction : un NOUVEAU job, avec les ajouts du front.
    const jobId = await chatTurn(conversationId, CORRECTION, {
      text: 'Je corrige.',
      instruction: FRONT_NOTE,
    });
    expect(jobId).toBeTruthy();
    expect(jobId).not.toBe(first);

    // La ligne : le message de la personne ; la note du front, à part.
    expect(await jobRow(jobId!)).toEqual({ task: CORRECTION, handoffNote: FRONT_NOTE });

    // La requête RÉELLE du travailleur : le premier message de la personne mot
    // pour mot (daté) et la réponse d'alors, puis la correction seule dans son
    // message, puis la note sous son cadre. La contrainte « avant de
    // l'imprimer » est lue dans les mots de la personne, pas dans ceux du front.
    const sent = await workerRequest(jobId!);
    const users = userTexts(sent);
    expect(users).toHaveLength(3);
    expect(users[0]).toMatch(/^\[[^\]]+\] /);
    expect(users[0]!.endsWith(`] ${REQUEST}`)).toBe(true);
    expect(users.slice(1)).toEqual([CORRECTION, `${HANDOFF_NOTE_FRAME}\n${FRONT_NOTE}`]);
    expect(assistantTexts(sent)).toEqual([
      `Je lance la création de la proposition.\n\n${PROPOSAL}`,
    ]);
  }, 30_000);

  it('dashboard — a correction after a text-only reply: the first request and the reply reach the worker as the thread’s history', async () => {
    const conversationId = await dashboardConversation();
    expect(
      await chatTurn(conversationId, REQUEST, { text: 'Voici une proposition de feuille.' }),
    ).toBeUndefined();
    const jobId = await chatTurn(conversationId, CORRECTION, { instruction: FRONT_NOTE });

    expect(await jobRow(jobId!)).toEqual({ task: CORRECTION, handoffNote: FRONT_NOTE });
    const sent = await workerRequest(jobId!);
    const users = userTexts(sent);
    expect(users[0]!.endsWith(`] ${REQUEST}`)).toBe(true);
    expect(users.slice(1)).toEqual([CORRECTION, `${HANDOFF_NOTE_FRAME}\n${FRONT_NOTE}`]);
    expect(assistantTexts(sent)).toEqual(['Voici une proposition de feuille.']);
  }, 30_000);

  it('dashboard — a front that adds nothing: the worker receives the person’s words alone, and no note is kept', async () => {
    const words = 'Envoie le rapport du T3 à Mathilde.';
    const empty = await chatTurn(await dashboardConversation(), words, { instruction: '' });
    const repeated = await chatTurn(await dashboardConversation(), words, { instruction: words });

    for (const jobId of [empty!, repeated!]) {
      expect(await jobRow(jobId)).toEqual({ task: words, handoffNote: null });
      expect(userTexts(await workerRequest(jobId))).toEqual([words]);
    }
  }, 30_000);

  it('dashboard — a non-French request, with and without a note, travels unchanged', async () => {
    const japanese = '明日の会議の資料を三部印刷してください。';
    const plain = await chatTurn(await dashboardConversation(), japanese, {
      instruction: japanese,
    });
    expect(await jobRow(plain!)).toEqual({ task: japanese, handoffNote: null });

    const english = 'Send the Q3 report to Mathilde, as a PDF.';
    const note = 'The report is the one produced earlier in this chat.';
    const noted = await chatTurn(await dashboardConversation(), english, { instruction: note });
    expect(await jobRow(noted!)).toEqual({ task: english, handoffNote: note });
    expect(userTexts(await workerRequest(noted!))).toEqual([
      english,
      `${HANDOFF_NOTE_FRAME}\n${note}`,
    ]);
  }, 30_000);

  it('dashboard — the history is bounded like a channel’s: the oldest turns fall first, never the request', async () => {
    const conversationId = await dashboardConversation();
    // Douze tours de 2 000 caractères : plus que MAX_TURNS, plus que BUDGET_CHARS.
    for (let i = 0; i < 12; i++) {
      await chatTurn(conversationId, `TOUR-${String(i).padStart(2, '0')} ${'x'.repeat(2_000)}`, {
        text: `réponse ${i}`,
      });
    }
    const jobId = await chatTurn(conversationId, CORRECTION, { instruction: '' });
    const sent = await workerRequest(jobId!);
    const users = userTexts(sent);
    const replayed = users.slice(0, -1).map((u) => /TOUR-(\d\d)/.exec(u)?.[1]);
    // Les plus récents seulement, dans l'ordre, et la demande à la fin.
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.length).toBeLessThanOrEqual(8);
    expect(replayed[replayed.length - 1]).toBe('11');
    expect(users[users.length - 1]).toBe(CORRECTION);
    const historyChars = sent
      .slice(0, -1)
      .filter((m) => m.role !== 'system')
      .reduce((n, m) => n + textOf(m.content).length, 0);
    expect(historyChars).toBeLessThanOrEqual(BUDGET_CHARS);
  }, 60_000);
});

describe('a reply turn on a channel passes the person’s words on as typed, its own text as its note @cap:parler-par-canal-externe/moteur', () => {
  it.each(['telegram', 'discord'] as const)(
    '%s: the running work reads the typed correction verbatim, then the reply turn’s note under its frame',
    async (channel) => {
      const chatId = `chat-${randomUUID().slice(0, 8)}`;
      const take = (text: string) =>
        takeChannelTurn({
          tx: db as unknown as RunnerDeps['db'],
          entityId: seed.entityId,
          agentId,
          channel,
          chatId,
          text,
          groupPrefix: null,
          botHandle: null,
        });
      const head = await take(REQUEST);
      if (head.kind !== 'job') throw new Error('expected a job');
      await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, head.jobId));

      // La correction arrive pendant le travail : un tour de réponse, dont la
      // tâche est ce que la personne a tapé.
      const reply = await take(CORRECTION);
      if (reply.kind !== 'job') throw new Error('expected a job');
      expect(await jobRow(reply.jobId)).toEqual({ task: CORRECTION, handoffNote: null });

      // Le tour de réponse transmet, avec son propre texte.
      const ctx: ToolContext = {
        jobId: reply.jobId,
        agentId,
        entityId: seed.entityId,
        db: db as unknown as AnyDrizzleDb,
        jobChatId: chatId,
      };
      const relayed = 'Elle corrige le tracé : un seul trait par chiffre.';
      await messageConversationRunTool.execute({ job_id: head.jobId, message: relayed }, ctx);

      // Ce que le travail en cours lit : la correction TAPÉE, marquée comme un
      // message remis, puis la note du tour de réponse sous son cadre.
      const drained = await withinRunScope(head.jobId, async () => {
        recordClaim(head.jobId, 0);
        return drainJobInbox(db as unknown as AnyDrizzleDb, head.jobId);
      });
      expect(drained.map((m) => m.content)).toEqual([
        CORRECTION,
        `${HANDOFF_NOTE_FRAME}\n${relayed}`,
      ]);
      expect(drained.map((m) => [isInboxMessage(m), isHandoffNoteMessage(m)])).toEqual([
        [true, false],
        [false, true],
      ]);
    },
    30_000,
  );
});
