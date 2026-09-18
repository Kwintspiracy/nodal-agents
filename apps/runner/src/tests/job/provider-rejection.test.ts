// provider-rejection.test.ts — un fournisseur qui REFUSE la requête le dit en
// clair (issue #119).
//
// L'incident du 16/09/2026 : un agent sur un modèle Gemini via OpenRouter
// (fournisseur amont Google AI Studio) meurt au tour 1 sur « 400 Request
// contains an invalid argument », sans un outil exécuté. Ce que la personne
// recevait : le JSON du fournisseur recopié tel quel, suivi de « and no
// explanation was provided ». Rien n'y disait qui avait refusé, ni quoi faire.
//
// Ce qui se prouve ici, sur le VRAI chemin (executeJob, base de test réelle,
// modèle simulé) : le job échoue avec un code typé, et son résultat est une
// ligne de plateforme qui nomme le fournisseur, le modèle, le statut, le tour,
// et le seul geste possible.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { renderDelegationOutcome } from '@nodal-agents/orchestration';
import {
  delegationRecordFromOutcome,
  executeJob,
  providerRejectionCode,
  providerRejectionOfTurn,
  providerRejectionStopLine,
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
      if (!active) throw new Error('provider-rejection.test: no active LLM client set');
      return active;
    },
  };
});

const PROVIDER = 'openrouter';
const MODEL = 'google/gemini-3.7-flash';

/** Le corps EXACT relevé dans `llm_calls` le 16/09 (job 452b8aa3). */
const REJECTION_BODY = JSON.stringify({
  error: {
    code: 400,
    message: 'Request contains an invalid argument.',
    status: 'INVALID_ARGUMENT',
    metadata: { provider_name: 'Google AI Studio' },
  },
});

/**
 * L'erreur telle que le SDK la lève : un `APICallError` porte `statusCode` et
 * `responseBody`. C'est ce que `describeLlmError` recopiait dans le résultat.
 */
function apiCallError(status: number, message: string): Error {
  const err = new Error(`AI_APICallError: ${message}`) as Error & {
    statusCode: number;
    responseBody: string;
  };
  err.name = 'AI_APICallError';
  err.statusCode = status;
  err.responseBody = REJECTION_BODY;
  return err;
}

type MockTurn = {
  rejectsWith?: Error;
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

function makeMockLlmClient(responses: MockTurn[]): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
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
      const prevu = responses[callIndex];
      if (prevu?.rejectsWith) {
        callIndex++;
        return Promise.reject(prevu.rejectsWith) as ReturnType<
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
      task: 'Relis la PR et rends ton avis',
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
      toolsUsed: agentJobs.toolsUsed,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

describe('un fournisseur qui refuse la requête @cap:choisir-modele/moteur', () => {
  it('le job échoue au tour 1 avec un code qui nomme le fournisseur et le statut', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        { rejectsWith: apiCallError(400, 'Request contains an invalid argument.') },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(`provider_rejected_request:${PROVIDER}/${MODEL} (http 400, turn 1)`);
    expect(row.toolsUsed ?? []).toEqual([]);
  });

  it('ce que la personne lit nomme les FAITS, jamais le JSON ni un conseil du harnais', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        { rejectsWith: apiCallError(400, 'Request contains an invalid argument.') },
      ]),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    const result = (await jobRow(jobId)).result ?? '';
    expect(result).toContain(PROVIDER);
    expect(result).toContain(MODEL);
    expect(result).toContain('http 400');
    expect(result).toContain('turn 1');
    // Et ce que le harnais ne dit PAS : le conseil, qui serait une phrase de sa
    // main (invariant #2). Il voyage en champ typé, prouvé juste en dessous.
    expect(result.toLowerCase()).not.toContain('try another model');
    // Ce qui est parti : le corps du fournisseur et la phrase creuse.
    expect(result).not.toContain('INVALID_ARGUMENT');
    expect(result).not.toContain('no explanation was provided');
  });

  it('ce que l’agent avait écrit avant le refus reste le livrable', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        {
          text: 'J’ai lu trois fichiers ; le premier constat tient.',
          toolCalls: [
            {
              toolCallId: 'sm-1',
              toolName: 'save_memory',
              args: { fact: 'le premier constat tient', category: 'context' },
            },
          ],
        },
        { rejectsWith: apiCallError(400, 'Request contains an invalid argument.') },
      ]),
    );

    await executeJob(jobId as JobId, deps, testEnv);

    const result = (await jobRow(jobId)).result ?? '';
    expect(result).toContain('trois fichiers');
    expect(result).toContain('[stopped: provider rejected the request');
  });

  it('le geste à faire est un CHAMP typé, porté jusqu’au parent', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(
      makeMockLlmClient([
        { rejectsWith: apiCallError(400, 'Request contains an invalid argument.') },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.hint).toBe('switch_model');
    expect(outcome.exitReason).toBe('provider_rejected_request');

    // Le record TYPÉ que le parent reçoit le porte aussi : sans lui, un parent
    // relaierait l'échec sans savoir qu'un autre modèle le réglerait.
    const record = delegationRecordFromOutcome(outcome);
    expect(record.hint).toBe('switch_model');
    expect(record.exit_reason).toBe('provider_rejected_request');
    expect(JSON.parse(renderDelegationOutcome(record))['hint']).toBe('switch_model');
  });

  it('une délégation ordinaire ne porte aucun geste', () => {
    const record = delegationRecordFromOutcome({
      status: 'completed',
      result: 'Longueur de Planck : 1.616255e-35 m.',
      toolsUsed: ['tavily_search'],
    });
    expect(record.hint ?? null).toBeNull();
    expect(JSON.parse(renderDelegationOutcome(record))['hint']).toBeNull();
  });

  it('une panne du fournisseur (500) n’est PAS un refus et garde son chemin', async () => {
    const jobId = await insertJob();
    const deps = makeDeps(makeMockLlmClient([{ rejectsWith: apiCallError(500, 'Bad gateway') }]));

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.error ?? '').not.toContain('provider_rejected_request');
  });
});

