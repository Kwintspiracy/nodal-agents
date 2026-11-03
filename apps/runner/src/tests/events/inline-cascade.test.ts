// inline-cascade.test.ts — un délégué annulé pendant que son parent l'attend
// EN LIGNE (#944, revue Reviewer A de #956, passe 2).
//
// Le parent appelle `assign_*` ; le délégué tourne dans la même pile
// (`executeJob(..., { inlineDelegation: true })`). La personne arrête le délégué
// seul : il finit `cancelled`, et le parent, qui n'avait plus rien d'autre à
// faire, est annulé en cascade. Avant la passe 2, cette cascade passait par
// `setJobStatus(..., 'cancelled')` : le parent finissait sans qu'aucun
// `job.finished` ne parte, et le flux le montrait en cours pour toujours.
//
// Ce qui se prouve, sur le vrai runner, la vraie base et le vrai bus (seul le
// modèle est simulé) : le parent est `cancelled` en base, et le flux de son
// espace porte UN `job.finished` pour lui — un, pas zéro, pas deux.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents, agentAssignments } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { createApp } from '../../server.ts';
import { executeJob } from '../../job/execute.ts';
import { jobEvents, type StoredJobEvent } from '../../events/job-events.ts';

vi.setConfig({ testTimeout: 30_000 });

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => void (active = c),
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('inline-cascade.test: no active LLM client set');
      return active;
    },
  };
});

interface MockTurn {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  /** Joué AVANT que le tour réponde : ce qui se passe pendant que le modèle pense. */
  before?: () => Promise<void>;
}

function makeMockLlmClient(responses: MockTurn[]): RunnerDeps['llmClient'] {
  let i = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      if (r.before) await r.before();
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
  PORT: 1,
  BIND: '127.0.0.1',
  APP_URL: 'http://127.0.0.1:1',
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
let assignTool: string;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true } as never)
    .where(eq(agents.id, seed.agentId));
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'specialiste',
      slug: `specialiste-${Date.now()}`,
      personality: 'You are the specialist.',
      llmKeyId: seed.llmKeyId,
      active: true,
      role: 'agent',
    } as never)
    .returning({ id: agents.id, slug: agents.slug });
  assignTool = `assign_${child!.slug.replace(/-/g, '_')}`;
  await db.insert(agentAssignments).values({
    orchestratorId: seed.agentId,
    subAgentId: child!.id,
    entityId: seed.entityId,
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

describe('un délégué en ligne annulé fait annuler son parent : UN job.finished pour le parent (#944) @cap:suivre-execution/moteur', () => {
  it('le parent est `cancelled` en base, et le flux le dit une fois', async () => {
    const [parent] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        task: 'Fais faire la recherche au spécialiste',
        channel: 'api',
        status: 'pending',
        messages: [],
        chainCount: 0,
      } as never)
      .returning({ id: agentJobs.id });
    const parentId = parent!.id;

    const deps = makeDeps(
      makeMockLlmClient([
        // Le parent délègue.
        {
          toolCalls: [
            {
              toolCallId: 'tc-assign-1',
              toolName: assignTool,
              args: { task: 'Cherche la longueur de Planck' },
            },
          ],
        },
        // Le délégué pense… et la personne l'arrête, LUI seul (le bouton Stop
        // sur sa ligne : l'arbre du délégué, pas celui du parent).
        {
          before: async () => {
            await db
              .update(agentJobs)
              .set({ status: 'cancelled', updatedAt: new Date() })
              .where(eq(agentJobs.parentJobId, parentId));
          },
          text: 'Je cherche.',
        },
      ]),
    );
    // L'écouteur des transitions de ce processus, comme au démarrage du runner.
    createApp(deps, testEnv);
    const received: StoredJobEvent[] = [];
    const sub = jobEvents.open(seed.entityId, null, null, (e) => received.push(e));

    try {
      const outcome = await executeJob(parentId as JobId, deps, testEnv);
      expect(outcome.status).toBe('cancelled');

      const [row] = await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, parentId));
      expect(row?.status).toBe('cancelled');

      const ofParent = received.filter((e) => 'jobId' in e.payload && e.payload.jobId === parentId);
      expect(ofParent.map((e) => e.payload)).toEqual([
        expect.objectContaining({
          type: 'job.finished',
          jobId: parentId,
          status: 'cancelled',
          parentJobId: null,
        }),
      ]);
    } finally {
      sub.close();
    }
  });
});
