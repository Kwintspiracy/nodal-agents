// root-meta-tools.test.ts — regression for the ROOT meta-tool gating bug.
//
// The bug: meta-tool gating was originally placed inside the WORKER `else`
// branch of execute.ts. But a ROOT is ALWAYS an orchestrator (the web action
// enforces role='orchestrator'), so the real ROOT hits the `if (isOrchestrator)`
// branch — which never included the meta-tools. The feature was dead for the
// real ROOT.
//
// The fix hoists the gating ABOVE the isOrchestrator split: metaToolNames +
// metaToolDefs are computed once; the orchestrator branch spreads
// `...metaToolDefs` into its router/planner toolDefs arrays; the worker branch
// keeps using metaToolNames in alwaysOn.
//
// This test FAILS if `...metaToolDefs` is removed from the orchestrator branch.
// It asserts on the REAL toolset handed to the model (the `tools` argument the
// runner passes to llmClient.generateText) — not call counts.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, entities } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// Intercept createLlmClient called by execute.ts so it returns the per-test mock.
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active)
        throw new Error('root-meta-tools.test: no active LLM client — call setActiveLlmClient()');
      return active;
    },
  };
});

// ─── Mock LLM that records the tool names it was handed each turn ──────────────

interface CapturingClient {
  client: RunnerDeps['llmClient'];
  /** The keys of the `tools` object passed to generateText, per call. */
  toolKeysPerCall: string[][];
}

/**
 * Builds a mock LLM client that:
 *   - records the names of the tools it received in each generateText call
 *   - replays the provided scripted responses (tool calls / text)
 */
function makeCapturingLlmClient(
  responses: Array<{
    text?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  }>,
): CapturingClient {
  const toolKeysPerCall: string[][] = [];
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
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: JSON.stringify(tc.args),
          });
        }
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

  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      // Capture the tool names the runner handed to the model this turn.
      const tools = (args as { tools?: Record<string, unknown> }).tools ?? {};
      toolKeysPerCall.push(Object.keys(tools));
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

  return { client, toolKeysPerCall };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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
  NODALAI_APPROVAL_GRACE_MS: 0,
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Turn the seeded agent into a ROUTER orchestrator — the role the real ROOT has.
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router' })
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

async function createJob() {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Root agent task',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create job');
  return job;
}

/** A single scripted turn: orchestrator immediately calls return_result. */
function returnResultScript() {
  return [
    {
      toolCalls: [{ toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } }],
    },
  ];
}

const META_TOOL_NAMES = ['create_skill', 'attach_skill', 'create_agent'];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ROOT meta-tool gating — orchestrator branch (regression)', () => {
  it('designated ROOT orchestrator receives create_skill/attach_skill/create_agent in its toolset', async () => {
    // Designate the orchestrator agent as ROOT with all grants ON.
    await db
      .update(entities)
      .set({
        rootAgentId: seed.agentId,
        rootGrants: {
          createAgent: true,
          createSkill: true,
          assignSkill: true,
          autonomy: 'fully_autonomous',
        },
      })
      .where(eq(entities.id, seed.entityId));

    const job = await createJob();
    const { client, toolKeysPerCall } = makeCapturingLlmClient(returnResultScript());

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // The model must have been handed the meta-tools on its first (only) turn.
    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const firstTurnTools = new Set(toolKeysPerCall[0]);
    for (const name of META_TOOL_NAMES) {
      expect(firstTurnTools.has(name), `ROOT orchestrator toolset should include ${name}`).toBe(
        true,
      );
    }
  });

  it('non-ROOT orchestrator (rootAgentId points elsewhere) does NOT receive meta-tools', async () => {
    // Point rootAgentId at a DIFFERENT (nonexistent-here) agent — this agent is
    // not the ROOT, so it must get no meta-tools even though it is an orchestrator.
    // Create a second orchestrator agent to act as the real ROOT.
    const [otherRoot] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Other Root',
        slug: `other-root-${Date.now()}`,
        personality: 'I am the real root.',
        llmKeyId: seed.llmKeyId,
        role: 'orchestrator',
        orchestratorMode: 'router',
      })
      .returning();
    if (!otherRoot) throw new Error('Failed to create other root agent');

    await db
      .update(entities)
      .set({
        rootAgentId: otherRoot.id,
        rootGrants: {
          createAgent: true,
          createSkill: true,
          assignSkill: true,
          autonomy: 'fully_autonomous',
        },
      })
      .where(eq(entities.id, seed.entityId));

    // The job runs the ORIGINAL seeded orchestrator (not the root).
    const job = await createJob();
    const { client, toolKeysPerCall } = makeCapturingLlmClient(returnResultScript());

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const firstTurnTools = new Set(toolKeysPerCall[0]);
    for (const name of META_TOOL_NAMES) {
      expect(
        firstTurnTools.has(name),
        `non-ROOT orchestrator toolset must NOT include ${name}`,
      ).toBe(false);
    }
  });

  it('ROOT orchestrator with createAgent grant OFF gets create_skill+attach_skill but NOT create_agent', async () => {
    await db
      .update(entities)
      .set({
        rootAgentId: seed.agentId,
        rootGrants: {
          createAgent: false,
          createSkill: true,
          assignSkill: true,
          autonomy: 'propose_confirm',
        },
      })
      .where(eq(entities.id, seed.entityId));

    const job = await createJob();
    const { client, toolKeysPerCall } = makeCapturingLlmClient(returnResultScript());

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const firstTurnTools = new Set(toolKeysPerCall[0]);
    expect(firstTurnTools.has('create_skill'), 'create_skill should be present').toBe(true);
    expect(firstTurnTools.has('attach_skill'), 'attach_skill should be present').toBe(true);
    expect(
      firstTurnTools.has('create_agent'),
      'create_agent must be absent when its grant is OFF',
    ).toBe(false);
  });
});
