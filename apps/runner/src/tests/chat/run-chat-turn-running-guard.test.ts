// run-chat-turn-running-guard.test.ts — #453, #531 : un `run_task` pendant
// qu'un travail de la MÊME conversation court.
//
// Conversation e0ad53f8 (23/09) : la personne précise sa demande deux fois à
// 2,4 s d'écart ; le premier tour lance un travail, le second répond « c'est
// exactement ce que j'ai lancé » ET relance le même travail, reformulé. Trois
// jobs, 725 306 jetons d'entrée, pour une question. Le second job ne savait
// rien du premier.
//
// #453 refusait le `run_task` : plus de doublon, mais la précision n'atteignait
// jamais le travail en cours. LE CONTRAT depuis #531 (spécification de Quentin,
// 30/09) : le `run_task` passe par le point de décision de toutes les entrées
// (`startConversationTurn`, @nodal-agents/db) et démarre, pendant qu'une tête
// du fil vit, un TOUR DE RÉPONSE (`answers_while_job_id`) qui voit ce qui
// tourne et décide : transmettre, arrêter, lancer autre chose. Le message n'est
// jamais versé d'office dans la file du travail en cours : il n'est pas présumé
// lié.
//
// Il n'y a PAS d'échappatoire `alongside` (revue Codex de #453, passe 3) : un
// champ inventé par le modèle ne change rien, c'est le tour de réponse qui juge.
//
// Les assertions portent sur les LIGNES `agent_jobs` et `chat_messages`,
// jamais sur un compte d'appels.
//
// Mutations vérifiées : `startConversationTurn` qui ne lit plus la tête
// vivante → « démarre un TOUR DE RÉPONSE » rougit (le job naît « au repos ») ;
// la file de la conversation neutralisée (`work()` lancé sans attendre le tour
// précédent) → « deux tours SIMULTANÉS » garde deux jobs mais le second n'est
// plus un tour de réponse ; `runInLane` retiré de `routes/chat.ts` → le scan
// des appelants rougit en nommant le fichier.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, isNull } from '@nodal-agents/db';
import { agentJobs, chatMessages, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { CHAT_TOOLS, runChatTurn } from '../../chat/run-chat-turn.ts';
import { runInLane } from '../../chat/turn-lane.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TITLE_SYSTEM_PROMPT } from '../../chat/conversation-title.ts';
import { ACTION_RECHECK, actionRecheckMessages } from '../../llm/action-recheck.ts';

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
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('no active LLM client');
      return active;
    },
  };
});

// `alongside` reste possible dans ce que le MODÈLE écrit : un modèle peut
// toujours l'inventer, et le test prouve qu'il n'ouvre plus rien.
type Etape = { text?: string; runTask?: { instruction: string; alongside?: boolean } };

/**
 * Un modèle scripté appel par appel, qui capture ce que chaque appel de la
 * RÉPONSE a reçu. Les appels de titre (consigne `TITLE_SYSTEM_PROMPT`) rendent
 * un titre et ne consomment pas le scénario.
 */
function modele(scenario: readonly Etape[], captured: ModelMessage[][]): RunnerDeps['llmClient'] {
  let appel = 0;
  let titre = false;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      };
      if (titre) {
        return {
          content: [{ type: 'text' as const, text: 'Changelog' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
          warnings: [],
        };
      }
      const etape = scenario[Math.min(appel, scenario.length - 1)] ?? {};
      appel += 1;
      return {
        content: [
          ...(etape.text ? [{ type: 'text' as const, text: etape.text }] : []),
          ...(etape.runTask
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `tc-${appel}`,
                  toolName: 'run_task',
                  input: JSON.stringify(etape.runTask),
                },
              ]
            : []),
        ],
        finishReason: etape.runTask
          ? { unified: 'tool-calls' as const, raw: 'tool_use' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      titre = args.system === TITLE_SYSTEM_PROMPT;
      if (!titre) captured.push((args.messages ?? []) as ModelMessage[]);
      return generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>;
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
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;
let conversationId = '';
let premierJob = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
});

/** La conversation du ticket : un premier tour a lancé un travail. */
async function conversationAvecTravail(status: string | null): Promise<void> {
  await db.delete(chatMessages);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, seed.agentId));
  await db.delete(conversations);
  const [c] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Changelog',
      origin: 'user',
      channel: 'dashboard',
    })
    .returning({ id: conversations.id });
  conversationId = c!.id;
  const [j] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      status,
      channel: 'dashboard',
      conversationId,
      task: 'Find the changelog of nodal-agents 0.9.2',
    })
    .returning({ id: agentJobs.id });
  premierJob = j!.id;
  await db.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'user',
      content: 'nodal-agents',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'assistant',
      content: 'On it.',
      jobId: premierJob,
    },
  ]);
}

