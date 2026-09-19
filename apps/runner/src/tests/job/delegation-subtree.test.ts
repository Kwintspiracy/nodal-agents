// delegation-subtree.test.ts — issue #116, l'issue d'un SOUS-ARBRE de délégation.
//
// Trois étages, de vrais `assign_*`, de vrais enfants : grand-parent → enfant →
// petit-enfant. Rien n'est fabriqué à la main dans un transcript — chaque
// maillon passe par le code de production (`handleDelegation`, `executeJob`,
// `resumeDelegated`), parce que c'est précisément la JONCTION entre deux étages
// qui était en cause.
//
// Ce que ces tests prouvent :
//
//  1. la défaillance d'un petit-enfant atteint le grand-parent par
//     l'enregistrement TYPÉ, pas par une phrase. La PR #108 avait relu un
//     moment la ligne `[delegation stopped: … — no deliverable]` dans le texte
//     de l'enfant ; un enfant est un modèle, il peut écrire cette ligne
//     lui-même, avec le nom qu'il veut, et le harnais l'aurait livrée comme un
//     fait. La revue l'a mesuré, et la relecture a été retirée avant le merge ;
//  2. un échec propagé S'EFFACE quand une réparation réelle a eu lieu, par deux
//     routes différentes de celle qui avait échoué — le grand-parent va
//     lui-même voir le spécialiste, ou le sous-arbre est rejoué et l'obtient.
//     Les deux sont SUES de l'enregistrement, jamais déduites d'un nom ;
//  3. le chemin de SUCCÈS pose sa ligne d'outbox dans la transaction terminale
//     (couture T08) — jusqu'ici jamais exercé, parce que le canal à outil ne
//     pouvait pas finir dans la fixture : l'outil d'envoi n'était pas dans la
//     liste blanche de l'agent semé, et le job retombait toujours sur l'échec.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  agents,
  agentAssignments,
  jobDeliveries,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';

// ─── Interception du LLM ────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => void (active = c),
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('delegation-subtree.test: no active LLM client set');
      return active;
    },
  };
});

// ─── L'ADAPTATEUR D'ENVOI QUI MARCHE (résidu 4) ─────────────────────────────
//
// Sans lui, un canal à outil ne peut pas FINIR dans une fixture : l'agent semé
// n'a aucun outil d'envoi, `telegram_send_message` est refusé, les rappels de
// livraison s'épuisent et le job retombe sur `telegram_not_delivered`. Le
// chemin de succès — celui qui porte la couture T08 — n'était donc jamais
// atteint. L'adaptateur est le SEUL point remplacé : la liste blanche, elle,
// reste calculée depuis la base (un jeton de bot sur l'agent), invariant #9.
const envois: Array<{ chatId: string; text: string }> = [];

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    getAdapter: () => ({
      ...actual.telegramAdapter,
      sendText: async (
        _creds: unknown,
        chatId: string,
        text: string,
      ): Promise<{ messageId: string }> => {
        envois.push({ chatId, text });
        return { messageId: `mock-${envois.length}` };
      },
    }),
  };
});

