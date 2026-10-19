// cron/tests/task-deliverable.test.ts — une tâche du tableau recopie ce que son
// job a LIVRÉ, verdicts compris (issue #646).
//
// Le résultat d'une tâche est ce que lisent la compilation du root
// (`deliverCompletedRoots`), le contexte des tâches qui en dépendent et la
// mémoire du run. Il était recopié du seul texte du job : une tâche dont le job
// n'avait livré qu'un verdict devenait « (no result) » pour les trois. Les deux
// écritures — `markTaskFromResult` à la fin du job, le faucheur
// `resetOrphanedTasks` en filet — passent maintenant par le lecteur unique.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agentTasks, agents, toolCalls } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import { executeReadyTasks } from '../execute-ready.ts';
import { deliverCompletedRoots } from '../deliver-results.ts';
import { resetOrphanedTasks } from '../reset-orphans.ts';

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
      if (!active) throw new Error('task-deliverable.test: no active LLM client');
      return active;
    },
  };
});

/** La sortie EXACTE que `review_verdict` écrit dans `tool_calls` quand il a validé. */
const VERDICT = {
  ok: true,
  verdict: 'approve',
  summary: 'Relu le diff du lot, la suite du paquet passe.',
  findings: [
    {
      file: 'apps/runner/src/cron/execute-ready.ts',
      line: 12,
      issue: 'Import à trier.',
      severity: 'minor',
    },
  ],
  counts: { blocker: 0, major: 0, minor: 1 },
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let reviewerSlug: string;
let reviewerId: string;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
  const [reviewer] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Reviewer',
      slug: `reviewer-${Date.now().toString(36)}`,
      personality: 'p',
      role: 'agent',
      systemAgent: true,
      llmKeyId: (
        await db
          .select({ llmKeyId: agents.llmKeyId })
          .from(agents)
          .where(eq(agents.id, seed.agentId))
      )[0]!.llmKeyId,
    })
    .returning();
  reviewerSlug = reviewer!.slug;
  reviewerId = reviewer!.id;
});

/**
 * Un modèle dont le seul tour est celui d'un relecteur qui a déjà enregistré son
 * verdict : `return_result`, sans un mot. La ligne `review_verdict` est écrite
 * pour le job de la tâche au moment où le modèle est appelé — le job n'existe pas
 * avant, c'est `executeReadyTasks` qui le fait naître.
 */
function reviewerTurn(taskId: string): RunnerDeps['llmClient'] {
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const [task] = await db
        .select({ jobId: agentTasks.jobId })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId));
      await db.insert(toolCalls).values({
        entityId: seed.entityId,
        jobId: task!.jobId!,
        toolName: 'review_verdict',
        toolInput: {},
        toolOutput: JSON.stringify(VERDICT),
        turn: 1,
      } as never);
      return {
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'rr-1',
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
  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
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
  return client;
}

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

function verdictBlock(jobId: string): string {
  return [
    `[review_verdict] verdict: approve · author: ${reviewerSlug} · job: ${jobId}`,
    'summary: Relu le diff du lot, la suite du paquet passe.',
    'findings:',
    '- minor · apps/runner/src/cron/execute-ready.ts:12 · Import à trier.',
  ].join('\n');
}

describe('une tâche recopie ce que son job a livré (#646) @cap:organiser-equipe/moteur', () => {
  it('le job n’a livré qu’un verdict : la tâche le porte, et la compilation du root aussi', async () => {
    const [root] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'fais relire le lot',
        status: 'processing',
        messages: [],
      })
      .returning();
    const [task] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: reviewerId,
        title: 'Relire le lot',
        status: 'todo',
        dependsOn: [] as unknown as string[],
        rootJobId: root!.id,
      })
      .returning();

    await executeReadyTasks(db as RunnerDeps['db'], makeDeps(reviewerTurn(task!.id)), 5);

    const [done] = await db
      .select({ status: agentTasks.status, result: agentTasks.result, jobId: agentTasks.jobId })
      .from(agentTasks)
      .where(eq(agentTasks.id, task!.id));
    expect(done?.status).toBe('done');
    // Le job a fini sans un mot : son texte est vide, son livrable est le verdict.
    const [jobRow] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, done!.jobId!));
    expect(jobRow?.status).toBe('completed');
    expect((jobRow?.result ?? '').trim()).toBe('');
    expect(done?.result).toBe(verdictBlock(done!.jobId!));

    await deliverCompletedRoots(db as RunnerDeps['db']);

    const [rootRow] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, root!.id));
    expect(rootRow?.status).toBe('completed');
    expect(rootRow?.result).toBe(`## Relire le lot\n${verdictBlock(done!.jobId!)}`);
    expect(rootRow?.result).not.toContain('(no result)');
  });

  it('le faucheur qui finalise une tâche oubliée recopie le même livrable', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: reviewerId,
        channel: 'task-board',
        task: 'relis',
        status: 'completed',
        result: null,
        messages: [],
      })
      .returning();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: job!.id,
      toolName: 'review_verdict',
      toolInput: {},
      toolOutput: JSON.stringify(VERDICT),
      turn: 1,
    } as never);
    const [task] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: reviewerId,
        title: 'Relire',
        status: 'in_progress',
        dependsOn: [] as unknown as string[],
        jobId: job!.id,
      })
      .returning();

    await resetOrphanedTasks(db as RunnerDeps['db']);

    const [row] = await db
      .select({ status: agentTasks.status, result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task!.id));
    expect(row?.status).toBe('done');
    expect(row?.result).toBe(verdictBlock(job!.id));
  });

  it('une tâche dont le job n’est pas une revue recopie son texte tel quel', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'task-board',
        task: 'cherche',
        status: 'completed',
        result: '  Longueur de Planck : 1.616255e-35 m.\n',
        messages: [],
      })
      .returning();
    const [task] = await db
      .insert(agentTasks)
      .values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        title: 'Chercher',
        status: 'in_progress',
        dependsOn: [] as unknown as string[],
        jobId: job!.id,
      })
      .returning();

    await resetOrphanedTasks(db as RunnerDeps['db']);

    const [row] = await db
      .select({ result: agentTasks.result })
      .from(agentTasks)
      .where(eq(agentTasks.id, task!.id));
    expect(row?.result).toBe('  Longueur de Planck : 1.616255e-35 m.\n');
  });
});
