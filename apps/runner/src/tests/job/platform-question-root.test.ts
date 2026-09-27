// platform-question-root.test.ts — what a root that is asked about Nodal
// actually receives, on the real runner path (#455, Codex review pass 2, P2).
//
// Run 6f08b1b8: asked for "the changelog of 0.9.2", the root delegated to a
// Researcher. The rule "a question about Nodal is yours" is agent-layer text
// (invariant #3): the runner does not refuse the delegation, it TELLS the
// model. So what is proven here is what the model is told, read in the body of
// the real LLM request: the rule in the system prompt, `nodal_docs` among its
// tools, and the delegation tool carrying the scope rule. A scripted model
// that delegates anyway still delegates — the harness does not second-guess
// it, and this test says so rather than pretending otherwise.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, agentAssignments } from '@nodal-agents/db';
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
      if (!active) throw new Error('platform-question-root.test: no active LLM client');
      return active;
    },
  };
});

interface Captured {
  system: string;
  tools: Array<{ name: string; description?: string }>;
}

function scriptedClient(
  calls: Array<Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>>,
  captured: Captured[],
): RunnerDeps['llmClient'] {
  let i = 0;
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
      const step = calls[i] ?? calls[calls.length - 1]!;
      i++;
      return {
        content: step.map((c) => ({
          type: 'tool-call' as const,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: JSON.stringify(c.args),
        })),
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
let researcherSlug: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Researcher',
      slug: `researcher-${Date.now()}`,
      personality: 'I research things on the web.',
      llmKeyId: seed.llmKeyId,
      role: 'agent',
      systemAgent: true,
    })
    .returning();
  researcherSlug = child!.slug;
  await db
    .insert(agentAssignments)
    .values({ orchestratorId: seed.agentId, subAgentId: child!.id, entityId: seed.entityId });
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

describe('a root asked "what changed in 0.9.2" is told the question is its own (#455) @cap:consulter-l-aide/moteur', () => {
  it('the real LLM request carries the rule, nodal_docs, and the delegation scope rule', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'what changed in 0.9.2?',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    const captured: Captured[] = [];
    // The model does what the rule tells it not to: it delegates the question.
    const client = scriptedClient(
      [
        [
          {
            toolCallId: 'tc-assign',
            toolName: `assign_${researcherSlug.replace(/-/g, '_')}`,
            args: { task: 'find the changelog of 0.9.2' },
          },
        ],
        [{ toolCallId: 'tc-rr-child', toolName: 'return_result', args: { status: 'success' } }],
        [{ toolCallId: 'tc-rr-root', toolName: 'return_result', args: { status: 'success' } }],
      ],
      captured,
    );

    await executeJob(job!.id as JobId, makeDeps(client), testEnv);

    const rootCall = captured[0]!;
    expect(rootCall.system).toContain('### A question about Nodal is yours');
    expect(rootCall.system).toContain('never delegate it to a teammate');
    expect(rootCall.tools.map((t) => t.name)).toContain('nodal_docs');
    const assign = rootCall.tools.find((t) => t.name.startsWith('assign_'));
    expect(assign?.description).toContain('Never widen the folders a teammate reads or writes');

    // Agent layer, not a runtime gate: the delegation the model chose happened.
    const [child] = await db
      .select({ task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, job!.id));
    expect(child?.task).toContain('changelog of 0.9.2');
  });
});
