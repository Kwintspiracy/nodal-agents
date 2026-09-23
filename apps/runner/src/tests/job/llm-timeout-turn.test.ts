// llm-timeout-turn.test.ts — un tour qui expire ne jette pas le travail fait
// (issue #121).
//
// L'incident : un agent de revue avait travaillé douze tours (vingt lectures
// de fichiers) quand le treizième a expiré. (Le nom de l'agent est dans
// l'issue, pas ici : un nom d'agent d'une installation réelle n'a rien à faire
// dans la source, invariant #1.) Le job est passé `failed`, son
// résultat était l'exception recopiée (« LLM call timed out after 300000ms …
// and no explanation was provided »), et le parent n'a rien reçu des douze
// tours.
//
// Ce qui se prouve ici, sur le VRAI chemin (executeJob, base de test réelle,
// modèle simulé) : le tour expiré est rejoué une fois ; quand le rejeu expire
// aussi, le travail échoue en gardant ce que l'agent avait écrit, avec
// `exit_reason: timeout` pour le parent, et une ligne de faits à la place de
// l'exception.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import {
  createEmbeddingClient,
  AllProvidersFailedError,
  LLMTimeoutError,
  LLMCallCancelledError,
  estimateContextTokens,
  estimateToolTokens,
} from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import {
  delegationRecordFromOutcome,
  executeJob,
  timeoutErrorCode,
  timeoutOfTurn,
  timeoutStopLine,
  resumeInstruction,
  STOP_POLL_MS,
} from '../../job/execute.ts';

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
      if (!active) throw new Error('llm-timeout-turn.test: no active LLM client set');
      return active;
    },
  };
});

/**
 * Un tour du modèle simulé, ou une expiration à la place de la réponse.
 *
 * `timesOut` : l'expiration nue, celle d'un agent à un seul fournisseur.
 * `timesOutViaFailover` : la même, arrivée au bout d'une chaîne de repli
 * épuisée — c'est `AllProvidersFailedError` qui sort, l'expiration étant sa
 * cause (revue C de la PR #172).
 */
type MockTurn =
  | { cutWhileWriting: string; timesOut?: false; timesOutViaFailover?: false }
  | { cutAfterToolCall: string; timesOut?: false; timesOutViaFailover?: false }
  | {
      cutThinking: { partial: string; generated: number };
      timesOut?: false;
      timesOutViaFailover?: false;
    }
  | { failsWith: Error; timesOut?: false; timesOutViaFailover?: false }
  | {
      stoppedWhileWriting: { jobId: string; partial: string };
      timesOut?: false;
      timesOutViaFailover?: false;
    }
  | {
      stoppedThenAnswers: { jobId: string };
      timesOut?: false;
      timesOutViaFailover?: false;
      text?: string;
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
    }
  | {
      cancelThenCut: { jobId: string; partial: string };
      timesOut?: false;
      timesOutViaFailover?: false;
    }
  | { timesOut: true; timesOutViaFailover?: false }
  | { timesOut?: false; timesOutViaFailover: true }
  | {
      timesOut?: false;
      timesOutViaFailover?: false;
      text?: string;
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
      /** Jetons d'entrée déclarés par le fournisseur simulé (10 par défaut). */
      usageIn?: number;
    };

const PROVIDER = 'anthropic';
const MODEL = 'mock';

/**
 * Le client simulé. `timesOut` lève l'erreur que `packages/llm` surface quand
 * le transport a rendu les armes — après son propre rejeu à connexion neuve
 * (`withStaleRetry`), qui vit sous `generateText` et n'est donc pas rejoué ici.
 */
