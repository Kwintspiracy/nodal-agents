// approval-rules-fresh.test.ts — issue #370: the approval rules a running job
// obeys are re-read, they are not frozen at job start.
//
// The incident: job 7c519387 asked for a tool, Quentin answered "Approve for
// this project" (which WRITES an auto_approve rule conditioned on the job's
// folder), and ten seconds later the same job asked for the same tool again.
// The runner had read `approval_rules` once, at step 8, and kept that list for
// every gate of the job — so the rule answered ON that run only applied to the
// next one.
//
// Harness (mock-LLM + real run_command execution + grace window) adapted from
// approval-grace-window.test.ts. The grace window is a REAL DB-poll loop, so
// these tests use genuinely small real durations, never vitest fake timers.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
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
  approvalRequests,
  approvalRules,
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

// ─── LLM client interception ───────────────────────────────────────────────

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
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active)
        throw new Error(
          'approval-rules-fresh.test: no active LLM client — call setActiveLlmClient() first',
        );
      return active;
    },
  };
});

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
      for (const tc of response.toolCalls ?? [])
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
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
let workspaceDir: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));

  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-rules-fresh-')));
  await writeFile(join(workspaceDir, 'emit.js'), "process.stdout.write(process.argv[2] || '');\n");

  const ts = Date.now();
  const [skillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Command execution fresh rules ${ts}`,
      slug: `command-execution-fresh-rules-${ts}`,
      content: 'run shell commands',
      requiredBuiltins: ['run_command'],
    })
    .returning();
  if (!skillRow) throw new Error('Failed to insert command-execution skill');

  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: skillRow.id,
  });

  await db.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'ws',
    path: workspaceDir,
    position: 0,
  });
});

afterEach(async () => {
  // Rules and the brake are entity-wide state: leaving one behind would decide
  // the next test's verdict.
  await db.delete(approvalRules).where(eq(approvalRules.entityId, seed.entityId));
  await db.update(entities).set({ autoRunPaused: false }).where(eq(entities.id, seed.entityId));
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

async function createJob(): Promise<{ id: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'run two shell commands',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create test job');
  return job;
}

/** Wait until the gate has actually written the Nth approval row for this job. */
async function waitForApprovalRows(jobId: string, count: number) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.jobId, jobId));
    if (rows.length >= count) return rows.sort((a, b) => +a.requestedAt! - +b.requestedAt!);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${count} approval rows for job ${jobId} after 20s`);
}

async function approvalRowsOf(jobId: string) {
  return db.select().from(approvalRequests).where(eq(approvalRequests.jobId, jobId));
}

async function approve(id: string) {
  await db
    .update(approvalRequests)
    .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
    .where(eq(approvalRequests.id, id));
}

/** Does the persisted transcript carry this stdout marker in a run_command result? */
async function transcriptHasMarker(jobId: string, marker: string): Promise<boolean> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  const messages = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool-result') continue;
      if (JSON.stringify(block['output'] ?? null).includes(marker)) return true;
    }
  }
  return false;
}

/** Two turns asking for the same gated tool, then a return_result. */
function twoRunCommandTurns(markerA: string, markerB: string): MockResponse[] {
  return [
    {
      toolCalls: [
        {
          toolCallId: 'r1',
          toolName: 'run_command',
          args: { purpose: 'first gated command', command: `node emit.js ${markerA}` },
        },
      ],
    },
    {
      toolCalls: [
        {
          toolCallId: 'r2',
          toolName: 'run_command',
          args: { purpose: 'second gated command', command: `node emit.js ${markerB}` },
        },
      ],
    },
    {
      text: 'Done.',
      toolCalls: [{ toolCallId: 'r3', toolName: 'return_result', args: { status: 'success' } }],
    },
  ];
}

