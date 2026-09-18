// llm-timeout-turn.test.ts — un tour qui expire ne jette pas le travail fait
// (issue #121).
//
// L'incident : Reviewer A avait travaillé douze tours (vingt lectures de
// fichiers) quand le treizième a expiré. Le job est passé `failed`, son
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
import { createEmbeddingClient, LLMTimeoutError } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob, timeoutErrorCode, timeoutStopLine } from '../../job/execute.ts';

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

/** Un tour du modèle simulé, ou une expiration à la place de la réponse. */
type MockTurn =
  | { timesOut: true }
  | {
      timesOut?: false;
      text?: string;
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
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
): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = (responses[callIndex] ?? responses[responses.length - 1]!) as Exclude<
        MockTurn,
        { timesOut: true }
      >;
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
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
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
    generateText: (args) => {
      if (compteur) compteur.appels += 1;
      const prevu = responses[callIndex];
      if (prevu && 'timesOut' in prevu && prevu.timesOut) {
        callIndex++;
        return Promise.reject(new LLMTimeoutError(PROVIDER, MODEL, 300_000)) as ReturnType<
          RunnerDeps['llmClient']['generateText']
        >;
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
