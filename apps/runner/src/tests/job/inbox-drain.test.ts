// inbox-drain.test.ts — un message qui arrive pendant un travail : le TOUR DE
// RÉPONSE voit ce qui tourne et y transmet, le travail en cours le LIT (#531).
//
// La spécification (Quentin, 30/09) : un message envoyé pendant qu'un travail
// tourne n'est jamais sans réponse, et il n'est pas présumé lié à ce travail.
// Il démarre un tour de réponse (`startConversationTurn`, prouvé dans
// packages/db et par les quatre canaux). Ici, la boucle RÉELLE (`executeJob`,
// vraie base de test, vrai client LLM construit depuis la clé de l'agent) et
// ce que le fournisseur reçoit, lu à la frontière `fetch` :
//   - le tour de réponse reçoit le bloc « Work running in this conversation »,
//     construit depuis des faits typés, transmet avec `message_conversation_run`
//     et répond ; il ne fait naître aucun autre tour ;
//   - la tête lit ce qui lui a été transmis : dans sa PREMIÈRE requête si c'est
//     arrivé avant ; AVANT DE CONCLURE si c'est arrivé pendant son dernier
//     appel (« je te donne suite à la fin » n'est pas une promesse en l'air) ;
//   - un message transmis pendant un dernier appel qui conclut par
//     `return_result` (pas de lecture à cet endroit) devient une nouvelle tête
//     à la transition terminale, réveillée tout de suite ;
//   - le tour suivant de la conversation rejoue le message lu.
//
// Mutations vérifiées :
//   - la lecture avant de conclure retirée (`lireLaFile('before_final_text')`)
//     → « read BEFORE concluding » rougit (le run conclut sans le message, une
//     seconde tête naît) ;
//   - la lecture en haut de tour retirée → « already waiting » rougit ;
//   - `wakeRelaunchedHeads` retiré d'`executeJob` → « return_result » rougit ;
//   - `followUps` vidé dans thread-history.ts → « the NEXT turn » rougit ;
//   - `answersWhileJobId` non transmis à `loadConversationContext` → « a reply
//     turn sees the running work » rougit (aucun bloc).

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
  deliverToConversationJob,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { formatLocalTime, inboxMessage, isInboxMessage } from '@nodal-agents/shared';
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

type Reply = { text?: string; toolCall?: { name: string; args: Record<string, unknown> } };

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

type Sent = Array<{ role: string; content: unknown }>;

/**
 * Le réseau : chaque appel au modèle est enregistré tel que le fournisseur le
 * reçoit ; la relecture d'action (#600) répond sans rien faire ; les autres
 * appels suivent `script`, et `onCall(n)` s'exécute AVANT la réponse n — pendant
 * l'appel, du point de vue du run.
 */
function network(script: readonly Reply[], onCall: (n: number) => Promise<void> = async () => {}) {
  const turns: Sent[] = [];
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
      const body = JSON.parse(init?.body as string) as { stream?: boolean; messages: Sent };
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
      if (reply.toolCall) {
        delta['tool_calls'] = [
          {
            index: 0,
            id: `call_${n}`,
            type: 'function',
            function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) },
          },
        ];
      }
      const finish = reply.toolCall ? 'tool_calls' : 'stop';
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

/** Une conversation du dashboard et sa tête, comme l'escalade du chat la crée. */
async function headJob(
  task: string,
  status = 'pending',
): Promise<{ conversationId: string; jobId: string }> {
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
      status,
      messages: [{ role: 'user', content: task }],
    })
    .returning({ id: agentJobs.id });
  return { conversationId: conv!.id, jobId: job!.id };
}

/** Ce qu'un tour de réponse transmet à la tête, par le même chemin que l'outil. */
function forward(conversationId: string, jobId: string, text: string) {
  return deliverToConversationJob(db as unknown as AnyDrizzleDb, {
    entityId: seed.entityId,
    conversationId,
    jobId,
    text,
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
      answersWhileJobId: agentJobs.answersWhileJobId,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(asc(agentJobs.createdAt));
}

const userTexts = (messages: Sent) =>
  messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));