describe('lire un refus de requête @cap:choisir-modele/moteur', () => {
  it('le reconnaît sur l’erreur et sur sa cause', () => {
    expect(providerRejectionOfTurn(apiCallError(400, 'x'))).toBe(400);
    expect(providerRejectionOfTurn(apiCallError(422, 'x'))).toBe(422);
    const enveloppe = new Error('wrapped') as Error & { cause: unknown };
    enveloppe.cause = apiCallError(400, 'x');
    expect(providerRejectionOfTurn(enveloppe)).toBe(400);
  });

  it('ne reconnaît rien d’autre', () => {
    expect(providerRejectionOfTurn(apiCallError(500, 'x'))).toBeNull();
    expect(providerRejectionOfTurn(apiCallError(429, 'x'))).toBeNull();
    expect(providerRejectionOfTurn(apiCallError(401, 'x'))).toBeNull();
    expect(providerRejectionOfTurn(new Error('réseau'))).toBeNull();
    expect(providerRejectionOfTurn(null)).toBeNull();
  });

  it('un statut de panne au-dessus d’un 400 plus bas reste une panne', () => {
    // Sans cette règle, une panne 500 dont la cause porte un 400 passerait pour
    // un refus de requête, et le conseil serait faux.
    const panne = new Error('upstream') as Error & { statusCode: number; cause: unknown };
    panne.statusCode = 500;
    panne.cause = apiCallError(400, 'x');
    expect(providerRejectionOfTurn(panne)).toBeNull();
  });
});

describe('les faits d’un refus, mis en mots @cap:choisir-modele/moteur', () => {
  const faits = { provider: PROVIDER, model: MODEL, status: 400, turn: 1 };

  it('la ligne lue par la personne est une ligne de plateforme, entre crochets', () => {
    expect(providerRejectionStopLine(faits)).toBe(
      `[stopped: provider rejected the request — ${PROVIDER}/${MODEL}, http 400, turn 1]`,
    );
  });

  it('la ligne ne porte AUCUNE phrase de conseil', () => {
    // Le harnais pose des faits ; le geste est un champ, pas une phrase.
    const ligne = providerRejectionStopLine(faits);
    expect(ligne.toLowerCase()).not.toContain('try');
    expect(ligne.toLowerCase()).not.toContain('another model');
  });

  it('le code machine porte les mêmes faits', () => {
    expect(providerRejectionCode(faits)).toBe(
      `provider_rejected_request:${PROVIDER}/${MODEL} (http 400, turn 1)`,
    );
  });
});
