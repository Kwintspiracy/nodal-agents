// concurrent-read-approvals.test.ts — repro for audit finding RT-3 / #17:
// "approvals concurrentes ré-appariées par toolName au lieu de toolCallId".
//
// Mechanism under test (apps/runner/src/job/execute.ts):
//   - The parallel read pre-pass (~L2301-2327) runs every read tool call in a
//     turn through executeTool CONCURRENTLY, before the serial loop's
//     `awaitingApproval` short-circuit (~L2335) ever gets a chance to stop
//     later calls. If a require_approval rule gates that read tool, EACH
//     concurrent call independently inserts its own approval_requests row
//     (packages/tools/src/execute.ts ~L131-143) — so 2 calls to the SAME
//     gated read tool in one turn create 2 pending rows, not 1.
//   - The serial loop then only tags the FIRST call's tool-result block with
//     the literal text "[AWAITING_APPROVAL]"; the second is marked
//     "[DEFERRED]" instead (Bug A short-circuit, ~L2335-2345), even though
//     its own approval row already exists in the DB.
//   - On resume (~L1495-1537), the marker replacement matches purely by
//     `toolName` ("there is at most one pending approval per tool per turn
//     in this design" — an assumption this test breaks) — NOT by the
//     `toolCallId` that the marker text itself embeds
//     (`[AWAITING_APPROVAL] tool_call_id=<id>`, ~L2640). So approving the
//     SECOND (orphaned) approval row finds the FIRST call's
//     "[AWAITING_APPROVAL]" block (same toolName) and overwrites it with the
//     second call's real output — cross-wiring the two toolCallIds.
//
// Harness copied from run-command-flow.test.ts (mock-LLM infra + workspace
// setup) and approval-callback.test.ts (direct approval_requests manipulation
// to mimic a human resolving a specific card from the dashboard).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  approvalRequests,
  approvalRules,
  agentWorkspaces,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
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
          'concurrent-read-approvals.test: no active LLM client — call setActiveLlmClient() first',
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

  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-cra-')));
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
      task: 'read two files',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create test job');
  return job;
}

function blocksFor(msgs: Array<{ role: string; content: unknown }>) {
  const out: Array<{ toolCallId: string; toolName: string; text: string }> = [];
  for (const msg of msgs) {
    if (msg.role !== 'tool') continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool-result') continue;
      const output = block['output'] as { type: string; value: unknown } | undefined;
      const raw = output?.type === 'text' ? output.value : JSON.stringify(output?.value);
      out.push({
        toolCallId: block['toolCallId'] as string,
        toolName: block['toolName'] as string,
        text: typeof raw === 'string' ? raw : JSON.stringify(raw),
      });
    }
  }
  return out;
}

