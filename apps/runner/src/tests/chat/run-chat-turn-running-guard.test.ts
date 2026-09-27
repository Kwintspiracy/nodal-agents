// run-chat-turn-running-guard.test.ts — #453 : un second `run_task` pendant
// qu'un travail de la MÊME conversation court.
//
// Conversation e0ad53f8 (23/09) : la personne précise sa demande deux fois à
// 2,4 s d'écart ; le premier tour lance un travail, le second répond « c'est
// exactement ce que j'ai lancé » ET relance le même travail, reformulé. Trois
// jobs, 725 306 jetons d'entrée, pour une question. L'historique montrait bien
// le premier job en cours : c'est le modèle qui re-déclenche par-dessus.
//
// LE CONTRAT, générique, sur `run_task` dans le chat : tant qu'un travail lancé
// depuis CETTE conversation court, un nouveau `run_task` est REFUSÉ au modèle,
// qui reçoit le travail en cours (id, tâche, état) et la règle : dire qu'il est
// déjà dessus ; un travail différent se lance quand celui-ci est fini, ou depuis
// une nouvelle conversation. Jamais un appel jeté en silence.
//
// Il n'y a PAS d'échappatoire « en parallèle » (revue Codex, passe 3). Le champ
// `alongside` a existé : une reformulation (« the changelog of 0.9.2 » puis
// « the 0.9.2 release notes ») passait sous la comparaison de textes, et ce
// champ ne reposait que sur la parole du modèle. Il est retiré (invariant #11 :
// retirer un mécanisme plutôt qu'ajouter une branche).
//
// Les assertions portent sur les LIGNES `agent_jobs` et sur le CORPS du second
// appel au modèle (le tool_result du refus), jamais sur un compte d'appels.
//
// Mutation vérifiée : la garde retirée (`runningHeads` forcé à `[]`) → « un
// run_task pendant qu'un travail court » rougit sur le nombre de jobs (2 au
// lieu de 1).
// Revue Codex (P1) : la garde n'est atomique avec l'insertion que parce que
// chaque tour passe par la file de sa conversation (`runInLane`). Mutations :
//   - la file neutralisée (`work()` lancé sans attendre le tour précédent) →
//     « deux tours SIMULTANÉS » rougit (2 têtes) ;
//   - `runInLane` retiré de `routes/chat.ts` → le scan des appelants rougit en
//     nommant le fichier.
// Revue Codex, passe 2 : la phrase du second appel refusé gardée → « ne
// laisse pas sa phrase je lance » rougit.
// Revue Codex, passe 3 : un `alongside: true` honoré de nouveau → « une
// reformulation, même avec alongside » rougit (un second job est créé).

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

/** Le texte de tous les tool_result d'un appel. */
function toolResults(messages: readonly ModelMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const value = (p as { output?: { value?: unknown } }).output?.value;
      if (typeof value === 'string') out.push(value);
    }
  }
  return out.join('\n');
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

async function travauxDuFil(): Promise<Array<{ id: string; task: string }>> {
  return db
    .select({ id: agentJobs.id, task: agentJobs.task })
    .from(agentJobs)
    .where(and(eq(agentJobs.conversationId, conversationId), isNull(agentJobs.parentJobId)));
}

beforeEach(() => {
  conversationId = '';
  premierJob = '';
});