async function travauxDuFil(): Promise<
  Array<{ id: string; task: string; answersWhileJobId: string | null }>
> {
  return db
    .select({
      id: agentJobs.id,
      task: agentJobs.task,
      answersWhileJobId: agentJobs.answersWhileJobId,
    })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)))
    .orderBy(agentJobs.createdAt);
}

/** Les messages qui attendent dans la file d'un job (#531) : rien n'y est versé d'office. */
async function fileDe(jobId: string): Promise<string[]> {
  const [row] = await db
    .select({ inbox: agentJobs.inbox })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return (row?.inbox ?? []).map((e) => e.task);
}

beforeEach(() => {
  conversationId = '';
  premierJob = '';
});

describe('runChatTurn — un travail du fil court déjà (#453, #531) @cap:parler-a-un-agent/moteur', () => {
  it('un run_task pendant qu’un travail court démarre un TOUR DE RÉPONSE lié à ce travail, sans rien verser dans sa file', async () => {
    await conversationAvecTravail('processing');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          {
            text: 'Je regarde ce qui tourne.',
            runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' },
          },
        ],
        captured,
      ),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'i mean nodal-agents',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spawnedJobId).toBeTruthy();
    expect(await travauxDuFil()).toEqual([
      { id: premierJob, task: 'Find the changelog of nodal-agents 0.9.2', answersWhileJobId: null },
      {
        id: r.spawnedJobId,
        task: 'Find the nodal-agents 0.9.2 changelog',
        answersWhileJobId: premierJob,
      },
    ]);
    // Rien n'est versé d'office dans le travail en cours.
    expect(await fileDe(premierJob)).toEqual([]);
    // La réponse du tour est écrite, rattachée au tour de réponse.
    const [dernier] = await db
      .select({ content: chatMessages.content, jobId: chatMessages.jobId })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .then((rows) => rows.slice(-1));
    expect(dernier).toEqual({ content: 'Je regarde ce qui tourne.', jobId: r.spawnedJobId });
  });

  it('un `alongside: true` inventé par le modèle ne change rien : c’est un tour de réponse (revue Codex, passe 3)', async () => {
    await conversationAvecTravail('awaiting_delegation');
    setActiveLlmClient(
      modele(
        [
          {
            text: 'Launching it alongside.',
            runTask: { instruction: 'Find the nodal-agents 0.9.2 release notes', alongside: true },
          },
        ],
        [],
      ),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'the release notes, I mean',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [, tour] = await travauxDuFil();
    expect(tour).toEqual({
      id: r.spawnedJobId,
      task: 'Find the nodal-agents 0.9.2 release notes',
      answersWhileJobId: premierJob,
    });
  });

  it('`run_task` n’offre pas de champ `alongside`, et sa description dit le tour de réponse', () => {
    const schema = CHAT_TOOLS.run_task.inputSchema as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(schema.shape)).toEqual(['instruction']);
    expect(CHAT_TOOLS.run_task.description).not.toContain('alongside');
    expect(CHAT_TOOLS.run_task.description).toContain('starts a reply turn');
    expect(CHAT_TOOLS.run_task.description).toContain('never assumed to be about the running job');
  });

  it('une ligne SANS statut n’est vivante pour aucun chemin : run_task lance une tête au repos (revue de #642, passe 1)', async () => {
    // Revue Codex de #453 (passe 4) : la garde lisait `NULL` comme « en cours ».
    // Depuis #531, « vivant » a UNE définition, `LIVE_JOB_STATUSES`, celle des
    // faucheurs et du déclencheur de relance. Aucun écrivain ne pose de statut
    // NULL (défaut `pending`) : ce cas n'existe que construit à la main.
    await conversationAvecTravail(null);
    setActiveLlmClient(
      modele([{ runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } }], []),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'i mean nodal-agents',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [, tour] = await travauxDuFil();
    expect(tour?.answersWhileJobId).toBeNull();
  });

  it('un travail TERMINÉ ne retient rien : run_task lance une tête au repos, comme avant', async () => {
    await conversationAvecTravail('completed');
    setActiveLlmClient(modele([{ runTask: { instruction: 'Find the 0.9.3 changelog' } }], []));

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'and the 0.9.3 one?',
    });

    expect(r.ok).toBe(true);
    const travaux = await travauxDuFil();
    expect(travaux).toHaveLength(2);
    expect(travaux[1]?.answersWhileJobId).toBeNull();
  });

  it('deux tours SIMULTANÉS sur le même fil, par la file des routes : une tête, puis un tour de réponse PENDANT elle (revue Codex, P1)', async () => {
    // Les deux entrées du chat (`routes/chat.ts`, `routes/chat-stream.ts`)
    // passent chaque tour par `runInLane(conversationId, …)` : le second tour
    // voit la tête que le premier vient de lancer, et y répond.
    await conversationAvecTravail('completed');
    setActiveLlmClient(
      modele(
        [
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          {
            runTask: {
              instruction: 'Find the changelog of nodal-agents 0.9.2, i mean nodal-agents',
            },
          },
        ],
        [],
      ),
    );
    const tour = (message: string) =>
      runInLane(conversationId, () =>
        runChatTurn({
          deps,
          entityId: seed.entityId,
          agentId: seed.agentId,
          conversationId,
          message,
        }),
      );

    const [a, b] = await Promise.all([tour('nodal-agents'), tour('i mean nodal-agents')]);

    expect(a.ok && b.ok).toBe(true);
    const nouvelles = (await travauxDuFil()).filter((j) => j.id !== premierJob);
    expect(nouvelles).toEqual([
      {
        id: expect.any(String) as string,
        task: 'Find the nodal-agents 0.9.2 changelog',
        answersWhileJobId: null,
      },
      {
        id: expect.any(String) as string,
        task: 'Find the changelog of nodal-agents 0.9.2, i mean nodal-agents',
        answersWhileJobId: nouvelles[0]!.id,
      },
    ]);
  });
});

