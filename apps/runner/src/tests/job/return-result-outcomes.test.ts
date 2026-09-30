// return-result-outcomes.test.ts — ce que le modèle lit quand il choisit
// l'issue d'un job : un résultat qui attend la décision d'une personne est
// LIVRÉ, pas bloqué.
//
// Le banc, sur l'intégration du lot 2 de la 0.9.5 (jobs VERT 015c478a,
// ROUGES fe14218d et 3031b319, même modèle, même sortie d'outil) : « Imprime ce
// court texte » ; Alfred crée la demande d'impression, que l'outil laisse EN
// ATTENTE d'un clic humain par conception ({status:"pending",
// approval:{required:true}}), puis rend `return_result {status:"blocked"}`, et
// le runner finalise en échec. Le socle venait de perdre les deux seules
// phrases qui présentaient « attendre une personne » comme une issue normale.
//
// Le choix du statut appartient au modèle (invariant #3 : la couche agent, pas
// le runtime). Un modèle simulé choisit ce qu'on lui dicte : un job exécuté ne
// prouve donc pas le choix. Ce qui se prouve, c'est ce qu'on lui DIT, lu dans
// le corps de la vraie requête LLM : la définition des deux issues dans la
// description de `return_result`, là où il les choisit, et la demi-phrase
// symétrique du socle. La vraie preuve du comportement est le banc `print`.
//
// Deux rôles (racine qui délègue, agent délégué) : la définition vaut pour tout
// job, pas pour l'impression ni pour Alfred.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

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
      if (!active) throw new Error('return-result-outcomes.test: no active LLM client');
      return active;
    },
  };
});

interface Captured {
  system: string;
  tools: Array<{ name: string; description?: string }>;
}

/** Un modèle qui rend succès au premier tour, et garde ce qu'on lui a envoyé. */
function capturingClient(captured: Captured[]): RunnerDeps['llmClient'] {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{ role: string; content: unknown }>;
      captured.push({
        system: prompt
          .filter((m) => m.role === 'system')
          .map((m) => String(m.content))
          .join('\n'),
        tools: ((options.tools ?? []) as Array<{ name: string; description?: string }>).map(
          (t) => ({ name: t.name, description: t.description }),
        ),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Done.',
          },
          {
            type: 'tool-call' as const,
            toolCallId: `tc-rr-${captured.length}`,
            toolName: 'return_result',
            input: JSON.stringify({ status: 'success' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
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
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
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

/** Les phrases qui définissent les deux issues, dans la description envoyée. */
const OUTCOME_DEFINITION = [
  'status="success" means you did everything that was yours to do',
  "A result that waits, by the tool's design, on a person's decision",
  'is DELIVERED, not blocked',
  'say what waits, who decides and where',
  'status="blocked" means YOUR part could not be done',
];

/** La demi-phrase symétrique du socle (verify-before-done). */
const BASELINE_HALF =
  "a result that waits on a person's decision by design is delivered, not blocked";

describe('return_result tells the model that waiting on a person is delivered, not blocked @cap:approuver-une-action/moteur', () => {
  for (const role of ['orchestrator', 'agent'] as const) {
    it(`${role}: the real LLM request carries both outcomes in return_result and the baseline half-sentence`, async () => {
      await db.update(agents).set({ role }).where(eq(agents.id, seed.agentId));
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'api',
          task: 'Print this short text',
          status: 'pending',
          messages: [],
          chainCount: 0,
        })
        .returning();
      const captured: Captured[] = [];

      await executeJob(job!.id as JobId, makeDeps(capturingClient(captured)), testEnv);

      const first = captured[0];
      expect(first, 'the model was never called').toBeDefined();
      const rr = first!.tools.find((t) => t.name === 'return_result');
      expect(rr, 'return_result is not among the tools sent').toBeDefined();
      const missing = OUTCOME_DEFINITION.filter((p) => !rr!.description?.includes(p));
      expect(missing, 'phrases missing from the return_result description sent').toEqual([]);
      expect(first!.system).toContain(BASELINE_HALF);
    });
  }
});