describe('runChatTurn — un travail du fil court déjà (#453) @cap:parler-a-un-agent/moteur', () => {
  it('un run_task pendant qu’un travail court est REFUSÉ au modèle : un seul job, et le refus nomme le travail', async () => {
    await conversationAvecTravail('processing');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          { text: 'I am already on it, the research is still running.' },
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
    expect(r.spawnedJobId).toBeUndefined();
    expect(r.reply).toBe('I am already on it, the research is still running.');
    // UNE ligne : le travail d'origine, et lui seul.
    expect((await travauxDuFil()).map((j) => j.id)).toEqual([premierJob]);

    // Le second appel a reçu le refus, dans le résultat de SON appel d'outil :
    // l'id, la tâche et l'état du travail qui court, et la règle.
    const refus = toolResults(captured[1] ?? []);
    expect(refus).toContain(premierJob);
    expect(refus).toContain('Find the changelog of nodal-agents 0.9.2');
    expect(refus).toContain('processing');
    expect(refus).toContain('once it has finished, or from a new conversation');
    expect(refus).not.toContain('alongside');

    // La réponse du tour est écrite, sans job rattaché.
    const [dernier] = await db
      .select({ content: chatMessages.content, jobId: chatMessages.jobId })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .then((rows) => rows.slice(-1));
    expect(dernier).toEqual({
      content: 'I am already on it, the research is still running.',
      jobId: null,
    });
  });

  it('une REFORMULATION, même avec un `alongside: true` inventé par le modèle, est refusée : un seul job (revue Codex, passe 3)', async () => {
    await conversationAvecTravail('processing');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          {
            text: 'Launching it alongside.',
            runTask: { instruction: 'Find the nodal-agents 0.9.2 release notes', alongside: true },
          },
          { text: 'Already on it.' },
        ],
        captured,
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
    expect(r.spawnedJobId).toBeUndefined();
    expect(r.reply).toBe('Already on it.');
    expect((await travauxDuFil()).map((j) => j.id)).toEqual([premierJob]);
    expect(toolResults(captured[1] ?? [])).toContain(premierJob);
  });

  it('`run_task` n’offre plus de champ `alongside`, ni dans son schéma ni dans sa description', () => {
    const schema = CHAT_TOOLS.run_task.inputSchema as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(schema.shape)).toEqual(['instruction']);
    expect(CHAT_TOOLS.run_task.description).not.toContain('alongside');
    expect(CHAT_TOOLS.run_task.description).toContain('once it has finished');
  });

  it('après le refus, un second run_task refusé ne laisse pas sa phrase « je lance » : le modèle répond sans outil, refus en mains (revue Codex, passe 2)', async () => {
    await conversationAvecTravail('processing');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          { text: 'Je lance l’autre tâche.', runTask: { instruction: 'Summarise it' } },
          { text: 'The research is still running; I will summarise once it is done.' },
        ],
        captured,
      ),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'and summarise it',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spawnedJobId).toBeUndefined();
    // La phrase qui annonçait un lancement n'est PAS la réponse.
    expect(r.reply).toBe('The research is still running; I will summarise once it is done.');
    expect((await travauxDuFil()).map((j) => j.id)).toEqual([premierJob]);
    // Le dernier appel a vu les DEUX refus, et c'était un appel sans outils.
    const dernier = captured[2] ?? [];
    expect(toolResults(dernier).split('run_task refused').length - 1).toBe(2);
    const [ecrit] = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .then((rows) => rows.slice(-1));
    expect(ecrit?.content).not.toContain('Je lance');
  });

  it('une tête au statut NULL retient aussi : `NULL NOT IN (…)` n’est pas « terminé » (revue Codex, passe 4)', async () => {
    // L'historique affiche une tête sans statut comme « still running »
    // (`buildDispatchOutput`) ; la garde la laissait passer, parce qu'en SQL
    // `NULL NOT IN ('completed', …)` vaut « inconnu » et exclut la ligne.
    await conversationAvecTravail(null);
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          { text: 'Already on it.' },
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
    expect(r.spawnedJobId).toBeUndefined();
    expect((await travauxDuFil()).map((j) => j.id)).toEqual([premierJob]);
    const [tete] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, premierJob));
    expect(tete!.status).toBeNull();
    expect(toolResults(captured[1] ?? [])).toContain(premierJob);
  });

  it('un travail TERMINÉ ne retient rien : run_task lance comme avant', async () => {
    await conversationAvecTravail('completed');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele([{ runTask: { instruction: 'Find the 0.9.3 changelog' } }], captured),
    );

    const r = await runChatTurn({
      deps,
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      message: 'and the 0.9.3 one?',
    });

    expect(r.ok).toBe(true);
    expect(await travauxDuFil()).toHaveLength(2);
  });

  it('deux tours SIMULTANÉS sur le même fil, par la file des routes : UNE seule tête (revue Codex, P1)', async () => {
    // Les deux entrées du chat (`routes/chat.ts`, `routes/chat-stream.ts`)
    // passent chaque tour par `runInLane(conversationId, …)`. C'est ce qui rend
    // la garde atomique avec l'insertion : le second tour ne lit « une tête en
    // cours ? » qu'une fois le premier fini, job inséré compris. La même file
    // couvre les agents à runtime CLI : elle entoure `runChatTurn` en entier,
    // avant sa sortie vers `runCliRuntimeChatTurn`.
    await conversationAvecTravail('completed');
    const captured: ModelMessage[][] = [];
    setActiveLlmClient(
      modele(
        [
          { runTask: { instruction: 'Find the nodal-agents 0.9.2 changelog' } },
          {
            runTask: {
              instruction: 'Find the changelog of nodal-agents 0.9.2, i mean nodal-agents',
            },
          },
          { text: 'Already on it.' },
        ],
        captured,
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
    expect(nouvelles).toHaveLength(1);
    expect(nouvelles[0]!.task).toBe('Find the nodal-agents 0.9.2 changelog');
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