describe('toute entrée du chat passe par la file de sa conversation (#453, revue Codex P1)', () => {
  it('chaque appel de runChatTurn hors des tests est enveloppé dans runInLane(conversationId, …)', () => {
    // La garde de #453 n'est atomique avec l'insertion du job QUE parce qu'un
    // seul tour par conversation court à la fois. Une entrée de plus qui
    // appellerait `runChatTurn` sans la file rouvrirait la course : deux têtes
    // pour une demande (cas ci-dessus, mutation « sans file » → 2 têtes).
    const src = path.resolve(import.meta.dirname, '../..');
    const fichiers: string[] = [];
    const parcourir = (dir: string): void => {
      for (const nom of readdirSync(dir)) {
        const plein = path.join(dir, nom);
        if (statSync(plein).isDirectory()) {
          if (nom !== 'tests') parcourir(plein);
        } else if (nom.endsWith('.ts')) fichiers.push(plein);
      }
    };
    parcourir(src);
    const appelants = fichiers.filter(
      (f) =>
        !f.endsWith(path.join('chat', 'run-chat-turn.ts')) &&
        /\brunChatTurn\(/.test(readFileSync(f, 'utf8')),
    );
    expect(appelants.length).toBeGreaterThan(0);
    const sansFile = appelants.filter(
      (f) => !/runInLane\(conversationId,/.test(readFileSync(f, 'utf8')),
    );
    expect(sansFile).toEqual([]);
  });
});

/** Les appels de RELECTURE capturés (#600) : ceux qui finissent par la consigne partagée. */
const relectures = (captured: readonly ModelMessage[][]): ModelMessage[][] =>
  captured.filter((m) => m[m.length - 1]?.content === ACTION_RECHECK);

// Revue Nodal de la PR #604, passe 2 : chaque réponse FINALE en prose du tour
// passe par la relecture partagée, y compris celle qui suit un run_task refusé
// et celle de la relance sans outils. Une seule fois par tour, jamais en boucle.
describe('runChatTurn — every final prose reply is re-read, once per turn (#600) @cap:parler-a-un-agent/moteur', () => {
  it('while work runs, prose that the re-read escalates starts a reply turn, re-read once only (#531)', async () => {
    await conversationAvecTravail('processing');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          { text: 'Launching the search.' },
          // The re-read escalates: the call starts a reply turn (a job runs)…
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          { runTask: { instruction: 'never reached' } },
        ],
        captured,
      ),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'status?',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reply).toBe('Launching the search.');
    expect(relectures(captured)).toEqual([
      actionRecheckMessages('status?', 'Launching the search.'),
    ]);
    const [, tour] = await travauxDuFil();
    expect(tour).toMatchObject({
      task: 'Find the nodal-agents 0.9.2 changelog',
      answersWhileJobId: premierJob,
    });
  });

  it('the tool-free retry’s reply is re-read, and may escalate', async () => {
    // A finished job: nothing refuses a new run_task.
    await conversationAvecTravail('completed');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          // No text, no run_task: the tool-free retry answers…
          {},
          { text: 'I will fetch the 0.9.3 changelog.' },
          // …and its prose is re-read, which launches the work.
          { runTask: { instruction: 'Find the nodal-agents 0.9.3 changelog' } },
        ],
        captured,
      ),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'and 0.9.3?',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spawnedJobId).toBeTruthy();
    expect(relectures(captured)).toEqual([
      actionRecheckMessages('and 0.9.3?', 'I will fetch the 0.9.3 changelog.'),
    ]);
    expect((await travauxDuFil()).map((j) => j.task)).toContain(
      'Find the nodal-agents 0.9.3 changelog',
    );
  });
});
