// connector-approval-resume.test.ts — a connector operation marked
// `requiresApproval` asks, on the real job loop, and runs once approved (#735).
//
// Before #735 the descriptor's `requiresApproval` never reached the gate: the
// LLM's `airtable_delete_record` ran on its first call, under every autonomy
// level. Here, on the real `executeJob` and a real database: the call suspends
// the job with a pending approval request and makes NO request to Airtable;
// once approved and resumed it makes exactly ONE, and the job completes without
// asking again.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  agents,
  approvalRequests,
  connectors,
  agentConnectorAssignments,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Module-level mock registry ───────────────────────────────────────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return { ...actual, sendTelegramMessage: vi.fn().mockResolvedValue({ messageId: 999 }) };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('connector-approval-resume.test: no active LLM client set');
      return active;
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockLlmClient(
  responses: Array<{
    text?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  }>,
): RunnerDeps['llmClient'] {
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

// ─── Test constants ────────────────────────────────────────────────────────────

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

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));

  // An Airtable connector on a Personal Access Token: its client goes through
  // the global `fetch`, so the test sees every request it makes.
  const [conn] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: 'Airtable',
      slug: 'airtable',
      authType: 'api_key',
      active: true,
      apiKey: encrypt('pat-connector-approval-test'),
    })
    .returning();
  if (!conn) throw new Error('Failed to insert connector');
  await db.insert(agentConnectorAssignments).values({
    agentId: seed.agentId,
    connectorId: conn.id,
    entityId: seed.entityId,
    enabledOperations: ['airtable_delete_record'],
  });
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  vi.restoreAllMocks();
});

function makeDeps(client: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(client);
  return {
    db: db as RunnerDeps['db'],
    llmClient: client,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

describe('a connector operation marked requiresApproval, on the real job loop @cap:approuver-une-action/moteur', () => {
  it('suspends with a pending request and no Airtable call; once approved, deletes exactly once and completes', async () => {
    const airtableCalls: Array<{ method: string; url: string }> = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('api.airtable.com')) return realFetch(input, init);
      airtableCalls.push({ method: init?.method ?? 'GET', url });
      return new Response(JSON.stringify({ id: 'recTARGET', deleted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Delete the duplicate record',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create test job');

    const client = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-del',
            toolName: 'airtable_delete_record',
            args: {
              baseId: 'appBASE',
              tableIdOrName: 'Contacts',
              recordId: 'recTARGET',
              purpose: 'Remove the duplicate contact the owner pointed out.',
            },
          },
        ],
      },
      {
        text: 'Deleted.',
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const first = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(first.status).toBe('awaiting_approval');
    const pending = await db
      .select({
        id: approvalRequests.id,
        toolName: approvalRequests.toolName,
        status: approvalRequests.status,
        toolInput: approvalRequests.toolInput,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    expect(pending.map((r) => ({ toolName: r.toolName, status: r.status }))).toEqual([
      { toolName: 'airtable_delete_record', status: 'pending' },
    ]);
    expect(pending[0]?.toolInput).toMatchObject({ recordId: 'recTARGET' });
    expect(airtableCalls).toEqual([]);

    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, pending[0]!.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    const resumed = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(resumed.status).toBe('completed');
    expect(airtableCalls).toEqual([
      { method: 'DELETE', url: 'https://api.airtable.com/v0/appBASE/Contacts/recTARGET' },
    ]);
    const after = await db
      .select({ status: approvalRequests.status, executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    // One request, executed: the resume did not ask again.
    expect(after).toHaveLength(1);
    expect(after[0]?.executedAt).not.toBeNull();
  });
});
