// may-change-team.test.ts — the per-agent "May change its own team" setting
// (issue #137), proved on a REAL job.
//
// @cap:assigner-outils/moteur
//
// THE INCIDENT. On the night of 2026-09-15 a request reached an orchestrator
// through the MCP: run a review "with Reviewer C, without going through
// Lead-Dev". Reviewer C was not in its team. The agent called `attach_agent`
// on `reviewer-c` at 02:13, which put Reviewer C in two teams, and delegated.
// The owner found the team rearranged the next morning. Nothing was broken —
// the agent had the tool, because it was the ROOT and the workspace grant was
// on by default. `agents.may_change_team` is what now stands between the two.
//
// WHAT THIS PROVES, and it is the engine level of the promise: with the setting
// off, `create_agent` / `attach_agent` / `detach_agent` are ABSENT from the
// toolset the runner hands the model for a real run, while every other
// meta-tool the grants enable is still there; with it on, the three come back;
// and a model that names `attach_agent` anyway is told the tool is not
// available to it, and NO agent_assignments row appears.
//
// The assertions read the `tools` argument the runner passed to
// generateText, the persisted job messages, and the database rows — never a
// call count (invariant #5). The capture harness is the one
// `root-meta-tools.test.ts` established.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents, agentAssignments, entities } from '@nodal-agents/db';
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
        throw new Error('may-change-team.test: no active LLM client — call setActiveLlmClient()');
      return active;
    },
  };
});

// ─── Mock LLM that records the tool names it was handed each turn ─────────────

interface CapturingClient {
  client: RunnerDeps['llmClient'];
  /** The keys of the `tools` object passed to generateText, per call. */
  toolKeysPerCall: string[][];
}

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
/** The agent a run could attach — the Reviewer C of the incident. */
let outsiderId = '';

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

/** Every team-changing grant ON, so only the per-agent setting can remove them. */
const GRANTS_ALL_TEAM_ON = {
  createAgent: true,
  attachAgent: true,
  createSkill: true,
  assignSkill: true,
  autonomy: 'fully_autonomous',
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // The seeded agent becomes the designated ROOT router orchestrator — the
  // exact shape the incident ran in.
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router' })
    .where(eq(agents.id, seed.agentId));
  await db
    .update(entities)
    .set({ rootAgentId: seed.agentId, rootGrants: GRANTS_ALL_TEAM_ON })
    .where(eq(entities.id, seed.entityId));

  const [outsider] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Reviewer C',
      slug: `reviewer-c-${Date.now()}`,
      personality: 'I review.',
      llmKeyId: seed.llmKeyId,
      role: 'agent',
    })
    .returning();
  if (!outsider) throw new Error('failed to seed the outside agent');
  outsiderId = outsider.id;
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

async function createJob(task: string) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create job');
  return job;
}

/** A single scripted turn: the orchestrator immediately calls return_result. */
function returnResultScript() {
  return [
    {
      text: 'Done.',
      toolCalls: [{ toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } }],
    },
  ];
}

async function setMayChangeTeam(value: boolean): Promise<void> {
  await db.update(agents).set({ mayChangeTeam: value }).where(eq(agents.id, seed.agentId));
}

const TEAM_TOOLS = ['create_agent', 'attach_agent', 'detach_agent'];

/**
 * The `error` string of the tool_result recorded for `toolName`, or null when
 * no such result is in the transcript. Walks the persisted messages by shape —
 * a stringified transcript would hide the text behind JSON escaping.
 */
function findToolResultError(messages: unknown, toolName: string): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as {
        type?: unknown;
        toolName?: unknown;
        output?: { value?: { error?: unknown } };
      };
      if (p.type !== 'tool-result' || p.toolName !== toolName) continue;
      const error = p.output?.value?.error;
      if (typeof error === 'string') return error;
    }
  }
  return null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('may_change_team — the tool list of a real run @cap:assigner-outils/moteur', () => {
  it('off: the three team tools are absent, the other granted meta-tools are not', async () => {
    await setMayChangeTeam(false);

    const job = await createJob('Review the change with Reviewer C.');
    const { client, toolKeysPerCall } = makeCapturingLlmClient(returnResultScript());
    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const handed = new Set(toolKeysPerCall[0]);
    for (const name of TEAM_TOOLS) {
      expect(handed.has(name), `${name} must NOT be handed to an agent that may not recruit`).toBe(
        false,
      );
    }
    // The setting removes the team tools and nothing else: the skill grants of
    // the same rootGrants are untouched.
    expect(handed.has('create_skill')).toBe(true);
    expect(handed.has('attach_skill')).toBe(true);
    // And the agent still has its ordinary working surface.
    expect(handed.has('return_result')).toBe(true);
    expect(handed.has('save_memory')).toBe(true);
  });

  it('on: the same agent, same grants, receives the three', async () => {
    await setMayChangeTeam(true);

    const job = await createJob('Review the change with Reviewer C.');
    const { client, toolKeysPerCall } = makeCapturingLlmClient(returnResultScript());
    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    const handed = new Set(toolKeysPerCall[0]);
    for (const name of TEAM_TOOLS) {
      expect(handed.has(name), `${name} must be handed once the owner turned it on`).toBe(true);
    }
  });

  it('off: a run that calls attach_agent is told the tool is not available, and no assignment row appears', async () => {
    await setMayChangeTeam(false);
    // Nothing attached before the run — the row this test forbids is a NEW one.
    await db
      .delete(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, seed.agentId),
          eq(agentAssignments.subAgentId, outsiderId),
        ),
      );

    const job = await createJob('Get Reviewer C to review this, do not go through Lead-Dev.');
    const { client, toolKeysPerCall } = makeCapturingLlmClient([
      {
        text: 'Attaching the reviewer.',
        toolCalls: [
          {
            toolCallId: 'tc-attach',
            toolName: 'attach_agent',
            args: { agentSlug: 'reviewer-c' },
          },
        ],
      },
      ...returnResultScript(),
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // The name was never on the list it was handed.
    expect(new Set(toolKeysPerCall[0]).has('attach_agent')).toBe(false);

    // The model was told so, in the tool_result the job keeps — read out of
    // the persisted transcript, not out of a log line.
    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id))
      .limit(1);
    const refusal = findToolResultError(row?.messages, 'attach_agent');
    expect(refusal, 'no tool_result recorded for the attach_agent call').not.toBeNull();
    expect(refusal).toContain('The tool "attach_agent" is not available to you.');
    // The refusal names what the agent DOES have, and the three are not in it.
    for (const name of TEAM_TOOLS) {
      expect(refusal).not.toContain(`, ${name},`);
    }
    expect(refusal).toContain('attach_skill');

    // And the team is exactly as the owner left it.
    const assignments = await db
      .select({ subAgentId: agentAssignments.subAgentId })
      .from(agentAssignments)
      .where(eq(agentAssignments.orchestratorId, seed.agentId));
    expect(assignments.map((a) => a.subAgentId)).not.toContain(outsiderId);
  });
});