const systemOf = (messages: Sent) => textOf(messages.find((m) => m.role === 'system')?.content);

describe('a message while the work runs: the reply turn sees it and passes it on, the running work reads it (#531) @cap:parler-a-un-agent/moteur', () => {
  it('a reply turn sees the running work, passes the person’s words on with message_conversation_run, and answers', async () => {
    const { conversationId, jobId: head } = await headJob('Fais-moi un portrait', 'processing');
    const [reply] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId,
        channel: 'dashboard',
        conversationId,
        task: FOLLOW_UP,
        status: 'pending',
        answersWhileJobId: head,
        messages: [{ role: 'user', content: FOLLOW_UP }],
      })
      .returning({ id: agentJobs.id });
    const net = network([
      {
        toolCall: {
          name: 'message_conversation_run',
          args: { job_id: head, message: 'Range aussi le portrait dans le dossier partagé.' },
        },
      },
      { text: 'C’est transmis au portrait en cours.' },
    ]);

    await executeJob(reply!.id as JobId, makeDeps(), runnerEnv);

    // Le bloc, dans la requête RÉELLE : les faits de la tête, et les gestes.
    const system = systemOf(net.turns[0]!);
    const block = system.slice(system.indexOf('## Work running in this conversation'));
    expect(block).toContain(`- run ${head} (`);
    expect(block).toContain('processing');
    expect(block).toContain('"Fais-moi un portrait"');
    expect(block).toContain('`message_conversation_run`');
    // Court : 775 caractères pour un run et un délégué (running-work-block.test.ts).
    const blockEnd = block.indexOf('\n\n## ', 5);
    expect((blockEnd === -1 ? block : block.slice(0, blockEnd)).length).toBeLessThan(1_000);

    const heads = await headsOf(conversationId);
    expect(heads.find((h) => h.id === head)!.inbox.map((e) => e.task)).toEqual([
      'Range aussi le portrait dans le dossier partagé.',
    ]);
    expect(heads.find((h) => h.id === reply!.id)).toMatchObject({
      status: 'completed',
      result: 'C’est transmis au portrait en cours.',
    });
    // Le tour de réponse n'en fait naître aucun autre : deux têtes, pas trois.
    expect(heads).toHaveLength(2);
  }, 30_000);

  it('a message already waiting when the head starts is in its FIRST request', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    expect((await forward(conversationId, jobId, FOLLOW_UP)).delivered).toBe(true);
    const net = network([{ text: 'Portrait fait, rangé dans le dossier partagé.' }]);

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    expect(userTexts(net.turns[0]!)).toEqual(['Fais-moi un portrait', FOLLOW_UP]);
    const heads = await headsOf(conversationId);
    expect(heads.map((h) => [h.id, h.status, h.inbox])).toEqual([[jobId, 'completed', []]]);
  }, 30_000);

  it('a message passed on DURING the head’s last call is read BEFORE concluding: one more request carries it, the result takes it into account, no second head', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    const net = network(
      [{ text: 'Voilà ton portrait.' }, { text: 'Portrait rangé dans le dossier partagé.' }],
      async (n) => {
        // Pendant le premier appel — celui qui allait conclure.
        if (n === 0) expect((await forward(conversationId, jobId, FOLLOW_UP)).delivered).toBe(true);
      },
    );

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    expect(net.turns).toHaveLength(2);
    expect(userTexts(net.turns[0]!)).toEqual(['Fais-moi un portrait']);
    // La seconde requête : la réponse qui allait conclure, puis le message.
    expect(net.turns[1]!.slice(-2).map((m) => [m.role, textOf(m.content)])).toEqual([
      ['assistant', 'Voilà ton portrait.'],
      ['user', FOLLOW_UP],
    ]);
    const heads = await headsOf(conversationId);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      id: jobId,
      status: 'completed',
      result: 'Portrait rangé dans le dossier partagé.',
      inbox: [],
    });
    const lus = (heads[0]!.messages as unknown[]).filter(isInboxMessage);
    expect(lus.map((m) => textOf((m as { content: unknown }).content))).toEqual([FOLLOW_UP]);
    expect(net.workerWakes).toEqual([]);
  }, 30_000);

  it('a message passed on during a last call ending with return_result becomes a new head, woken at once', async () => {
    const { conversationId, jobId } = await headJob('Fais-moi un portrait');
    const net = network(
      [
        {
          text: 'Voilà ton portrait.',
          toolCall: { name: 'return_result', args: { status: 'success' } },
        },
      ],
      async (n) => {
        if (n === 0) expect((await forward(conversationId, jobId, FOLLOW_UP)).delivered).toBe(true);
      },
    );

    await executeJob(jobId as JobId, makeDeps(), runnerEnv);

    const heads = await headsOf(conversationId);
    expect(heads.map((h) => ({ status: h.status, task: h.task, inbox: h.inbox }))).toEqual([
      { status: 'completed', task: 'Fais-moi un portrait', inbox: [] },
      { status: 'pending', task: FOLLOW_UP, inbox: [] },
    ]);
    expect(net.workerWakes).toEqual([heads[1]!.id]);
  }, 30_000);

  it('a DELEGATE whose head has already finished, sent a message during a last call ending with return_result: a new head carries it, woken at once (review of #642, pass 2)', async () => {
    const { conversationId, jobId: head } = await headJob('Fais-moi un portrait', 'completed');
    const [delegated] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId,
        channel: 'internal',
        conversationId,
        parentJobId: head,
        delegationDepth: 1,
        task: 'Generate the portrait',
        status: 'pending',
        messages: [{ role: 'user', content: 'Generate the portrait' }],
      })
      .returning({ id: agentJobs.id });
    const net = network(
      [
        {
          text: 'Portrait generated.',
          toolCall: { name: 'return_result', args: { status: 'success' } },
        },
      ],
      async (n) => {
        if (n === 0) {
          expect((await forward(conversationId, delegated!.id, FOLLOW_UP)).delivered).toBe(true);
        }
      },
    );

    await executeJob(delegated!.id as JobId, makeDeps(), runnerEnv);

    const heads = await headsOf(conversationId);
    expect(heads.map((h) => ({ status: h.status, task: h.task }))).toEqual([
      { status: 'completed', task: 'Fais-moi un portrait' },
      { status: 'pending', task: FOLLOW_UP },
    ]);
    expect(net.workerWakes).toEqual([heads[1]!.id]);
    const [row] = await db
      .select({ status: agentJobs.status, inbox: agentJobs.inbox })
      .from(agentJobs)
      .where(eq(agentJobs.id, delegated!.id));
    expect(row).toEqual({ status: 'completed', inbox: [] });
  }, 30_000);

  it('the NEXT turn of a channel conversation replays a message the work read, right after the request it concerned', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId, channel: 'telegram', chatId: '555' })
      .returning({ id: conversations.id });
    // Chaque message rejoué porte l'heure où la personne l'a envoyé (#650).
    const asked = new Date('2026-09-29T06:21:00Z');
    const received = new Date('2026-09-29T06:24:00Z');
    const lu = inboxMessage({
      id: randomUUID(),
      task: FOLLOW_UP,
      content: FOLLOW_UP,
      receivedAt: received.toISOString(),
    });
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId,
      channel: 'telegram',
      chatId: '555',
      conversationId: conv!.id,
      task: 'Fais-moi un portrait',
      createdAt: asked,
      status: 'completed',
      result: 'Portrait rangé dans le dossier partagé.',
      messages: [
        { role: 'user', content: 'Fais-moi un portrait' },
        { role: 'assistant', content: 'Voilà ton portrait.' },
        lu,
        { role: 'assistant', content: 'Portrait rangé dans le dossier partagé.' },
      ],
    });

    const history = await loadThreadHistory({
      db: db as unknown as RunnerDeps['db'],
      conversationId: conv!.id,
      channel: 'telegram',
      excludeJobId: randomUUID(),
      timezone: 'UTC',
    });

    expect(history.slice(0, 2)).toEqual([
      { role: 'user', content: `[${formatLocalTime('UTC', asked)}] Fais-moi un portrait` },
      { role: 'user', content: `[${formatLocalTime('UTC', received)}] ${FOLLOW_UP}` },
    ]);
  });
});