interface MockTurn {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockTurn[]): RunnerDeps['llmClient'] {
  let i = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (r.text) content.push({ type: 'text', text: r.text });
      for (const tc of r.toolCalls ?? [])
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      const isTools = (r.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isTools
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
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
    generateText: (args) =>
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

const testEnv: RunnerEnv = {
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
  PORT: 3097,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3097',
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
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** Le spécialiste du dernier étage — celui qui ne rend rien. */
let outilPetitEnfant: string;
/** L'intermédiaire, orchestrateur lui aussi. */
let outilEnfant: string;
/** L'agent qui PARLE : un jeton de bot, donc les outils d'envoi (résidu 4). */
let agentQuiLivre: string;

async function seedAgent(
  nom: string,
  options: { orchestrateur: boolean; botToken?: string },
): Promise<{ id: string; slug: string }> {
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: nom,
      slug: `${nom}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      personality: `You are ${nom}.`,
      llmKeyId: seed.llmKeyId,
      active: true,
      ...(options.orchestrateur
        ? { role: 'orchestrator' as const, orchestratorMode: 'router' as const, systemAgent: true }
        : { role: 'agent' as const }),
      ...(options.botToken ? { telegramBotToken: options.botToken } : {}),
    } as never)
    .returning({ id: agents.id, slug: agents.slug });
  if (!row) throw new Error(`seed agent failed: ${nom}`);
  return row;
}

const outilAssign = (slug: string): string => `assign_${slug.replace(/-/g, '_')}`;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);

  // Le grand-parent EST l'agent semé — c'est lui qui porte les jobs racine.
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));

  const petitEnfant = await seedAgent('petit-enfant', { orchestrateur: false });
  const enfant = await seedAgent('enfant', { orchestrateur: true });
  const livreur = await seedAgent('livreur', { orchestrateur: true, botToken: 'bot-de-test' });
  outilPetitEnfant = outilAssign(petitEnfant.slug);
  outilEnfant = outilAssign(enfant.slug);
  agentQuiLivre = livreur.id;

  await db.insert(agentAssignments).values([
    // grand-parent → enfant, et grand-parent → petit-enfant (la route directe
    // qu'il emprunte pour réparer lui-même, deuxième test).
    { orchestratorId: seed.agentId, subAgentId: enfant.id, entityId: seed.entityId },
    { orchestratorId: seed.agentId, subAgentId: petitEnfant.id, entityId: seed.entityId },
    // enfant → petit-enfant : le troisième étage.
    { orchestratorId: enfant.id, subAgentId: petitEnfant.id, entityId: seed.entityId },
    // l'agent qui livre délègue lui aussi au petit-enfant.
    { orchestratorId: livreur.id, subAgentId: petitEnfant.id, entityId: seed.entityId },
  ] as never);

  // Le chat approuvé de cet agent. Sans lui l'ENVOI part quand même — l'outil
  // livre sur le chat d'origine du job — mais la file d'envoi le refuse
  // (`allowlist_refused`, elle revérifie juste avant d'émettre). Une fixture où
  // le harnais ne peut pas parler ne prouve pas grand-chose du chemin de succès.
  await db.insert(telegramAllowedChats).values({
    entityId: seed.entityId,
    agentId: livreur.id,
    chatId: '4242',
    role: 'owner',
    status: 'active',
  } as never);
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function insertJob(values: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'Fais la synthèse de la longueur de Planck',
      channel: 'api',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function jobRow(jobId: string) {
  const [row] = await db
    .select({ status: agentJobs.status, result: agentJobs.result, error: agentJobs.error })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Les deux tours d'un spécialiste qui ne rend RIEN : un rappel, puis l'échec. */
const petitEnfantMuet = (prefixe: string): MockTurn[] => [
  {
    toolCalls: [
      { toolCallId: `${prefixe}-1`, toolName: 'return_result', args: { status: 'success' } },
    ],
  },
  {
    toolCalls: [
      { toolCallId: `${prefixe}-2`, toolName: 'return_result', args: { status: 'success' } },
    ],
  },
];

/** Un tour qui LIVRE : un texte, et la fin du tour. */
const livre = (prefixe: string, texte: string): MockTurn => ({
  text: texte,
  toolCalls: [
    { toolCallId: `${prefixe}-rr`, toolName: 'return_result', args: { status: 'success' } },
  ],
});

const delegue = (prefixe: string, outil: string): MockTurn => ({
  toolCalls: [{ toolCallId: `${prefixe}-a`, toolName: outil, args: { task: 'cherche la valeur' } }],
});

describe('l’échec d’un petit-enfant atteint le grand-parent @cap:organiser-equipe/moteur', () => {
  it('le nomme dans le résultat livré, depuis l’enregistrement typé et non d’une phrase', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        delegue('gp', outilEnfant), // grand-parent → enfant
        delegue('e', outilPetitEnfant), // enfant → petit-enfant
        ...petitEnfantMuet('pe'), // le petit-enfant ne rend rien
        livre('e', 'Je n’ai pas obtenu la mesure, voici ce que j’ai pu réunir.'),
        livre('gp', 'Voici la synthèse.'),
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    // LE constat de #116 : le grand-parent nomme le PETIT-enfant. Il ne l'a
    // jamais lu dans une phrase — le texte de l'enfant ne part pas dans le
    // résultat du grand-parent, seul l'enregistrement typé voyage.
    expect(row.result ?? '').toContain(outilPetitEnfant);
    expect(row.result ?? '').toContain('no deliverable');
    // Et il ne met PAS en cause l'enfant, qui a livré : la carte porte les deux
    // faits, pas seulement les échecs.
    expect(row.result ?? '').not.toContain(outilEnfant);
  });

  it('le porte aussi dans l’enregistrement que SON propre parent recevrait', async () => {
    // Le grand-parent est ici lui-même un délégué : ce que `executeJob` rend
    // est exactement ce que `delegationRecordFromOutcome` mettra dans le record
    // du parent. La chaîne ne s'arrête donc pas à trois étages.
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        delegue('gp2', outilEnfant),
        delegue('e2', outilPetitEnfant),
        ...petitEnfantMuet('pe2'),
        livre('e2', 'Rien du spécialiste, voici mon propre travail.'),
        livre('gp2', 'Synthèse remise.'),
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    // L'issue du sous-arbre, spécialiste par spécialiste — un CHAMP, pas une
    // ligne de texte à relire.
    expect(outcome.subDelegations).toEqual(
      expect.arrayContaining([
        { tool: outilPetitEnfant, status: 'failed' },
        { tool: outilEnfant, status: 'delivered' },
      ]),
    );
  });
});

describe('une réparation réelle efface l’échec propagé @cap:organiser-equipe/moteur', () => {
  it('ROUTE 1 — le grand-parent va lui-même voir le spécialiste, et il livre', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        delegue('r1gp', outilEnfant),
        delegue('r1e', outilPetitEnfant),
        ...petitEnfantMuet('r1pe'),
        livre('r1e', 'Je n’ai pas obtenu la mesure.'),
        // Le grand-parent ne redemande PAS à l'enfant (rejeu naïf refusé par le
        // cap par slug) : il descend d'un étage et va voir le spécialiste.
        delegue('r1gp2', outilPetitEnfant),
        livre('r1pe2', 'Longueur de Planck : 1.616255e-35 m.'),
        livre('r1gp2', 'Voici la synthèse, complète.'),
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    // Plus rien à dire : le travail manquant a été fait, et le harnais le SAIT
    // — le second enregistrement du même spécialiste dit `completed`.
    expect(row.result ?? '').not.toContain('delegation stopped');
    expect(row.result ?? '').not.toContain('no deliverable');
  });

  it('ROUTE 2 — le sous-arbre est rejoué et l’obtient : le grand-parent le sait du record', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        delegue('r2gp', outilEnfant),
        delegue('r2e', outilPetitEnfant),
        ...petitEnfantMuet('r2pe'),
        livre('r2e', 'Rien obtenu cette fois.'),
        // Deuxième passage chez le MÊME intermédiaire — autorisé, sa première
        // délégation avait réussi. Cette fois son propre spécialiste livre.
        delegue('r2gp2', outilEnfant),
        delegue('r2e2', outilPetitEnfant),
        livre('r2pe2', 'Longueur de Planck : 1.616255e-35 m.'),
        livre('r2e2', 'Voici la mesure demandée.'),
        livre('r2gp2', 'Synthèse complète.'),
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    // La réparation a eu lieu DANS un autre sous-arbre, à un étage que le
    // grand-parent ne voit pas. Il l'apprend parce que le record le DIT ;
    // déduit d'un nom, cet échec serait resté collé sur un résultat complet.
    expect(row.result ?? '').not.toContain('delegation stopped');
    if (outcome.status !== 'completed') throw new Error('unreachable');
    expect(outcome.subDelegations).toEqual(
      expect.arrayContaining([{ tool: outilPetitEnfant, status: 'delivered' }]),
    );
  });
});

describe('le SUCCÈS pose sa livraison dans la transaction terminale @cap:organiser-equipe/moteur', () => {
  it('sur un canal à outil, la notice d’échec est commise avec le statut et part', async () => {
    envois.length = 0;
    const jobId = await insertJob({
      agentId: agentQuiLivre,
      channel: 'telegram',
      chatId: '4242',
    });
    const deps = makeDeps(
      makeMockLlmClient([
        delegue('s', outilPetitEnfant),
        ...petitEnfantMuet('spe'),
        // L'agent DIT la vérité à l'utilisateur, avec son propre outil.
        {
          toolCalls: [
            {
              toolCallId: 's-send',
              toolName: 'telegram_send_message',
              args: { text: 'Le spécialiste n’a rien rendu, je n’ai pas la mesure.' },
            },
          ],
        },
        livre('s', 'Dit à l’utilisateur.'),
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    // Le chemin de SUCCÈS, atteint pour la première fois sur un canal à outil :
    // sans adaptateur d'envoi, le job retombait toujours sur
    // `telegram_not_delivered`.
    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('completed');

    // La ligne d'outbox existe et porte la notice du harnais — écrite DANS la
    // transaction qui a posé `completed` (couture T08).
    const livraisons = await db
      .select({ payload: jobDeliveries.payload, chatId: jobDeliveries.chatId })
      .from(jobDeliveries)
      .where(eq(jobDeliveries.jobId, jobId));
    expect(livraisons).toHaveLength(1);
    expect(livraisons[0]?.payload ?? '').toContain(outilPetitEnfant);
    expect(livraisons[0]?.payload ?? '').toContain('no deliverable');
    expect(livraisons[0]?.chatId).toBe('4242');

    // Et elle PART : le drain qui suit le commit l'a remise à l'adaptateur.
    expect(envois.map((e) => e.text).join('\n')).toContain('no deliverable');
    expect(envois.every((e) => e.chatId === '4242')).toBe(true);
  });
});
