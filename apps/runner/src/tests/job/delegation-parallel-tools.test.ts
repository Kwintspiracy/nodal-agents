// delegation-parallel-tools.test.ts — regression for the unmatched_tool_use bug
// reproduced live on jobs 24c8802d-... and ac64d2ef-... (2026-05-16).
//
// Bug: when an orchestrator LLM emits [assign_<child>, save_memory] in the
// SAME turn, the runner's loop processes assign first (per emission order),
// hits DelegationPendingError, and exits before executing save_memory. The
// assistant message contains BOTH tool_use blocks but only the assign one
// gets a tool_result via the delegation marker — save_memory's tool_use is
// dangling. On parent resume, validateMessageStructure throws
// MessageStructureError [unmatched_tool_use].
//
// The fix (this test asserts it): sort callsToProcess so any non-assign tool
// runs BEFORE the assign — guaranteeing all siblings produce results that
// preAssignSideResults forwards to handleDelegation → resumeDelegated.
//
// This test deliberately mocks the LLM to emit [assign, save_memory] in that
// EXACT order (assign first), which is the failing pattern. The same pair
// emitted as [save_memory, assign] worked before the fix only by accident.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, agentAssignments, agentMemory, agentTasks } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM client interception ──────────────────────────────────────────────────

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
        throw new Error(
          'delegation-parallel-tools.test: no active LLM client — call setActiveLlmClient() first',
        );
      return active;
    },
  };
});

// ─── Mock LLM helper ──────────────────────────────────────────────────────────

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
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

// ─── Test fixture ─────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let childAgentId: string;

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
  REFLECTION_MIN_TURNS: 3,
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
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Make seed agent the orchestrator (router mode) so generateAssignTools fires
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));

  // Create a child agent (worker) — this is what assign_<slug> will target
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Test Child',
      slug: `test-child-${Date.now()}`,
      personality: 'I am a test child agent.',
      llmKeyId: seed.llmKeyId,
      role: 'agent',
      systemAgent: true,
    })
    .returning();
  if (!child) throw new Error('Failed to seed child agent');
  childAgentId = child.id;

  // Link orchestrator → child
  await db.insert(agentAssignments).values({
    orchestratorId: seed.agentId,
    subAgentId: child.id,
    entityId: seed.entityId,
  });
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