function makeMockLlmClient(
  responses: MockTurn[],
  compteur?: { appels: number },
  requetes?: unknown[][],
  argsBruts?: Array<Parameters<RunnerDeps['llmClient']['generateText']>[0]>,
): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = (responses[callIndex] ?? responses[responses.length - 1]!) as {
        usageIn?: number;
        text?: string;
        toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
      };
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: {
            total: response.usageIn ?? 10,
            noCache: response.usageIn ?? 10,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: PROVIDER, model: MODEL } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args, opts) => {
      if (compteur) compteur.appels += 1;
      requetes?.push(JSON.parse(JSON.stringify(args.messages ?? [])) as unknown[]);
      argsBruts?.push(args);
      const prevu = responses[callIndex];
      if (prevu && 'cutWhileWriting' in prevu) {
        // Un tour streamé coupé EN PLEINE ÉCRITURE (#440) : l'expiration porte
        // le texte déjà reçu, comme la lève packages/llm/src/turn-clocks.ts.
        callIndex++;
        return Promise.reject(
          new LLMTimeoutError(PROVIDER, MODEL, 60_000, {
            reason: 'idle_between_tokens',
            partialText: prevu.cutWhileWriting,
          }),
        ) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'cutThinking' in prevu) {
        // Coupé après avoir beaucoup RAISONNÉ et peu écrit : le fournisseur
        // facture tout ce qu'il a généré, pas seulement le texte visible.
        callIndex++;
        const { partial, generated } = (
          prevu as { cutThinking: { partial: string; generated: number } }
        ).cutThinking;
        return Promise.reject(
          new LLMTimeoutError(PROVIDER, MODEL, 60_000, {
            reason: 'idle_between_tokens',
            partialText: partial,
            served: true,
            generatedChars: generated,
          }),
        ) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'cutAfterToolCall' in prevu) {
        // Coupé APRÈS avoir émis un appel d'outil : du texte, mais pas
        // reprenable — le texte seul perdrait l'appel.
        callIndex++;
        return Promise.reject(
          new LLMTimeoutError(PROVIDER, MODEL, 60_000, {
            reason: 'idle_between_tokens',
            partialText: prevu.cutAfterToolCall,
            resumable: false,
            served: true,
          }),
        ) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'cancelThenCut' in prevu) {
        // La personne annule PENDANT l'appel, qui est ensuite coupé en écrivant.
        callIndex++;
        const { jobId: annule, partial } = prevu.cancelThenCut;
        return db
          .update(agentJobs)
          .set({ status: 'cancelled' })
          .where(eq(agentJobs.id, annule))
          .then(() =>
            Promise.reject(
              new LLMTimeoutError(PROVIDER, MODEL, 60_000, {
                reason: 'idle_between_tokens',
                partialText: partial,
              }),
            ),
          ) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'stoppedWhileWriting' in prevu) {
        // Un tour qui écrit sans fin ; la personne appuie sur Stop une seconde
        // après son début. L'appel ne se termine QUE si le runner l'abandonne.
        callIndex++;
        const { jobId: arrete, partial } = prevu.stoppedWhileWriting;
        setTimeout(() => {
          // Une requête Drizzle ne part qu'à l'attente : sans then, rien n'est écrit.
          void db
            .update(agentJobs)
            .set({ status: 'cancelled' })
            .where(eq(agentJobs.id, arrete))
            .then(() => {});
        }, 1_000);
        return new Promise((_resolve, reject) => {
          const signal = opts?.abortSignal;
          if (!signal) return; // jamais abandonné : le test expire, c'est le rouge voulu
          signal.addEventListener('abort', () =>
            reject(new LLMCallCancelledError(PROVIDER, MODEL, partial, true, 4_000)),
          );
        }) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'stoppedThenAnswers' in prevu) {
        // Stop arrive pendant que la réponse se termine : elle revient quand même.
        const { jobId: arrete } = (prevu as { stoppedThenAnswers: { jobId: string } })
          .stoppedThenAnswers;
        return db
          .update(agentJobs)
          .set({ status: 'cancelled' })
          .where(eq(agentJobs.id, arrete))
          .then(() =>
            generateText({ ...args, model: mockModel } as Parameters<typeof generateText>[0]),
          ) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
      if (prevu && 'failsWith' in prevu) {
        callIndex++;
        return Promise.reject(prevu.failsWith) as ReturnType<
          RunnerDeps['llmClient']['generateText']
        >;
      }
      if (prevu?.timesOut === true || prevu?.timesOutViaFailover === true) {
        callIndex++;
        const expiration = new LLMTimeoutError(PROVIDER, MODEL, 300_000);
        // La chaîne de repli ne rend pas l'expiration telle quelle : elle rend
        // son propre échec, l'expiration en cause.
        const leve =
          prevu.timesOutViaFailover === true
            ? new AllProvidersFailedError(2, expiration)
            : expiration;
        return Promise.reject(leve) as ReturnType<RunnerDeps['llmClient']['generateText']>;
      }
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
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
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
      channel: 'internal',
      task: 'Relis le dossier et rends ton avis',
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
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
      turn: agentJobs.turn,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Le premier tour : l'agent écrit ce qu'il a vu, et range un fait en mémoire. */
const PREMIER_TOUR = {
  text: 'J’ai relu douze fichiers ; le scanner de chemins laisse passer les jonctions.',
  toolCalls: [
    {
      toolCallId: 'sm-1',
      toolName: 'save_memory',
      args: { fact: 'le scanner laisse passer les jonctions', category: 'context' },
    },
  ],
};

describe('un tour qui expire @cap:organiser-equipe/moteur', () => {
  it('est REJOUÉ une fois, et le travail va au bout sans consommer un tour de plus', async () => {
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { timesOut: true },
          {
            text: 'Avis : la jonction doit être résolue avant le test de préfixe.',
            toolCalls: [
              { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        compteur,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('completed');
    // Le livrable est celui du tour rejoué : le travail est allé au bout.
    expect(row.result ?? '').toContain('la jonction doit être résolue');
    // Le rejeu est le MÊME tour : deux tours joués, trois appels au modèle.
    expect(row.turn).toBe(2);
    expect(compteur.appels).toBe(3);
    // Et le premier tour est toujours là, avec ce qu'il avait écrit.
    expect(JSON.stringify(row.messages ?? [])).toContain('douze fichiers');
  });

  it('deux fois de suite, le travail échoue en GARDANT ce que l’agent avait écrit', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([PREMIER_TOUR, { timesOut: true }, { timesOut: true }]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    // Ce que le parent reçoit : l'enregistrement typé est fait de ces
    // deux champs-là (`delegationRecordFromOutcome`), `summary` et
    // `exit_reason`. Le travail des tours précédents y est.
    expect(outcome.exitReason).toBe('timeout');
    expect(outcome.result ?? '').toContain('douze fichiers');

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    // La transcription des tours faits est gardée, comme le livrable partiel.
    expect(JSON.stringify(row.messages ?? [])).toContain('douze fichiers');
    expect(row.result ?? '').toContain('douze fichiers');
  });

  it('dit les FAITS — fournisseur, modèle, tour — et non l’exception recopiée', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([PREMIER_TOUR, { timesOut: true }, { timesOut: true }]),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    const row = await jobRow(jobId);
    const lu = row.result ?? '';
    expect(lu).toContain(`${PROVIDER}/${MODEL}`);
    expect(lu).toContain('turn 2');
    expect(lu).toContain('llm timeout');
    // Ce que l'utilisateur lisait avant (#121) : l'exception, puis l'aveu que
    // personne n'a rien expliqué. Ni l'une ni l'autre ne doit revenir.
    expect(lu).not.toContain('no explanation was provided');
    expect(lu).not.toContain('timed out after 300000ms');
    // Le code machine, lui, garde les mêmes faits pour le diagnostic.
    expect(row.error ?? '').toContain('llm_timeout:');
    expect(row.error ?? '').toContain(`${PROVIDER}/${MODEL}`);
    expect(row.error ?? '').toContain('turn 2');
  });

  it('DERRIÈRE UNE CHAÎNE DE REPLI épuisée, l’expiration est reconnue de la même façon', async () => {
    // Revue C de la PR #172 : avec plusieurs fournisseurs, ce qui remonte est
    // `AllProvidersFailedError`. Sans la lecture de sa cause, le tour n'était
    // pas rejoué et le travail mourait de l'ancienne mort.
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { timesOutViaFailover: true },
          {
            text: 'Avis : la jonction doit être résolue avant le test de préfixe.',
            toolCalls: [
              { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        compteur,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.result ?? '').toContain('la jonction doit être résolue');
    expect(row.turn).toBe(2);
    expect(compteur.appels).toBe(3);
  });

  it('une chaîne épuisée SANS expiration n’est pas rejouée — elle garde son propre code', async () => {
    // La lecture de la cause n'élargit rien d'autre : une chaîne tombée sur
    // autre chose part vers la capture extérieure, qui a son code à elle.
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const client = makeMockLlmClient([PREMIER_TOUR], compteur);
    const vraiGenerate = client.generateText;
    let appel = 0;
    const deps = makeDeps({
      ...client,
      generateText: ((args: Parameters<typeof vraiGenerate>[0]) => {
        appel += 1;
        if (appel === 2) {
          return Promise.reject(
            new AllProvidersFailedError(2, new Error('502 Bad Gateway')),
          ) as ReturnType<typeof vraiGenerate>;
        }
        return vraiGenerate(args);
      }) as typeof vraiGenerate,
    });

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.error ?? '').toBe('all_providers_failed');
    expect(row.error ?? '').not.toContain('llm_timeout');
    // Deux appels : le tour ordinaire, puis celui qui échoue. Aucun rejeu.
    expect(appel).toBe(2);
  });
});

describe('ce que le PARENT reçoit d’un tour expiré @cap:organiser-equipe/moteur', () => {
  it('l’enregistrement typé porte le travail partiel en résumé, et timeout en raison de sortie', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([PREMIER_TOUR, { timesOut: true }, { timesOut: true }]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);
    if (outcome.status !== 'failed') throw new Error('le travail devait échouer');

    // Le VRAI constructeur, sur le VRAI résultat du travail — c'est lui que les
    // deux points de reprise appellent pour remplir le tour de l'outil du parent.
    const record = delegationRecordFromOutcome(outcome);

    expect(record.status).toBe('failed');
    expect(record.summary).toContain('douze fichiers');
    expect(record.summary).toContain('[stopped: llm timeout');
    expect(record.exit_reason).toBe('timeout');
    expect(record.tools_used).toContain('save_memory');
    // Le résumé n'est PAS vide : c'est toute la différence avec l'incident,
    // où le parent ne recevait rien des tours déjà faits.
    expect(record.summary).not.toBe('');
  });
});

describe('lire une expiration sous ses deux formes @cap:organiser-equipe/moteur', () => {
  const expiration = new LLMTimeoutError('openrouter', 'qwen/qwen3.8-max', 300_000);

  it('la reconnaît nue, et au bout d’une chaîne épuisée', () => {
    expect(timeoutOfTurn(expiration)).toBe(expiration);
    expect(timeoutOfTurn(new AllProvidersFailedError(2, expiration))).toBe(expiration);
  });

  it('ne reconnaît rien d’autre', () => {
    expect(timeoutOfTurn(new AllProvidersFailedError(2, new Error('502 Bad Gateway')))).toBeNull();
    expect(timeoutOfTurn(new Error('boom'))).toBeNull();
    expect(timeoutOfTurn(null)).toBeNull();
  });
});

describe('les faits d’un tour expiré, mis en mots @cap:organiser-equipe/moteur', () => {
  const faits = { provider: 'openrouter', model: 'qwen/qwen3.8-max', turn: 13, elapsedMs: 452_000 };

  it('la ligne lue par la personne est une ligne de plateforme, entre crochets', () => {
    expect(timeoutStopLine(faits)).toBe(
      '[stopped: llm timeout — openrouter/qwen/qwen3.8-max, turn 13, 452s]',
    );
  });

  it('le code machine porte les mêmes faits', () => {
    expect(timeoutErrorCode(faits)).toBe('llm_timeout:openrouter/qwen/qwen3.8-max (turn 13, 452s)');
  });
});

describe('un tour coupé EN PLEINE ÉCRITURE est repris, jamais rejoué (#441) @cap:organiser-equipe/moteur', () => {
  const MOITIE = 'Note sur le scanner. Première moitié : les jonctions passent le test de préfixe';
  const SUITE = ', parce que le chemin n’est pas résolu avant la comparaison.';

  it('la seconde requête porte le partiel et la consigne ; le tour garde la note ENTIÈRE', async () => {
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const requetes: unknown[][] = [];
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { cutWhileWriting: MOITIE },
          {
            text: SUITE,
            toolCalls: [
              { toolCallId: 'rr-3', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        compteur,
        requetes,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    expect(compteur.appels).toBe(3);
    // La requête de reprise : le transcript du tour coupé (le même que la
    // requête coupée), PUIS le partiel comme réponse en cours, PUIS la consigne.
    // Rien de plus : pas le transcript deux fois.
    const coupee = requetes[1]!;
    const reprise = requetes[2]!;
    expect(reprise).toHaveLength(coupee.length + 2);
    expect(reprise.slice(0, coupee.length)).toEqual(coupee);
    expect(reprise[coupee.length]).toEqual({ role: 'assistant', content: MOITIE });
    expect(reprise[coupee.length + 1]).toEqual({ role: 'user', content: resumeInstruction() });

    const row = await jobRow(jobId);
    // Le tour repris ne compte pas pour deux.
    expect(row.turn).toBe(2);
    // Le livrable et le transcript portent la note entière, d'un seul tenant,
    // et jamais la consigne de reprise.
    expect(row.result ?? '').toContain(MOITIE + SUITE);
    const transcript = JSON.stringify(row.messages ?? []);
    expect(transcript).toContain(JSON.stringify(MOITIE + SUITE).slice(1, -1));
    expect(transcript).not.toContain(JSON.stringify(resumeInstruction()).slice(1, -1));
  });

  it('coupé puis muet deux fois, le travail échoue en gardant la moitié écrite', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { cutWhileWriting: MOITIE },
        { timesOut: true },
        { timesOut: true },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.exitReason).toBe('timeout');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.result ?? '').toContain(MOITIE);
    expect(row.result ?? '').toContain('[stopped: llm timeout');
    expect(row.result ?? '').toContain('douze fichiers');
  });

  it('l’appel coupé est COMPTÉ : ses jetons estimés entrent dans les totaux du travail', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { cutWhileWriting: MOITIE },
        {
          text: SUITE,
          toolCalls: [
            { toolCallId: 'rr-4', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    const [row] = await db
      .select({ inputTokens: agentJobs.inputTokens, outputTokens: agentJobs.outputTokens })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    // Deux appels servis (5 jetons de sortie chacun, décompte du fournisseur
    // simulé) + l'appel coupé, estimé à caractères / 4.
    expect(row!.outputTokens).toBe(5 + 5 + Math.ceil(MOITIE.length / 4));
    // L'entrée de l'appel coupé est le prompt entier : bien plus que les 2 × 10
    // des deux appels servis.
    expect(row!.inputTokens ?? 0).toBeGreaterThan(20 + 100);
  });

  it('l’estimation de l’appel coupé compte le prompt ET les définitions d’outils envoyés', async () => {
    const jobId = await insertJob();
    const argsBruts: Array<Parameters<RunnerDeps['llmClient']['generateText']>[0]> = [];
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { cutWhileWriting: MOITIE },
          {
            text: SUITE,
            toolCalls: [
              { toolCallId: 'rr-6', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        undefined,
        undefined,
        argsBruts,
      ),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    // Ce que l'appel coupé envoyait VRAIMENT : son système, ses messages, ses outils.
    const coupe = argsBruts[1]! as { system?: unknown; messages?: unknown; tools?: unknown };
    const outils = await estimateToolTokens(coupe.tools);
    expect(outils).toBeGreaterThan(0);
    const attendu =
      estimateContextTokens({ system: coupe.system, messages: coupe.messages }) + outils;
    const [row] = await db
      .select({ inputTokens: agentJobs.inputTokens })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    // Deux appels servis à 10 jetons d'entrée chacun + l'appel coupé, estimé.
    expect(row!.inputTokens).toBe(10 + 10 + attendu);
  });

  it('coupé APRÈS un appel d’outil, le tour est REJOUÉ, pas repris : l’appel n’est pas perdu', async () => {
    const jobId = await insertJob();
    const requetes: unknown[][] = [];
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { cutAfterToolCall: 'Je rends mon avis.' },
          {
            text: 'Je rends mon avis.',
            toolCalls: [
              { toolCallId: 'rr-5', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        undefined,
        requetes,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    // Le rejeu est la MÊME requête que l'appel coupé, sans partiel ni consigne.
    expect(requetes[2]).toEqual(requetes[1]);
    expect(JSON.stringify(requetes[2])).not.toContain(
      JSON.stringify(resumeInstruction()).slice(1, -1),
    );
  });

  it('une reprise qui tombe sur AUTRE CHOSE qu’une expiration garde la moitié écrite', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { cutWhileWriting: MOITIE },
        { failsWith: new Error('upstream exploded') },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(JSON.stringify(row.messages ?? [])).toContain(MOITIE);
  });

  it('un appel coupé qui fait DÉBORDER le budget de jetons n’est pas repris', async () => {
    // PREMIER_TOUR coûte 15 jetons ; l'appel coupé, lui, porte tout le prompt.
    vi.stubEnv('MAX_TOTAL_TOKENS_PER_JOB', '60');
    try {
      const jobId = await insertJob();
      const compteur = { appels: 0 };
      const deps = makeDeps(
        makeMockLlmClient([PREMIER_TOUR, { cutWhileWriting: MOITIE }, { text: SUITE }], compteur),
      );

      const outcome = await executeJob(jobId as JobId, deps, testEnv);

      expect(outcome).toMatchObject({ status: 'failed', error: 'token_budget_exceeded' });
      // Aucune reprise payée au-delà du plafond : deux appels, pas trois.
      expect(compteur.appels).toBe(2);
      const row = await jobRow(jobId);
      expect(row.error).toBe('token_budget_exceeded');
      expect(JSON.stringify(row.messages ?? [])).toContain(MOITIE);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('un Stop qui tombe juste avant l’expiration l’emporte, même si le budget déborde', async () => {
    vi.stubEnv('MAX_TOTAL_TOKENS_PER_JOB', '60');
    try {
      const jobId = await insertJob();
      const deps = makeDeps(
        makeMockLlmClient([PREMIER_TOUR, { cancelThenCut: { jobId, partial: MOITIE } }]),
      );

      const outcome = await executeJob(jobId as JobId, deps, testEnv);

      expect(outcome.status).toBe('cancelled');
      const row = await jobRow(jobId);
      expect(row.status).toBe('cancelled');
      expect(row.error ?? '').toBe('');
      expect(JSON.stringify(row.messages ?? [])).toContain(MOITIE);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('une annulation pendant un appel coupé garde le texte qu’il avait écrit', async () => {
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const deps = makeDeps(
      makeMockLlmClient(
        [PREMIER_TOUR, { cancelThenCut: { jobId, partial: MOITIE } }, { text: SUITE }],
        compteur,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('cancelled');
    expect(compteur.appels).toBe(2);
    const row = await jobRow(jobId);
    expect(row.status).toBe('cancelled');
    expect(JSON.stringify(row.messages ?? [])).toContain(MOITIE);
  });

  it('coupé après un appel d’outil SANS texte, l’appel est compté et rejoué, pas pris pour muet', async () => {
    const jobId = await insertJob();
    const requetes: unknown[][] = [];
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { cutAfterToolCall: '' },
          {
            toolCalls: [
              { toolCallId: 'rr-10', toolName: 'return_result', args: { status: 'success' } },
            ],
          },
        ],
        undefined,
        requetes,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    expect(requetes[2]).toEqual(requetes[1]);
    const [row] = await db
      .select({ inputTokens: agentJobs.inputTokens })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    // Deux appels servis à 10 + l'appel coupé, servi lui aussi : estimé, donc bien plus.
    expect(row!.inputTokens ?? 0).toBeGreaterThan(20 + 100);
  });

  it('un tour repris qu’un plafond arrête garde son texte ENTIER', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { cutWhileWriting: MOITIE },
        // La suite arrive, mais son décompte fait déborder le plafond de jetons.
        { text: SUITE, usageIn: 2_000_000 },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome).toMatchObject({ status: 'failed', error: 'token_budget_exceeded' });
    const row = await jobRow(jobId);
    expect(JSON.stringify(row.messages ?? [])).toContain(
      JSON.stringify(MOITIE + SUITE).slice(1, -1),
    );
  });

  it('la sortie estimée d’un appel coupé compte le raisonnement, pas seulement le texte', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { cutThinking: { partial: 'Bref.', generated: 40_000 } },
        {
          text: ' Suite.',
          toolCalls: [
            { toolCallId: 'rr-11', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    const [row] = await db
      .select({ outputTokens: agentJobs.outputTokens })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    // 5 + 5 servis, + 40 000 caractères générés / 4 — pas les 5 caractères visibles.
    expect(row!.outputTokens).toBe(5 + 5 + 10_000);
  });

  it('les reprises ont un budget : la quatrième coupure termine le travail', async () => {
    const jobId = await insertJob();
    const compteur = { appels: 0 };
    const deps = makeDeps(
      makeMockLlmClient(
        [
          PREMIER_TOUR,
          { cutWhileWriting: 'a' },
          { cutWhileWriting: 'b' },
          { cutWhileWriting: 'c' },
          { cutWhileWriting: 'd' },
          { text: 'jamais demandé' },
        ],
        compteur,
      ),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    // Un tour, puis la coupure et ses trois reprises : cinq appels, pas six.
    expect(compteur.appels).toBe(5);
    const row = await jobRow(jobId);
    expect(row.result ?? '').toContain('abcd');
  });
});

describe('Stop arrête le travail PENDANT l’appel au modèle @cap:organiser-equipe/moteur', () => {
  it('un tour qui écrit sans fin s’arrête dès le Stop, avec ce qu’il avait écrit', async () => {
    const jobId = await insertJob();
    const debut = Date.now();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { stoppedWhileWriting: { jobId, partial: 'Le début de la note' } },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('cancelled');
    // Stop à 1 s, lu au plus une période plus tard : bien avant la fin d'un appel.
    expect(Date.now() - debut).toBeLessThan(1_000 + STOP_POLL_MS + 3_000);
    const row = await jobRow(jobId);
    expect(row.status).toBe('cancelled');
    expect(JSON.stringify(row.messages ?? [])).toContain('Le début de la note');
    // L'appel arrêté était servi : il est compté (4 000 caractères générés / 4).
    const [compte] = await db
      .select({ outputTokens: agentJobs.outputTokens, inputTokens: agentJobs.inputTokens })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(compte!.outputTokens).toBe(5 + 1_000);
    expect(compte!.inputTokens ?? 0).toBeGreaterThan(10 + 100);
  }, 20_000);

  it('un Stop suivi d’un débordement de budget rend « annulé », pas « échoué »', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        { stoppedThenAnswers: { jobId }, text: 'Je termine.', usageIn: 2_000_000 },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('cancelled');
  });

  it('une réponse qui revient APRÈS le Stop n’exécute aucun de ses outils', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        PREMIER_TOUR,
        {
          stoppedThenAnswers: { jobId },
          text: 'Je termine.',
          toolCalls: [
            { toolCallId: 'rr-9', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    // return_result exécuté aurait terminé le travail : il ne l'est pas.
    expect(outcome.status).toBe('cancelled');
    const row = await jobRow(jobId);
    expect(row.status).toBe('cancelled');
    expect(JSON.stringify(row.messages ?? [])).toContain('Je termine.');
    expect(JSON.stringify(row.messages ?? [])).not.toContain('rr-9');
  });
});
