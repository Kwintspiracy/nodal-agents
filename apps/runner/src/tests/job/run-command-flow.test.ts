// run-command-flow.test.ts — E2E runner integration test for the run_command builtin.
//
// Covers two paths:
//   1. APPROVAL PATH — no rule → safe default suspends; on approval-resume the real
//      child process spawns and its captured stdout reaches the agent.
//   2. YOLO PATH    — auto_approve rule → command runs inline (no suspension).
//
// Both tests assert the REAL spawned stdout MARKER (unique per run) rather than
// any pre-seeded value, proving real execution.
//
// Harness is copied verbatim from:
//   delegation-parallel-tools.test.ts  (mock-LLM infra)
//   execute.test.ts ~L2632–2681        (approval suspend→resume drive)

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
  approvalRules,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  entities,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM client interception (verbatim from delegation-parallel-tools.test.ts) ──

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
          'run-command-flow.test: no active LLM client — call setActiveLlmClient() first',
        );
      return active;
    },
  };
});

// ─── Mock LLM helper (verbatim from delegation-parallel-tools.test.ts) ───────

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

// ─── testEnv (verbatim from delegation-parallel-tools.test.ts) ───────────────

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

// ─── Test state ───────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let workspaceDir: string;
let skillId: string;

// ─── Suite-level setup ────────────────────────────────────────────────────────

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Ensure the seeded agent is a worker (not an orchestrator).
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));

  // Create a real temp workspace directory (run_command needs a real cwd).
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-rcflow-')));

  // A tiny helper script the auto-run tests invoke as `node emit.js <marker>`.
  // A script FILE keeps the auto-run tests focused on the RULE path (an
  // auto_approve rule → runs inline). Inline interpreter eval (`node -e`,
  // `python -c`, …) is exercised by the INLINE-EVAL test, which proves it gates
  // for a human and then RUNS once approved — it is no longer refused (ComfyUI
  // regression fix). Only true machine-destroyers stay refused after approval.
  await writeFile(join(workspaceDir, 'emit.js'), "process.stdout.write(process.argv[2] || '');\n");

  // Insert the command-execution skill with requiredBuiltins: ['run_command'].
  // name and slug must be unique across the DB — suffix with Date.now().
  const ts = Date.now();
  const [skillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Command execution ${ts}`,
      slug: `command-execution-test-${ts}`,
      content: 'run shell commands',
      requiredBuiltins: ['run_command'],
    })
    .returning();
  if (!skillRow) throw new Error('Failed to insert command-execution skill');
  skillId = skillRow.id;

  // Assign the skill to the agent.
  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId,
  });

  // Register a workspace for the agent (run_command uses it as cwd).
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('run_command — E2E runner integration', () => {
  // ── Test 1: APPROVAL PATH ─────────────────────────────────────────────────
  it('APPROVAL PATH: no rule → job suspends; on approval-resume the spawned stdout reaches the agent', async () => {
    const MARKER = `rc-marker-${Date.now()}-approval`;
    const COMMAND = `node emit.js ${MARKER}`;

    const job = await createJob();

    const llmClient = makeMockLlmClient([
      // Turn 1: agent calls run_command.
      {
        toolCalls: [
          {
            toolCallId: 'tc-rc-1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: COMMAND },
          },
        ],
      },
      // Turn 2 (after approval + real execution): agent finishes.
      {
        toolCalls: [
          { toolCallId: 'tc-rr-1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // ── Phase 1: executeJob → must suspend ───────────────────────────────────
    const suspendResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // ── Approval request exists in DB with the exact command ─────────────────
    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'run_command' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();
    expect(approvalRow!.toolName).toBe('run_command');
    // toolInput carries the exact command string so a human can review it.
    expect((approvalRow!.toolInput as { command: string }).command).toBe(COMMAND);

    // ── Drive the approval (mirrors approveRoute: record decision + re-queue) ─
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // ── Phase 2: resume → real command spawns → job completes ────────────────
    const resumeResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // ── CORE: the spawned stdout MARKER is in the persisted messages ──────────
    const jobRow = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;

    // Find the tool-result block for run_command and assert it contains MARKER.
    let foundMarker = false;
    let foundAwaiting = false;

    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        // tool-result blocks: { type: 'tool-result', toolName, output: { type, value } }
        if (block['type'] !== 'tool-result') continue;
        const output = block['output'] as { type: string; value: unknown } | undefined;
        const rawValue =
          output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
        const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
        if (valueStr.includes('[AWAITING_APPROVAL]')) foundAwaiting = true;
        if (block['toolName'] === 'run_command' && valueStr.includes(MARKER)) foundMarker = true;
      }
    }

    // The real spawned process must have written MARKER to stdout.
    expect(foundMarker).toBe(true);
    // No stale [AWAITING_APPROVAL] placeholder must remain in the conversation.
    expect(foundAwaiting).toBe(false);

    // executedAt is stamped on the approval_requests row after real execution.
    const updatedApproval = await db
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(updatedApproval[0]?.executedAt).not.toBeNull();
  });

  // ── Test 1b: INLINE-EVAL HARD FLOOR (A2) ──────────────────────────────────
  it('INLINE-EVAL: `node -e` suspends (gates), then RUNS once approved (no longer refused)', async () => {
    const MARKER_IE = `rc-marker-${Date.now()}-inline`;
    // Inline interpreter eval (`node -e`) is opaque but NO LONGER catastrophic
    // (ComfyUI regression fix, 2026-07): it gates for a human, and once approved
    // it RUNS — it is not refused-after-approval. Only true machine-destroyers
    // (`rm -rf /`, `mkfs`, …) stay refused even after approval.
    const COMMAND = `node -e "process.stdout.write('${MARKER_IE}')"`;

    const job = await createJob();
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-ie-1',
            toolName: 'run_command',
            args: { purpose: 'run a command for the test', command: COMMAND },
          },
        ],
      },
      // A second turn is provided in case the loop re-enters; the job should
      // fail before consuming it.
      {
        toolCalls: [
          { toolCallId: 'tc-ie-2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // Phase 1: inline-eval still gates (require_approval at the default autonomy).
    const suspendResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'run_command' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();

    // A human approves it.
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // Phase 2: resume → the approved inline-eval RUNS → job completes.
    const resumeResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // CORE: the spawned `node -e` stdout MARKER reaches the agent's messages —
    // proof it actually executed (not refused).
    const jobRow = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
    let foundMarker = false;
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block['type'] !== 'tool-result') continue;
        const output = block['output'] as { type: string; value: unknown } | undefined;
        const rawValue =
          output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
        const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
        if (block['toolName'] === 'run_command' && valueStr.includes(MARKER_IE)) foundMarker = true;
      }
    }
    expect(foundMarker).toBe(true);
  });

  // ── Test 2: YOLO PATH ─────────────────────────────────────────────────────
  it('YOLO PATH: auto_approve rule → command runs inline without suspension', async () => {
    const MARKER2 = `rc-marker-${Date.now()}-yolo`;
    const COMMAND2 = `node emit.js ${MARKER2}`;

    // Insert an auto_approve rule for run_command on this entity.
    const [ruleRow] = await db
      .insert(approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: null,
        toolName: 'run_command',
        action: 'auto_approve',
      })
      .returning();
    if (!ruleRow) throw new Error('Failed to insert auto_approve rule');

    try {
      const job = await createJob();

      const llmClient = makeMockLlmClient([
        // Turn 1: agent calls run_command (must NOT suspend with auto_approve rule).
        {
          toolCalls: [
            {
              toolCallId: 'tc-rc-2',
              toolName: 'run_command',
              args: { purpose: 'run a command for the test', command: COMMAND2 },
            },
          ],
        },
        // Turn 2: agent finishes.
        {
          toolCalls: [
            { toolCallId: 'tc-rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      // ── Single executeJob call → must complete WITHOUT suspending ─────────
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('completed');

      // ── No pending approval_requests row for this job ─────────────────────
      const pendingApprovals = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job.id));
      const pendingRow = pendingApprovals.find((r) => r.status === 'pending');
      expect(pendingRow).toBeUndefined();

      // ── CORE: MARKER2 appears in the job messages (real spawn happened) ────
      const jobRow = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));

      const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;

      let foundMarker2 = false;
      for (const msg of messages) {
        if (msg.role !== 'tool') continue;
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block['type'] !== 'tool-result') continue;
          const output = block['output'] as { type: string; value: unknown } | undefined;
          const rawValue =
            output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
          const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
          if (block['toolName'] === 'run_command' && valueStr.includes(MARKER2))
            foundMarker2 = true;
        }
      }

      expect(foundMarker2).toBe(true);
    } finally {
      // Always clean up the rule so it doesn't bleed into other tests.
      await db.delete(approvalRules).where(eq(approvalRules.id, ruleRow.id));
    }
  });

  // ── Test 3: LAN MASTER-SWITCH ───────────────────────────────────────────────
  // In non-local-trust (LAN / multi-user) mode the workspace opt-in
  // (entities.lan_command_yolo) is authoritative at RUNTIME: an auto_approve rule
  // for run_command is honored ONLY when the workspace has opted in. With the
  // switch off, run_command is forced back to approval even though the rule row
  // still exists — closing the gap where turning the workspace switch off left
  // stale per-agent Yolo rules live.
  const lanEnv: RunnerEnv = { ...testEnv, AUTH_MODE: 'local-auth' };

  it('LAN GATE (workspace Yolo OFF): auto_approve rule is overridden → job suspends for approval', async () => {
    const MARKER3 = `rc-marker-${Date.now()}-langate-off`;
    // Plain script invocation so the ONLY reason this suspends is the LAN gate
    // (an inline `node -e` would also gate via A2, masking a LAN-gate regression).
    const COMMAND3 = `node emit.js ${MARKER3}`;

    // Workspace has NOT opted in (the master switch is off).
    await db.update(entities).set({ lanCommandYolo: false }).where(eq(entities.id, seed.entityId));

    // An auto_approve rule EXISTS (e.g. created earlier while the switch was on).
    const [ruleRow] = await db
      .insert(approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: null,
        toolName: 'run_command',
        action: 'auto_approve',
      })
      .returning();
    if (!ruleRow) throw new Error('Failed to insert auto_approve rule');

    try {
      const job = await createJob();
      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-rc-3',
              toolName: 'run_command',
              args: { purpose: 'run a command for the test', command: COMMAND3 },
            },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'tc-rr-3', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      // local-auth + workspace Yolo OFF → the runtime gate forces approval despite
      // the auto_approve rule, so the job must SUSPEND (not auto-run to completion).
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), lanEnv);
      expect(result.status).toBe('awaiting_approval');

      // CORE: a pending approval row exists for run_command with the exact command
      // — proof the auto_approve rule was overridden at execution time.
      const approvals = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job.id));
      const pending = approvals.find((r) => r.toolName === 'run_command' && r.status === 'pending');
      expect(pending).toBeDefined();
      expect((pending!.toolInput as { command: string }).command).toBe(COMMAND3);
      // It never executed, so executedAt was never stamped.
      expect(pending!.executedAt).toBeNull();
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, ruleRow.id));
    }
  });

  it('LAN GATE (workspace Yolo ON): auto_approve rule is honored → command runs inline', async () => {
    const MARKER4 = `rc-marker-${Date.now()}-langate-on`;
    const COMMAND4 = `node emit.js ${MARKER4}`;

    // Workspace HAS opted in (the master switch is on).
    await db.update(entities).set({ lanCommandYolo: true }).where(eq(entities.id, seed.entityId));

    const [ruleRow] = await db
      .insert(approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: null,
        toolName: 'run_command',
        action: 'auto_approve',
      })
      .returning();
    if (!ruleRow) throw new Error('Failed to insert auto_approve rule');

    try {
      const job = await createJob();
      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-rc-4',
              toolName: 'run_command',
              args: { purpose: 'run a command for the test', command: COMMAND4 },
            },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'tc-rr-4', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      // local-auth + workspace Yolo ON → the rule is honored → runs inline.
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), lanEnv);
      expect(result.status).toBe('completed');

      const pendingApprovals = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job.id));
      expect(pendingApprovals.find((r) => r.status === 'pending')).toBeUndefined();

      // CORE: the real spawned stdout MARKER4 reached the agent.
      const jobRow = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
      let found = false;
      for (const msg of messages) {
        if (msg.role !== 'tool') continue;
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block['type'] !== 'tool-result') continue;
          const output = block['output'] as { type: string; value: unknown } | undefined;
          const rawValue =
            output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
          const valueStr = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
          if (block['toolName'] === 'run_command' && valueStr.includes(MARKER4)) found = true;
        }
      }
      expect(found).toBe(true);
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, ruleRow.id));
      // Reset the switch so it doesn't bleed into other tests.
      await db
        .update(entities)
        .set({ lanCommandYolo: false })
        .where(eq(entities.id, seed.entityId));
    }
  });

  // ── Test 5: CATASTROPHIC COMMAND APPROVED (Fix #29) ───────────────────────
  // A machine-wide-destructive command (`rm -rf /`) suspends normally (no rule
  // matches → safe-by-default), a human approves it anyway, but the hardline
  // floor (packages/tools/src/execute.ts) re-trips regardless of that approval
  // — this is UNCHANGED, intentional fail-safe behavior. Before Fix #29 the
  // job would silently feed the LLM an opaque `unexpected_gate_on_approved_tool`
  // tool-result and keep looping; after the fix it fails loud with a clear,
  // human-readable reason, and — provably — the command never executes.
  it('CATASTROPHIC COMMAND: approved anyway → job fails with a clear reason, command never executes', async () => {
    const COMMAND5 = 'rm -rf /';

    const job = await createJob();
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rc-5',
            toolName: 'run_command',
            args: { purpose: 'wipe everything (should never run)', command: COMMAND5 },
          },
        ],
      },
      // Turn 2 would only be reached if the job wrongly kept looping instead
      // of failing loud — left here so a regression back to the old behavior
      // shows up as a mismatched status rather than an unrelated mock error.
      {
        toolCalls: [
          { toolCallId: 'tc-rr-5', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // ── Phase 1: ordinary safe-by-default suspend (no rule matches yet) ──────
    const suspendResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'run_command' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();
    expect((approvalRow!.toolInput as { command: string }).command).toBe(COMMAND5);

    // ── A human approves it anyway ────────────────────────────────────────────
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // ── Phase 2: resume → the hardline floor refuses it, job fails loud ──────
    const resumeResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('failed');
    if (resumeResult.status === 'failed') {
      expect(resumeResult.error).toBe('catastrophic_command_refused');
      // NOT the old opaque internal code.
      expect(resumeResult.error).not.toBe('unexpected_gate_on_approved_tool');
      expect(resumeResult.result).not.toContain('unexpected_gate_on_approved_tool');
      // The reason is clear and human-readable.
      expect(resumeResult.result).toMatch(/catastrophi/i);
      expect(resumeResult.result).toMatch(/approbation|approval/i);
    }

    // ── DB row reflects the same honest failure ───────────────────────────────
    const jobRows = await db
      .select({ status: agentJobs.status, error: agentJobs.error, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(jobRows[0]?.status).toBe('failed');
    expect(jobRows[0]?.error).toBe('catastrophic_command_refused');
    expect(jobRows[0]?.result).toMatch(/catastrophi/i);

    // ── The original approval request is stamped executed (never re-processed) ─
    const resolvedApproval = await db
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(resolvedApproval[0]?.executedAt).not.toBeNull();

    // ── CORE: the command never executed ──────────────────────────────────────
    // No SECOND approval_requests row was spawned (the old behavior called
    // executeTool anyway, which re-trips the floor and creates an orphaned
    // pending row + a fresh notification).
    const allApprovals = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    expect(allApprovals.length).toBe(1);
    // Exactly ONE tool_calls audit row exists for run_command on this job (the
    // phase-1 suspend, which writes an audit row without executing). If the
    // command had actually run — or if executeTool had been called again and
    // re-gated — a second row would exist.
    const rcAuditRows = await db.select().from(toolCalls).where(eq(toolCalls.jobId, job.id));
    expect(rcAuditRows.filter((r) => r.toolName === 'run_command').length).toBe(1);
  });
});
