// inbox-drain.test.ts — le travail en cours LIT ce que la personne ajoute
// pendant qu'il tourne (#531).
//
// Un message envoyé pendant que la tête de la conversation vit entre dans sa
// file (`deliverOrStartTurn`, prouvé dans packages/db et par les quatre
// canaux). Ici, la boucle RÉELLE (`executeJob`, vraie base de test, vrai client
// LLM construit depuis la clé de l'agent) et ce que le fournisseur reçoit,
// lu à la frontière `fetch` :
//   - un message déjà en file quand le run démarre est dans le PREMIER appel ;
//   - un message arrivé PENDANT le dernier appel (le modèle répond en texte, il
//     allait conclure) est lu avant de conclure : un appel de plus le porte, et
//     aucune seconde tête ne naît ;
//   - un message arrivé pendant un dernier appel qui conclut par
//     `return_result` (pas de lecture à cet endroit) devient une nouvelle tête
//     à la transition terminale, et elle est réveillée tout de suite ;
//   - le tour suivant de la conversation rejoue la précision (thread-history).
//
// Mutation vérifiée aussi : `followUps` vidé dans thread-history.ts → « the
// NEXT turn » rougit (la précision disparaît de l'historique).
//
// Mutations vérifiées :
//   - la lecture avant de conclure retirée (`lireLaFile('before_final_text')`)
//     → « arrived DURING the last call » rougit (le run conclut sans l'avoir
//     lu, une seconde tête naît) ;
//   - la lecture en haut de tour retirée → « already waiting » rougit (le
//     premier appel ne le porte pas) ;
//   - `wakeRelaunchedHeads` retiré d'`executeJob` → « return_result » rougit
//     (aucun réveil de la nouvelle tête) ;
//   - l'attente du média retirée de `lireLaFile` → « photo is still
//     downloading » rougit (le run conclut sans la photo) ; le vidage qui lit
//     aussi les entrées en préparation → le même test rougit (lue texte seul).

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
  and,
  asc,
  eq,
  isNull,
  attachToInboxEntry,
  deliverOrStartTurn,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { inboxMessage, isInboxMessage } from '@nodal-agents/shared';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { loadThreadHistory } from '../../job/thread-history.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agentId = '';

const FOLLOW_UP = 'et mets-le dans le dossier partagé';

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
      role: 'agent',
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

type Reply = { text?: string; returnResult?: boolean };

/** Un message de la requête, en texte : une chaîne, ou les parts de texte jointes. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text) : '',
    )
    .join('');
}

/**
 * Le réseau : chaque appel au modèle est enregistré tel que le fournisseur le
 * reçoit ; la relecture d'action (#600) répond sans rien faire ; les autres
 * appels suivent `script`, et `onCall(n)` s'exécute AVANT la réponse n — pendant
 * l'appel, du point de vue du run.
 */
function network(script: readonly Reply[], onCall: (n: number) => Promise<void>) {
  const turns: Array<Array<{ role: string; content: unknown }>> = [];
  const workerWakes: string[] = [];
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/worker')) {
        workerWakes.push((JSON.parse(String(init?.body)) as { jobId: string }).jobId);
        return new Response('{}', { status: 202 });
      }
      if (!url.includes('/chat/completions')) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init?.body as string) as {
        stream?: boolean;
        messages: Array<{ role: string; content: unknown }>;
      };
      const last = body.messages[body.messages.length - 1];
      const recheck = textOf(last?.content) === ACTION_RECHECK;
      let reply: Reply = { text: 'ok' };
      if (!recheck) {
        turns.push(body.messages);
        await onCall(n);
        reply = script[Math.min(n, script.length - 1)] ?? {};
        n += 1;
      }
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const delta: Record<string, unknown> = { role: 'assistant' };
      if (reply.text) delta['content'] = reply.text;
      if (reply.returnResult) {
        delta['tool_calls'] = [
          {
            index: 0,
            id: `call_${n}`,
            type: 'function',
            function: { name: 'return_result', arguments: '{"status":"success"}' },
          },
        ];
      }
      const finish = reply.returnResult ? 'tool_calls' : 'stop';
      if (body.stream === true) {
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const message: Record<string, unknown> = { role: 'assistant', content: reply.text ?? '' };
      if (delta['tool_calls']) {
        message['tool_calls'] = (delta['tool_calls'] as Array<Record<string, unknown>>).map(
          ({ index: _index, ...call }) => call,
        );
      }
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message, finish_reason: finish }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return { turns, workerWakes };
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

const runnerEnv = { APP_URL: 'http://runner.test', WORKER_SECRET: 'secret' } as RunnerEnv;

/** Une conversation du dashboard et sa tête `pending`, comme l'escalade du chat la crée. */
async function headJob(task: string): Promise<{ conversationId: string; jobId: string }> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId, channel: 'dashboard' })
    .returning({ id: conversations.id });
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'dashboard',
      conversationId: conv!.id,
      task,
      status: 'pending',
      messages: [{ role: 'user', content: task }],
    })
    .returning({ id: agentJobs.id });
  return { conversationId: conv!.id, jobId: job!.id };
}

/** Le message de la personne, par le point de décision que toutes les entrées appellent. */
async function personWrites(conversationId: string, text: string) {
  return deliverOrStartTurn(db as unknown as AnyDrizzleDb, {
    entityId: seed.entityId,
    conversationId,
    message: { task: text, content: text },
    start: {
      entityId: seed.entityId,
      agentId,
      channel: 'dashboard',
      conversationId,
      status: 'pending',
      task: text,
      messages: [{ role: 'user', content: text }],
    },
  });
}

async function headsOf(conversationId: string) {
  return db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      task: agentJobs.task,
      result: agentJobs.result,
      inbox: agentJobs.inbox,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(asc(agentJobs.createdAt));
}