describe('approval rules are re-read while the job runs @cap:approuver-une-action/moteur', () => {
  it('a rule written WHILE the job waits governs the rest of that same run: the second call runs without asking again', async () => {
    const MARKER_A = `fresh-a-${Date.now()}`;
    const MARKER_B = `fresh-b-${Date.now()}`;
    const job = await createJob();
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 3000 };
    const jobPromise = executeJob(
      job.id as JobId,
      makeDeps(makeMockLlmClient(twoRunCommandTurns(MARKER_A, MARKER_B))),
      graceEnv,
    );

    const [first] = await waitForApprovalRows(job.id, 1);
    expect(first!.status).toBe('pending');

    // What "Approve for this project" writes on the card: an auto_approve rule
    // for this agent and this exact tool, confined to the job's folder.
    await db.insert(approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      action: 'auto_approve',
      conditionJson: { workspacePath: workspaceDir },
    });
    await approve(first!.id);

    const res = await jobPromise;
    expect(res.status).toBe('completed');

    // THE assertion: the second call never opened a second request.
    const rows = await approvalRowsOf(job.id);
    expect(rows.map((r) => r.toolName)).toEqual(['run_command']);

    // And it really ran: its stdout is in the transcript.
    expect(await transcriptHasMarker(job.id, MARKER_B)).toBe(true);
  }, 40_000);

  it('witness, same run without the rule: the second call asks again', async () => {
    const MARKER_A = `witness-a-${Date.now()}`;
    const MARKER_B = `witness-b-${Date.now()}`;
    const job = await createJob();
    // Short window: the second request is left pending on purpose, and the job
    // suspends once it expires.
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 600 };
    const jobPromise = executeJob(
      job.id as JobId,
      makeDeps(makeMockLlmClient(twoRunCommandTurns(MARKER_A, MARKER_B))),
      graceEnv,
    );

    const [first] = await waitForApprovalRows(job.id, 1);
    await approve(first!.id);

    const res = await jobPromise;
    expect(res.status).toBe('awaiting_approval');

    const rows = await approvalRowsOf(job.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    // The second command was gated, so it never ran.
    expect(await transcriptHasMarker(job.id, MARKER_B)).toBe(false);
  }, 40_000);

  it('a rule written BETWEEN two turns, with no approval in between, applies at the next turn', async () => {
    const MARKER = `turn-boundary-${Date.now()}`;
    const job = await createJob();

    // The rule is written DURING the first LLM call, i.e. after the job-start
    // load and after turn 1's own reload. Nothing is approved here: the only
    // thing that can make turn 2 run the command without asking is the reload
    // at the turn boundary.
    let ruleWritten = false;
    const llm = makeMockLlmClient([
      {
        toolCalls: [{ toolCallId: 't1', toolName: 'list_schedules', args: {} }],
      },
      {
        toolCalls: [
          {
            toolCallId: 't2',
            toolName: 'run_command',
            args: { purpose: 'command after the rule', command: `node emit.js ${MARKER}` },
          },
        ],
      },
      {
        text: 'Done.',
        toolCalls: [{ toolCallId: 't3', toolName: 'return_result', args: { status: 'success' } }],
      },
    ]);
    const deps = makeDeps(llm);
    const origGenerate = deps.llmClient.generateText.bind(deps.llmClient);
    deps.llmClient.generateText = (async (args: Parameters<typeof origGenerate>[0]) => {
      if (!ruleWritten) {
        ruleWritten = true;
        await db.insert(approvalRules).values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          toolName: 'run_command',
          action: 'auto_approve',
          conditionJson: { workspacePath: workspaceDir },
        });
      }
      return origGenerate(args);
    }) as typeof origGenerate;

    const res = await executeJob(job.id as JobId, deps, { ...testEnv });
    expect(res.status).toBe('completed');

    expect(await approvalRowsOf(job.id)).toHaveLength(0);
    expect(await transcriptHasMarker(job.id, MARKER)).toBe(true);
  }, 40_000);

  it('the auto_run_paused brake still bites after a reload: an auto_approve rule stays suspended turn after turn', async () => {
    const MARKER_A = `brake-a-${Date.now()}`;
    const MARKER_B = `brake-b-${Date.now()}`;
    // The rule exists from the start and would auto-run the command; the brake
    // is what must keep asking, at EVERY turn, reload included.
    await db.insert(approvalRules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      toolName: 'run_command',
      action: 'auto_approve',
    });
    await db.update(entities).set({ autoRunPaused: true }).where(eq(entities.id, seed.entityId));

    const job = await createJob();
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 600 };
    const jobPromise = executeJob(
      job.id as JobId,
      makeDeps(makeMockLlmClient(twoRunCommandTurns(MARKER_A, MARKER_B))),
      graceEnv,
    );

    const [first] = await waitForApprovalRows(job.id, 1);
    await approve(first!.id);

    const res = await jobPromise;
    expect(res.status).toBe('awaiting_approval');

    const rows = await approvalRowsOf(job.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(await transcriptHasMarker(job.id, MARKER_B)).toBe(false);
  }, 40_000);
});
