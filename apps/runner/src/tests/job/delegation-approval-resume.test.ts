// delegation-approval-resume.test.ts — Lot A: nested delegation + approval resume.
//
// Proves:
//   1. destructive_gate relaxation reaches a worker's run_command: a NORMAL
//      command auto-approves, a HEAVY one (rm/install/…) still gates.
//   2. When a DELEGATED child gates a heavy command and SUSPENDS, the parent
//      stays in `awaiting_delegation` (NOT failed) — the old "smoke-quality"
//      bug failed the parent here, breaking the whole chain.
//   3. After the child is approved + resumed + completed, maybeResumeParent
//      resumes the parent (→ pending) so it finishes the request.
//   4. Synchronous delegation (child completes inline, no suspension) is
//      UNCHANGED — the parent completes once, no double-resume.
//
// Harness (mock-LLM + approval drive) adapted from run-command-flow.test.ts +
// delegation-parallel-tools.test.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentAssignments,
  approvalRequests,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  entities,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM interception (verbatim from run-command-flow.test.ts) ───────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _c: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _c,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => void (_c = c),
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('no active LLM client — call setActiveLlmClient() first');
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
  let i = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
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
  PORT: 3098,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3098',
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

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let childId: string;
let childSlug: string;
let workspaceDir: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Workspace opt-out for destructive_gate is irrelevant in local-trust; the
  // autonomy relaxation is what we exercise. Set the entity's ROOT autonomy.
  await db
    .update(entities)
    .set({ rootGrants: { autonomy: 'destructive_gate' } })
    .where(eq(entities.id, seed.entityId));

  // Seed agent → orchestrator (router) so assign_<child> tools are generated.
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));

  // Child worker agent.
  const ts = Date.now();
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: `Worker ${ts}`,
      slug: `worker-dar-${ts}`,
      personality: 'a worker',
      role: 'agent',
      llmKeyId: seed.llmKeyId,
      active: true,
    })
    .returning();
  if (!child) throw new Error('failed to seed child');
  childId = child.id;
  childSlug = child.slug;

  await db
    .insert(agentAssignments)
    .values({ orchestratorId: seed.agentId, subAgentId: childId, entityId: seed.entityId });

  // command-execution skill + workspace for the child (run_command needs a cwd).
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-dar-')));
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Command execution ${ts}`,
      slug: `command-execution-dar-${ts}`,
      content: 'run shell commands',
      requiredBuiltins: ['run_command'],
    })
    .returning();
  if (!skill) throw new Error('failed to seed skill');
  await db
    .insert(agentSkillAssignments)
    .values({ entityId: seed.entityId, agentId: childId, skillId: skill.id });
  await db.insert(agentWorkspaces).values({
    agentId: childId,
    entityId: seed.entityId,
    label: 'ws',
    path: workspaceDir,
    position: 0,
  });
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
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

async function createJob(agentId: string, parentJobId?: string): Promise<{ id: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'api',
      task: 'do the thing',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...(parentJobId ? { parentJobId } : {}),
    })
    .returning();
  if (!job) throw new Error('failed to create job');
  return job;
}

const NORMAL_CMD = `node -e "process.stdout.write('NORMOK')"`;
const HEAVY_CMD = `rm ./nonexistent-dar-marker`; // matches isDestructiveOrHeavyCommand; harmless if spawned

// ─── 1. destructive_gate relaxation on a worker's run_command ────────────────

describe('destructive_gate — worker run_command relaxation', () => {
  it('NORMAL command auto-approves (no suspension) under destructive_gate', async () => {
    const job = await createJob(childId);
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'n1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: NORMAL_CMD },
          },
        ],
      },
      { toolCalls: [{ toolCallId: 'n2', toolName: 'return_result', args: { status: 'success' } }] },
    ]);
    const res = await executeJob(job.id as JobId, makeDeps(llm), testEnv);
    expect(res.status).toBe('completed');
    const pend = (
      await db.select().from(approvalRequests).where(eq(approvalRequests.jobId, job.id))
    ).find((r) => r.status === 'pending');
    expect(pend).toBeUndefined(); // never gated
  });

  it('HEAVY command still gates (suspends) under destructive_gate', async () => {
    const job = await createJob(childId);
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'h1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: HEAVY_CMD },
          },
        ],
      },
    ]);
    const res = await executeJob(job.id as JobId, makeDeps(llm), testEnv);
    expect(res.status).toBe('awaiting_approval');
    const pend = (
      await db.select().from(approvalRequests).where(eq(approvalRequests.jobId, job.id))
    ).find((r) => r.toolName === 'run_command' && r.status === 'pending');
    expect(pend).toBeDefined();
    expect((pend!.toolInput as { command: string }).command).toBe(HEAVY_CMD);
  });
});

// ─── 2 + 3. delegation: parent suspends, then resumes after approval ─────────

describe('delegation — parent suspends on child gate, resumes after approval', () => {
  it('parent SUSPENDS (awaiting_delegation) not fails; after approval+resume parent completes', async () => {
    const assignTool = `assign_${childSlug.replace(/-/g, '_')}`;
    const parent = await createJob(seed.agentId);

    // Sequence across parent + child executeJob calls:
    //  [0] parent → assign_child
    //  [1] child  → run_command(HEAVY) → gates → suspend
    //  [2] child  → return_result (after approval+resume)
    //  [3] parent → return_result (after re-trigger)
    const llm = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'p1', toolName: assignTool, args: { task: 'delete it' } }] },
      {
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: HEAVY_CMD },
          },
        ],
      },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'return_result', args: { status: 'success' } }] },
      { toolCalls: [{ toolCallId: 'p2', toolName: 'return_result', args: { status: 'success' } }] },
    ]);
    const deps = makeDeps(llm);

    // Phase 1: parent delegates → child gates the heavy command → child suspends.
    // The parent must SUSPEND (awaiting_delegation), NOT fail.
    const r1 = await executeJob(parent.id as JobId, deps, testEnv);
    expect(r1.status).toBe('awaiting_delegation');
    const parentAfter1 = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentAfter1[0]?.status).toBe('awaiting_delegation'); // not 'failed'

    // The child job exists, is awaiting_approval, with a pending run_command approval.
    const [childJob] = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, parent.id));
    expect(childJob?.status).toBe('awaiting_approval');
    const approval = (
      await db.select().from(approvalRequests).where(eq(approvalRequests.jobId, childJob!.id))
    ).find((r) => r.status === 'pending');
    expect(approval).toBeDefined();

    // Phase 2: approve the child's command + re-queue the child (mirrors approve route).
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approval!.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, childJob!.id));

    // Resume the child (non-inline). On completion, maybeResumeParent must flip
    // the parent back to 'pending' (triggerWorker's HTTP call is a no-op in test).
    const childRes = await executeJob(childJob!.id as JobId, deps, testEnv);
    expect(childRes.status).toBe('completed');
    const parentAfterChild = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentAfterChild[0]?.status).toBe('pending'); // resumed, awaiting re-execution

    // Phase 3: re-trigger the parent (what triggerWorker/cron does) → completes.
    const r3 = await executeJob(parent.id as JobId, deps, testEnv);
    expect(r3.status).toBe('completed');
  });
});

// ─── 4. synchronous delegation unchanged (no double-resume) ──────────────────

describe('delegation — synchronous path unchanged', () => {
  it('child completes inline (normal command) → parent completes once, no suspension', async () => {
    const assignTool = `assign_${childSlug.replace(/-/g, '_')}`;
    const parent = await createJob(seed.agentId);
    const llm = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'sp1', toolName: assignTool, args: { task: 'run it' } }] },
      {
        toolCalls: [
          {
            toolCallId: 'sc1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: NORMAL_CMD },
          },
        ],
      },
      {
        toolCalls: [{ toolCallId: 'sc2', toolName: 'return_result', args: { status: 'success' } }],
      },
      {
        toolCalls: [{ toolCallId: 'sp2', toolName: 'return_result', args: { status: 'success' } }],
      },
    ]);
    // Single executeJob call: parent → child (inline, normal cmd auto-approves,
    // completes) → parent resumes in-stack → completes. No suspension anywhere.
    const res = await executeJob(parent.id as JobId, makeDeps(llm), testEnv);
    expect(res.status).toBe('completed');
    const [parentRow] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parent.id));
    expect(parentRow?.status).toBe('completed');
  });
});