const userTexts = (messages: ReadonlyArray<{ role: string; content: unknown }>) =>
  messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));

describe('the running work reads what the person adds while it runs (#531) @cap:parler-a-un-agent/moteur', () => {
  it('a message already waiting when the run starts is in the FIRST request', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    expect((await personWrites(conversationId, FOLLOW_UP)).kind).toBe('delivered');
    const net = network(
      [{ text: 'Portrait fait, rangé dans le dossier partagé.' }],
      async () => {},
    );

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    expect(userTexts(net.turns[0]!)).toEqual(['Fais-moi un portrait', FOLLOW_UP]);
    const heads = await headsOf(conversationId);
    expect(heads.map((h) => [h.id, h.status, h.inbox])).toEqual([[jobId, 'completed', []]]);
  }, 30_000);

  it('a message that arrived DURING the last call is read before concluding: one more request carries it, no second head', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    const net = network(
      [{ text: 'Voilà ton portrait.' }, { text: 'Je le range dans le dossier partagé.' }],
      async (n) => {
        // Pendant le premier appel — celui qui allait conclure.
        if (n === 0) expect((await personWrites(conversationId, FOLLOW_UP)).kind).toBe('delivered');
      },
    );

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    expect(net.turns).toHaveLength(2);
    expect(userTexts(net.turns[0]!)).toEqual(['Fais-moi un portrait']);
    // La seconde requête : la réponse qui allait conclure, puis la précision.
    const second = net.turns[1]!;
    expect(second.slice(-2).map((m) => [m.role, textOf(m.content)])).toEqual([
      ['assistant', 'Voilà ton portrait.'],
      ['user', FOLLOW_UP],
    ]);
    const heads = await headsOf(conversationId);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      id: jobId,
      status: 'completed',
      result: 'Je le range dans le dossier partagé.',
      inbox: [],
    });
    // Dans la transcription, marqué comme remis pendant le run.
    const remis = (heads[0]!.messages as unknown[]).filter(isInboxMessage);
    expect(remis.map((m) => textOf((m as { content: unknown }).content))).toEqual([FOLLOW_UP]);
    expect(net.workerWakes).toEqual([]);
  }, 30_000);

  it('a message whose photo is still downloading is not read without it: the run waits for the photo before concluding (review of #642, pass 1)', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    const photo = [
      { type: 'text' as const, text: 'dans ce style' },
      { type: 'image' as const, image: '/ws/shared/telegram/555/style.jpg' },
    ];
    const net = network(
      [{ text: 'Voilà ton portrait.' }, { text: 'Refait dans ce style.' }],
      async (n) => {
        if (n !== 0) return;
        // Pendant le dernier appel : le message arrive, sa photo se télécharge.
        const turn = await deliverOrStartTurn(db as unknown as AnyDrizzleDb, {
          entityId: seed.entityId,
          conversationId,
          message: { task: 'dans ce style', content: 'dans ce style', preparing: true },
          start: {
            entityId: seed.entityId,
            agentId,
            channel: 'dashboard',
            conversationId,
            task: 'dans ce style',
          },
        });
        if (turn.kind !== 'delivered') throw new Error('expected a delivery');
        // …et arrive une seconde et demie plus tard, hors de tout appel.
        setTimeout(() => {
          void attachToInboxEntry(db as unknown as AnyDrizzleDb, {
            entityId: seed.entityId,
            entryId: turn.entryId,
            content: photo,
          });
        }, 1_500);
      },
    );

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    expect(net.turns).toHaveLength(2);
    const heads = await headsOf(conversationId);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ status: 'completed', result: 'Refait dans ce style.' });
    // La transcription porte le message AVEC sa photo.
    const remis = (heads[0]!.messages as Array<{ content: unknown }>).filter(isInboxMessage);
    expect(remis.map((m) => m.content)).toEqual([photo]);
  }, 30_000);

  it('a message that arrived during a last call ending with return_result becomes a new head, woken at once', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    const net = network([{ text: 'Voilà ton portrait.', returnResult: true }], async (n) => {
      if (n === 0) expect((await personWrites(conversationId, FOLLOW_UP)).kind).toBe('delivered');
    });

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    const heads = await headsOf(conversationId);
    expect(heads.map((h) => ({ status: h.status, task: h.task, inbox: h.inbox }))).toEqual([
      { status: 'completed', task: 'Fais-moi un portrait', inbox: [] },
      { status: 'pending', task: FOLLOW_UP, inbox: [] },
    ]);
    expect(net.workerWakes).toEqual([heads[1]!.id]);
  }, 30_000);

  it('the NEXT turn of a channel conversation replays the follow-up right after the request it clarified', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId, channel: 'telegram', chatId: '555' })
      .returning({ id: conversations.id });
    const remis = inboxMessage({
      id: randomUUID(),
      task: FOLLOW_UP,
      content: FOLLOW_UP,
      receivedAt: new Date().toISOString(),
    });
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId: conv!.id,
      task: 'Fais-moi un portrait',
      status: 'completed',
      result: 'Portrait rangé dans le dossier partagé.',
      messages: [
        { role: 'user', content: 'Fais-moi un portrait' },
        { role: 'assistant', content: 'Voilà ton portrait.' },
        remis,
        { role: 'assistant', content: 'Portrait rangé dans le dossier partagé.' },
      ],
    });

    const history = await loadThreadHistory({
      db: db as unknown as RunnerDeps['db'],
      conversationId: conv!.id,
      channel: 'telegram',
      excludeJobId: randomUUID(),
    });

    expect(history.slice(0, 2)).toEqual([
      { role: 'user', content: 'Fais-moi un portrait' },
      { role: 'user', content: FOLLOW_UP },
    ]);
  });
});