describe('concurrent gated reads — approval re-pairing (audit RT-3 / #17)', () => {
  it('two file_read calls to the SAME gated tool in one turn never have two simultaneous pending approvals, and each real output lands on its own toolCallId', async () => {
    const MARKER_A = `cra-marker-${Date.now()}-A`;
    const MARKER_B = `cra-marker-${Date.now()}-B`;
    await writeFile(join(workspaceDir, 'a.txt'), MARKER_A, 'utf8');
    await writeFile(join(workspaceDir, 'b.txt'), MARKER_B, 'utf8');

    // Gate file_read (an always-on 'read' tool) entity-wide, so BOTH calls in
    // the turn require approval.
    const [ruleRow] = await db
      .insert(approvalRules)
      .values({
        entityId: seed.entityId,
        agentId: null,
        toolName: 'file_read',
        action: 'require_approval',
      })
      .returning();
    if (!ruleRow) throw new Error('Failed to insert require_approval rule');

    try {
      const job = await createJob();

      const llmClient = makeMockLlmClient([
        // Turn 1: TWO independent reads of the same gated tool in one turn.
        // Both are riskLevel 'read' with no delegation/write — pre-fix this
        // qualified for the parallel pre-pass (execute.ts ~L2301-2305) and
        // gated BOTH concurrently. Post-fix, `wouldRequireApproval` pulls this
        // turn off the parallel path, so the serial loop's one-approval short
        // circuit actually applies: only tc-read-A is ever gated; tc-read-B is
        // deferred WITHOUT ever calling executeTool (no orphan row created).
        {
          toolCalls: [
            { toolCallId: 'tc-read-A', toolName: 'file_read', args: { path: 'a.txt' } },
            { toolCallId: 'tc-read-B', toolName: 'file_read', args: { path: 'b.txt' } },
          ],
        },
        // Turn 2 (after A's approval resolves): the LLM re-issues the deferred
        // read for b.txt under a NEW toolCallId, per the [DEFERRED] instruction.
        {
          toolCalls: [{ toolCallId: 'tc-read-B2', toolName: 'file_read', args: { path: 'b.txt' } }],
        },
        // Turn 3 (after B's approval resolves): agent finishes.
        {
          toolCalls: [
            { toolCallId: 'tc-rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      // ── Phase 1: executeJob → must suspend ─────────────────────────────────
      const suspendResult = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(suspendResult.status).toBe('awaiting_approval');

      // ── FIX PROOF #1: exactly ONE pending approval_requests row exists ─────
      // (the fix keeps the turn off the parallel path, so tc-read-B never
      // reaches executeTool and never creates its own row).
      const approvalRowsTurn1 = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.toolName, 'file_read')));
      const pendingTurn1 = approvalRowsTurn1.filter((r) => r.status === 'pending');
      expect(pendingTurn1.length).toBe(1);
      expect((pendingTurn1[0]!.toolInput as { path?: string }).path).toBe('a.txt');

      // Exactly one AWAITING_APPROVAL block (tc-read-A) and one DEFERRED block
      // (tc-read-B) in the persisted conversation.
      const jobRowTurn1 = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      const blocksTurn1 = blocksFor(
        jobRowTurn1[0]?.messages as Array<{ role: string; content: unknown }>,
      );
      const awaitingTurn1 = blocksTurn1.filter((b) => b.text.includes('[AWAITING_APPROVAL]'));
      const deferredTurn1 = blocksTurn1.filter((b) => b.text.includes('[DEFERRED]'));
      expect(awaitingTurn1.length).toBe(1);
      expect(awaitingTurn1[0]!.toolCallId).toBe('tc-read-A');
      expect(deferredTurn1.length).toBe(1);
      expect(deferredTurn1[0]!.toolCallId).toBe('tc-read-B');

      // ── Resolve A's approval and resume ────────────────────────────────────
      await db
        .update(approvalRequests)
        .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
        .where(eq(approvalRequests.id, pendingTurn1[0]!.id));
      await db
        .update(agentJobs)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(agentJobs.id, job.id));

      const resumeResult1 = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

      // A's real content lands correctly on tc-read-A; the agent re-issued B
      // under tc-read-B2, which is now gated in its own (single-call) turn.
      expect(resumeResult1.status).toBe('awaiting_approval');
      const jobRowTurn2 = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      const blocksTurn2 = blocksFor(
        jobRowTurn2[0]?.messages as Array<{ role: string; content: unknown }>,
      );
      const blockA = blocksTurn2.find((b) => b.toolCallId === 'tc-read-A')!;
      expect(blockA.text).toContain(MARKER_A);
      expect(blockA.text).not.toContain('[AWAITING_APPROVAL]');
      expect(blockA.text).not.toContain(MARKER_B); // no cross-wiring

      const approvalRowsTurn2 = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.toolName, 'file_read')));
      const pendingTurn2 = approvalRowsTurn2.filter((r) => r.status === 'pending');
      expect(pendingTurn2.length).toBe(1);
      expect((pendingTurn2[0]!.toolInput as { path?: string }).path).toBe('b.txt');

      // ── Resolve B2's approval and resume to completion ─────────────────────
      await db
        .update(approvalRequests)
        .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
        .where(eq(approvalRequests.id, pendingTurn2[0]!.id));
      await db
        .update(agentJobs)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(agentJobs.id, job.id));

      const resumeResult2 = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(resumeResult2.status).toBe('completed');

      const jobRowFinal = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      const blocksFinal = blocksFor(
        jobRowFinal[0]?.messages as Array<{ role: string; content: unknown }>,
      );
      const blockB2 = blocksFinal.find((b) => b.toolCallId === 'tc-read-B2')!;
      // B's real content lands correctly on tc-read-B2, not cross-wired to A.
      expect(blockB2.text).toContain(MARKER_B);
      expect(blockB2.text).not.toContain(MARKER_A);
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, ruleRow.id));
    }
  });
});
