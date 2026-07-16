// approval-grace-window.test.ts — Lot A1: approval grace window
// (NODALAI_APPROVAL_GRACE_MS).
//
// A gated tool normally suspends the job to `awaiting_approval` the instant it
// fires; resuming later pays a full executeJob RESTART (~80-105s measured live:
// agent/skill/tool reload, thread history, system prompt rebuild). A human still
// at the screen typically decides in 5-30s, so that restart is wasted. Before
// suspend.ts/execute.ts actually suspends, it now polls in-process for up to
// NODALAI_APPROVAL_GRACE_MS; a decision landing inside the window is executed
// inline (same logic as the classic resume-at-entry step) and the job keeps
// looping — no suspend, no restart.
//
// Harness (mock-LLM + real run_command execution) adapted verbatim from
// run-command-flow.test.ts.
//
// IMPORTANT: the grace window is a REAL setTimeout/DB-poll loop — these tests
// use genuinely small real durations (tens/hundreds of ms), never vitest fake
// timers (fake timers + DB polling hangs).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob, reviveJobIfApprovalResolvedDuringSuspend } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM client interception (verbatim from run-command-flow.test.ts) ───────

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
          'approval-grace-window.test: no active LLM client — call setActiveLlmClient() first',
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
  // Real per-test default is 0 (disabled — immediate suspend). Individual
  // tests override this to exercise the grace window.
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

  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-grace-')));
  await writeFile(join(workspaceDir, 'emit.js'), "process.stdout.write(process.argv[2] || '');\n");

  const ts = Date.now();
  const [skillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Command execution grace ${ts}`,
      slug: `command-execution-grace-${ts}`,
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
      task: 'run a shell command',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create test job');
  return job;
}

/** Find the [AWAITING_APPROVAL]/MARKER content of the persisted transcript. */
function scanToolResults(
  messages: Array<{ role: string; content: unknown }>,
  marker: string | null,
): { foundAwaiting: boolean; foundRejected: boolean; foundMarker: boolean } {
  let foundAwaiting = false;
  let foundRejected = false;
  let foundMarker = false;
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool-result') continue;
      const output = block['output'] as { type: string; value: unknown } | undefined;
      const rawValue =
        output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
      const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
      if (valueStr.includes('[AWAITING_APPROVAL]')) foundAwaiting = true;
      if (valueStr.includes('[REJECTED]')) foundRejected = true;
      if (marker && block['toolName'] === 'run_command' && valueStr.includes(marker)) {
        foundMarker = true;
      }
    }
  }
  return { foundAwaiting, foundRejected, foundMarker };
}

describe('approval grace window (Lot A1, NODALAI_APPROVAL_GRACE_MS)', () => {
  it('approval resolved inside the window: job completes WITHOUT ever suspending, executed_at stamped, real output lands', async () => {
    const MARKER = `grace-marker-${Date.now()}-approve`;
    const COMMAND = `node emit.js ${MARKER}`;
    const job = await createJob();
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'g1',
            toolName: 'run_command',
            args: { purpose: 'grace inline approve', command: COMMAND },
          },
        ],
      },
      { toolCalls: [{ toolCallId: 'g2', toolName: 'return_result', args: { status: 'success' } }] },
    ]);
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 1000 };

    // Single executeJob call for this job. If the gate had actually suspended
    // (grace disabled / expired), this ONE call would have returned
    // 'awaiting_approval' and nothing else re-triggers it here — we never flip
    // the job back to `pending` ourselves. Reaching 'completed' is only
    // possible via the grace-window inline resume.
    const jobPromise = executeJob(job.id as JobId, makeDeps(llm), graceEnv);

    // Approve WELL inside the 1000ms window (poll interval 250ms) — mirrors a
    // human still at the screen. Real timer, no fake timers.
    await new Promise((r) => setTimeout(r, 80));
    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find((r) => r.toolName === 'run_command');
    expect(approvalRow).toBeDefined();
    expect(approvalRow!.status).toBe('pending');
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));

    const res = await jobPromise;
    expect(res.status).toBe('completed');

    const executedApproval = await db
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(executedApproval[0]?.executedAt).not.toBeNull();

    const jobRow = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const { foundAwaiting, foundMarker } = scanToolResults(
      jobRow[0]?.messages as Array<{ role: string; content: unknown }>,
      MARKER,
    );
    expect(foundMarker).toBe(true); // real spawned stdout reached the transcript
    expect(foundAwaiting).toBe(false); // no stale placeholder left behind
  });

  it('rejection resolved inside the window: [REJECTED] marker lands, job continues to completion', async () => {
    const job = await createJob();
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'gr1',
            toolName: 'run_command',
            args: { purpose: 'grace inline reject', command: 'node emit.js should-not-run' },
          },
        ],
      },
      {
        toolCalls: [{ toolCallId: 'gr2', toolName: 'return_result', args: { status: 'success' } }],
      },
    ]);
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 1000 };

    const jobPromise = executeJob(job.id as JobId, makeDeps(llm), graceEnv);

    await new Promise((r) => setTimeout(r, 80));
    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find((r) => r.toolName === 'run_command');
    expect(approvalRow).toBeDefined();
    await db
      .update(approvalRequests)
      .set({
        status: 'rejected',
        resolvedAt: new Date(),
        resolvedBy: 'test',
        notes: 'not authorized for this test',
      })
      .where(eq(approvalRequests.id, approvalRow!.id));

    const res = await jobPromise;
    expect(res.status).toBe('completed');

    const executedApproval = await db
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(executedApproval[0]?.executedAt).not.toBeNull();

    const jobRow = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const { foundAwaiting, foundRejected } = scanToolResults(
      jobRow[0]?.messages as Array<{ role: string; content: unknown }>,
      null,
    );
    expect(foundRejected).toBe(true);
    expect(foundAwaiting).toBe(false);
  });

  it('expiry: the window elapses with the approval still pending — suspends exactly as before', async () => {
    const job = await createJob();
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'ge1',
            toolName: 'run_command',
            args: { purpose: 'grace expiry', command: 'node emit.js should-not-run-either' },
          },
        ],
      },
    ]);
    const shortGraceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 100 };

    const res = await executeJob(job.id as JobId, makeDeps(llm), shortGraceEnv);
    expect(res.status).toBe('awaiting_approval');

    const jobRow = await db
      .select({ status: agentJobs.status, messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(jobRow[0]?.status).toBe('awaiting_approval');

    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find((r) => r.toolName === 'run_command');
    expect(approvalRow?.status).toBe('pending');
    expect(approvalRow?.executedAt).toBeNull();

    // Checkpoint persisted with the [AWAITING_APPROVAL] marker STILL in place
    // — nothing was executed, prior behavior unchanged.
    const { foundAwaiting } = scanToolResults(
      jobRow[0]?.messages as Array<{ role: string; content: unknown }>,
      null,
    );
    expect(foundAwaiting).toBe(true);
  });

  it('cancel wins mid-window: nothing executes, the approval stays pending, the job stays cancelled', async () => {
    const job = await createJob();
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'gc1',
            toolName: 'run_command',
            args: { purpose: 'grace cancel', command: 'node emit.js should-not-run-cancel' },
          },
        ],
      },
    ]);
    const graceEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 1000 };

    const jobPromise = executeJob(job.id as JobId, makeDeps(llm), graceEnv);

    await new Promise((r) => setTimeout(r, 80));
    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find((r) => r.toolName === 'run_command');
    expect(approvalRow).toBeDefined();

    // Cancel WITHOUT ever resolving the approval — mirrors the user hitting
    // cancel while the gate sits open.
    await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, job.id));

    const res = await jobPromise;
    expect(res.status).toBe('cancelled');

    const executedApproval = await db
      .select({ status: approvalRequests.status, executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(executedApproval[0]?.status).toBe('pending'); // never approved/rejected
    expect(executedApproval[0]?.executedAt).toBeNull(); // never executed

    const jobRow = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(jobRow[0]?.status).toBe('cancelled'); // not resurrected to awaiting_approval
  });

  it('grace=0 disables the window entirely: suspends immediately, no poll', async () => {
    const job = await createJob();
    const llm = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'gz1',
            toolName: 'run_command',
            args: { purpose: 'zero grace', command: 'node emit.js zero-grace' },
          },
        ],
      },
    ]);
    const zeroEnv: RunnerEnv = { ...testEnv, NODALAI_APPROVAL_GRACE_MS: 0 };

    const start = Date.now();
    const res = await executeJob(job.id as JobId, makeDeps(llm), zeroEnv);
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe('awaiting_approval');
    // No poll loop ran — well under one poll tick even on a loaded CI box.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('race post-suspend: an approval resolved between the last poll and the suspend write self-heals — flips to pending and triggers the worker', async () => {
    const job = await createJob();
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job.id,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput: { command: 'echo race' },
        status: 'approved',
        resolvedAt: new Date(),
        resolvedBy: 'test',
      })
      .returning();
    if (!approval) throw new Error('failed to seed approval');

    const origFetch = global.fetch;
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await reviveJobIfApprovalResolvedDuringSuspend(
        db as unknown as RunnerDeps['db'],
        job.id,
        testEnv,
      );
    } finally {
      global.fetch = origFetch;
    }

    const jobRow = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(jobRow[0]?.status).toBe('pending'); // real DB check, not a call count

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/worker');
    expect(JSON.parse(String(init?.body))).toEqual({ jobId: job.id });
  });

  it('race post-suspend: no-op when the job holds no resolved-but-unexecuted approval', async () => {
    const job = await createJob();
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: job.id,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'echo still-pending' },
      status: 'pending',
    });

    const origFetch = global.fetch;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await reviveJobIfApprovalResolvedDuringSuspend(
        db as unknown as RunnerDeps['db'],
        job.id,
        testEnv,
      );
    } finally {
      global.fetch = origFetch;
    }

    const jobRow = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(jobRow[0]?.status).toBe('awaiting_approval'); // untouched — nothing resolved

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