async function createOrchestratorJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Delegate to the child and remember something',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create orchestrator job');
  return job.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('delegation + parallel tool calls — message-structure integrity', () => {
  it('REGRESSION: [assign_<child>, save_memory] in turn 1 → both tool_uses get matched results', async () => {
    const jobId = await createOrchestratorJob();

    // Look up the child slug to build the assign tool name
    const [childRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, childAgentId));
    if (!childRow) throw new Error('child agent missing');
    const assignToolName = `assign_${childRow.slug.replace(/-/g, '_')}`;

    // LLM script:
    //   Parent turn 1: [assign_child, save_memory] — ASSIGN EMITTED FIRST (the failing pattern)
    //   Child turn 1: dashboard_publish + return_result (completes synchronously)
    //   Parent turn 2: return_result (parent finalizes after delegation result is injected)
    const llmClient = makeMockLlmClient([
      // Parent turn 1
      {
        toolCalls: [
          {
            toolCallId: 'tc-assign',
            toolName: assignToolName,
            args: { task: 'do the thing' },
          },
          {
            toolCallId: 'tc-save',
            toolName: 'save_memory',
            args: { fact: 'we delegated to the child', category: 'context', importance: 3 },
          },
        ],
      },
      // Child turn 1 — publish + return so child completes immediately
      {
        toolCalls: [
          {
            toolCallId: 'tc-pub',
            toolName: 'dashboard_publish',
            args: { text: 'child says hi' },
          },
          {
            toolCallId: 'tc-rr-child',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
      // Parent turn 2 — return_result after seeing child output
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-parent',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(jobId as JobId, makeDeps(llmClient), testEnv);

    // Top-level assertion: NO MessageStructureError fired.
    expect(result.status).toBe('completed');

    // The parent's persisted messages must end with all tool_uses matched.
    const [parentRow] = await db
      .select({ messages: agentJobs.messages, status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(parentRow?.status).toBe('completed');
    expect(parentRow?.error).toBeNull();

    const messages = (parentRow?.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;

    // Find the assistant message that emitted both tool_uses (turn 1).
    const assistantWithBoth = messages.find((m) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
      const names = m.content
        .filter(
          (b): b is { type: string; toolName: string } =>
            typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool-call',
        )
        .map((b) => b.toolName);
      return names.includes(assignToolName) && names.includes('save_memory');
    });
    expect(assistantWithBoth).toBeDefined();

    // The tool message that follows it must contain tool_results for BOTH
    // tc-assign AND tc-save. Pre-fix, only the assign result was present
    // (save_memory was never executed because the loop exited on assign).
    const idx = messages.indexOf(assistantWithBoth!);
    const toolMsg = messages[idx + 1] as { role: string; content: unknown } | undefined;
    expect(toolMsg?.role).toBe('tool');
    const toolResultIds = Array.isArray(toolMsg?.content)
      ? (toolMsg.content as Array<{ type?: string; toolCallId?: string }>)
          .filter((b) => b.type === 'tool-result')
          .map((b) => b.toolCallId)
      : [];
    expect(toolResultIds).toContain('tc-assign');
    expect(toolResultIds).toContain('tc-save');

    // save_memory's side effect must have hit the DB — fact persisted under this entity.
    const memRows = await db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.entityId, seed.entityId));
    const saved = memRows.find((r) => r.fact === 'we delegated to the child');
    expect(saved).toBeDefined();
  });

  it('REGRESSION: cap fires on parallel assigns → deferred sibling still gets tool_result (no unmatched_tool_use)', async () => {
    // Live regression: job `a5ac5d6e` (2026-05-18) — Conciergus issued 2
    // parallel `assign_summarizer` while the parent already had the same slug
    // marked as last_failed_delegation_slug. Only the kept assign received
    // the synthetic refusal tool_result; the deferred sibling (filtered out
    // by filterToolCallsForDelegation) was orphaned because `handleDelegation`
    // — the only consumer of `sideToolResults` — never ran in the cap-refusal
    // path. Next LLM call: `message_structure_invalid:unmatched_tool_use` →
    // job dead. The fix flushes `sideToolResults` into `toolResultBlocks`
    // alongside the refusal so every tool_use has a matching tool_result.
    const jobId = await createOrchestratorJob();

    const [childRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, childAgentId));
    if (!childRow) throw new Error('child agent missing');
    const assignToolName = `assign_${childRow.slug.replace(/-/g, '_')}`;

    // Pre-seed the parent so the same-slug retry is refused on the next assign.
    await db
      .update(agentJobs)
      .set({ lastFailedDelegationSlug: childRow.slug })
      .where(eq(agentJobs.id, jobId));

    // LLM script:
    //   Parent turn 1: TWO parallel assign_<child> (the failing pattern at cap)
    //   Parent turn 2: return_result blocked (responding to the cap refusal)
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-assign-kept', toolName: assignToolName, args: { task: 'task A' } },
          { toolCallId: 'tc-assign-deferred', toolName: assignToolName, args: { task: 'task B' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-blocked',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Cannot retry the same specialist at the cap' },
          },
        ],
      },
    ]);

    const result = await executeJob(jobId as JobId, makeDeps(llmClient), testEnv);

    // The regression guard: the parent finalizes via an HONEST block (the error
    // column carries the agent's short reason), NOT via
    // message_structure_invalid:unmatched_tool_use.
    expect(result.status).toBe('failed');

    const [parentRow] = await db
      .select({ messages: agentJobs.messages, status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(parentRow?.status).toBe('failed');
    expect(parentRow?.error).toBe('Cannot retry the same specialist at the cap');

    const messages = (parentRow?.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;

    // Find the assistant message that emitted both assigns (turn 1).
    const assistantWithBoth = messages.find((m) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
      const ids = m.content
        .filter(
          (b): b is { type: string; toolCallId: string } =>
            typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool-call',
        )
        .map((b) => b.toolCallId);
      return ids.includes('tc-assign-kept') && ids.includes('tc-assign-deferred');
    });
    expect(assistantWithBoth).toBeDefined();

    // The tool message right after must carry BOTH tool_results — the kept
    // assign gets the cap-refusal error, the deferred sibling gets the
    // "another handoff took priority" marker. Pre-fix, only the first was
    // present.
    const idx = messages.indexOf(assistantWithBoth!);
    const toolMsg = messages[idx + 1] as { role: string; content: unknown } | undefined;
    expect(toolMsg?.role).toBe('tool');
    const toolResultIds = Array.isArray(toolMsg?.content)
      ? (toolMsg.content as Array<{ type?: string; toolCallId?: string }>)
          .filter((b) => b.type === 'tool-result')
          .map((b) => b.toolCallId)
      : [];
    expect(toolResultIds).toContain('tc-assign-kept');
    expect(toolResultIds).toContain('tc-assign-deferred');
  });

  it('REGRESSION: same pair in reverse emission order [save_memory, assign_<child>] also succeeds', async () => {
    // Sanity check that the existing path (save_memory before assign) still works,
    // so the fix didn't regress the happy case.
    const jobId = await createOrchestratorJob();
    const [childRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, childAgentId));
    if (!childRow) throw new Error('child agent missing');
    const assignToolName = `assign_${childRow.slug.replace(/-/g, '_')}`;

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-save-2',
            toolName: 'save_memory',
            args: { fact: 'reverse-order check', category: 'context', importance: 3 },
          },
          {
            toolCallId: 'tc-assign-2',
            toolName: assignToolName,
            args: { task: 'do the thing again' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-pub-2', toolName: 'dashboard_publish', args: { text: 'ok' } },
          { toolCallId: 'tc-rr-child-2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-parent-2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(jobId as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
  });
});

// ─── Phase 3: unified orchestrator ─────────────────────────────────────────────

describe('unified orchestrator — one orchestrator drives BOTH delegation styles', () => {
  it('PHASE 3: a router-configured orchestrator that calls create_task fans out to the task board (awaiting_tasks)', async () => {
    // The seed orchestrator is role=orchestrator, orchestratorMode='router' (set
    // in beforeAll). Pre-Phase-3 it received ONLY assign_* tools, so a create_task
    // call would trip AI_NoSuchToolError. Phase 3 hands every orchestrator BOTH
    // toolsets and lets the model choose per request. Here it chooses the planner
    // path: create_task → the job suspends into the task board instead of
    // completing inline (the cron's deliverCompletedRoots owns the final state).
    const jobId = await createOrchestratorJob();

    const [childRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, childAgentId));
    if (!childRow) throw new Error('child agent missing');

    const llmClient = makeMockLlmClient([
      // Turn 1: create one task assigned to the worker by its slug (the planner
      // handle the unified team block now advertises for every child).
      {
        toolCalls: [
          {
            toolCallId: 'tc-create-task',
            toolName: 'create_task',
            args: { title: 'Do the parallelizable thing', assigned_to: childRow.slug },
          },
        ],
      },
      // Turn 2: acknowledge — the task board takes over from here.
      {
        toolCalls: [
          { toolCallId: 'tc-rr-ack', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(jobId as JobId, makeDeps(llmClient), testEnv);

    // The router-configured orchestrator suspended into the planner flow — it did
    // NOT complete inline. That proves create_task was BOTH available and honored.
    expect(result.status).toBe('awaiting_tasks');

    // A real task row exists, rooted at this job and assigned to the worker by id.
    const taskRows = await db
      .select({
        id: agentTasks.id,
        rootJobId: agentTasks.rootJobId,
        assignedAgentId: agentTasks.assignedAgentId,
        status: agentTasks.status,
        title: agentTasks.title,
      })
      .from(agentTasks)
      .where(eq(agentTasks.rootJobId, jobId));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.assignedAgentId).toBe(childAgentId);
    expect(taskRows[0]?.status).toBe('todo');
    expect(taskRows[0]?.title).toBe('Do the parallelizable thing');

    // The job stays non-terminal (processing) so the cron can finalize it — it
    // must NOT be completed/failed here.
    const [jobRow] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(jobRow?.status).toBe('processing');
  });

  it('PHASE 3: the same orchestrator still drives the router path (assign_<child> suspends into delegation)', async () => {
    // Counterpart to the create_task test: the unified orchestrator, given an
    // assign_<child> call instead, takes the in-line router path and completes
    // after the child returns — proving BOTH styles work from one orchestrator
    // without a mode flag gating the toolset.
    const jobId = await createOrchestratorJob();

    const [childRow] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, childAgentId));
    if (!childRow) throw new Error('child agent missing');
    const assignToolName = `assign_${childRow.slug.replace(/-/g, '_')}`;

    const llmClient = makeMockLlmClient([
      // Parent turn 1: a single in-line delegation.
      {
        toolCalls: [{ toolCallId: 'tc-assign-u', toolName: assignToolName, args: { task: 'go' } }],
      },
      // Child turn 1: publish + return so it completes synchronously.
      {
        toolCalls: [
          { toolCallId: 'tc-pub-u', toolName: 'dashboard_publish', args: { text: 'done' } },
          { toolCallId: 'tc-rr-child-u', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      // Parent turn 2: finalize after the delegation result is injected.
      {
        toolCalls: [
          { toolCallId: 'tc-rr-parent-u', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(jobId as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // No task-board rows were created — this job took the router path, not planner.
    const taskRows = await db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(eq(agentTasks.rootJobId, jobId));
    expect(taskRows).toHaveLength(0);
  });
});
