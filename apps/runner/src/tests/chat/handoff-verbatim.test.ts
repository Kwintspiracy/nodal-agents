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
//   - tableau de bord : la tâche est ce que la personne a écrit depuis la
//     dernière remise (la demande restée sans job, puis la correction), prise
//     par la plateforme ; l'instruction du front est sa note. Le travailleur
//     reçoit les mots seuls dans leur message, puis la note sous son cadre ;
//   - un front qui n'ajoute rien : aucune note, un seul message ;
//   - après une remise, seuls les messages d'après sont transmis ;
//   - une langue autre que le français, avec et sans note ;
//   - Telegram et Discord : un tour de réponse né d'une correction transmet au
//     travail en cours les mots TAPÉS, et son propre texte comme sa note.
//
// Mutations vérifiées (chacune rougit au moins un cas ci-dessous) :
//   - `task: personsWords` remplacé par l'instruction du modèle (l'ancien
//     comportement) → les cas du tableau de bord rougissent ;
//   - `personsWordsSinceLastHandoff` qui ne garde que le message du tour →
//     « a correction after a text-only reply » rougit ;
//   - la frontière de la dernière remise ignorée (`break` retiré) → « only
//     what the person said since » rougit ;
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
const FRONT_NOTE =
  'Corrige la feuille : chiffres en un seul trait. Vérifie visuellement le rendu ' +
  "(capture d'écran) avant de répondre. NE PAS IMPRIMER : l'utilisateur veut valider l'aperçu.";

describe('the chat front hands the person’s request on as they wrote it; what it adds is its note @cap:parler-a-un-agent/moteur', () => {
  it('dashboard — a correction after a text-only reply: both messages reach the worker verbatim, the front’s additions apart under their frame', async () => {
    const conversationId = await dashboardConversation();
    // Premier message : le front répond en texte, aucun job.
    expect(
      await chatTurn(conversationId, REQUEST, { text: 'Voici une proposition de feuille.' }),
    ).toBeUndefined();
    // La correction : le front lance le travail, avec ses propres ajouts.
    const jobId = await chatTurn(conversationId, CORRECTION, {
      text: 'Je corrige.',
      instruction: FRONT_NOTE,
    });
    expect(jobId).toBeTruthy();

    // La ligne : les mots de la personne, dans l'ordre ; la note du front, à part.
    expect(await jobRow(jobId!)).toEqual({
      task: `${REQUEST}\n\n${CORRECTION}`,
      handoffNote: FRONT_NOTE,
    });

    // La requête RÉELLE du travailleur : les mots seuls dans leur message, puis
    // la note sous son cadre. Rien de ce que le front a écrit n'est dans le
    // message de la personne.
    const sent = await workerRequest(jobId!);
    expect(userTexts(sent)).toEqual([
      `${REQUEST}\n\n${CORRECTION}`,
      `${HANDOFF_NOTE_FRAME}\n${FRONT_NOTE}`,
    ]);
  }, 30_000);

  it('dashboard — a front that adds nothing: the worker receives the person’s words alone, and no note is kept', async () => {
    const conversationId = await dashboardConversation();
    const words = 'Envoie le rapport du T3 à Mathilde.';
    const empty = await chatTurn(conversationId, words, { instruction: '' });
    const repeated = await chatTurn(await dashboardConversation(), words, { instruction: words });

    for (const jobId of [empty!, repeated!]) {
      expect(await jobRow(jobId)).toEqual({ task: words, handoffNote: null });
      expect(userTexts(await workerRequest(jobId))).toEqual([words]);
    }
  }, 30_000);

  it('dashboard — after a hand-off, only what the person said since reaches the next one', async () => {
    const conversationId = await dashboardConversation();
    const first = await chatTurn(conversationId, REQUEST, { instruction: 'Fais la feuille.' });
    expect(first).toBeTruthy();
    const second = await chatTurn(conversationId, CORRECTION, {
      instruction: 'La feuille déjà proposée dans ce fil.',
    });

    expect(await jobRow(second!)).toEqual({
      task: CORRECTION,
      handoffNote: 'La feuille déjà proposée dans ce fil.',
    });
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
