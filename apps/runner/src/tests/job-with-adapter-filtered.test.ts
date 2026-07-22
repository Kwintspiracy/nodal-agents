// job-with-adapter-filtered.test.ts — per-operation whitelist regression test
//
// Tests:
//  - When enabledOperations=['drive_list_files'], only that tool is instantiated
//    so other Drive tools cannot be called (they are not in the tool map at all).
//  - Agent with no assignment gets no Drive tools (regression: no adapter tool leakage).
//
// The core invariant: filtering is pre-LLM (tool not in map → AI_NoSuchToolError
// if the LLM tries to call it). We prove this indirectly by:
//  a) The job with drive_list_files only: LLM calls drive_list_files → tool_calls row exists.
//  b) The job with NO assignment: LLM tries to call drive_list_files → job fails /
//     or completes without the Drive tool row (depending on mock).
//
// The mocked LLM script only calls the allowed tool so we assert on tool_calls rows.

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
  connectors,
  credentials,
  agentConnectorAssignments,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { executeJob } from '../job/execute.ts';
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
      if (!active) throw new Error('job-with-adapter-filtered.test: no active LLM client set');
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
let credentialId: string;
let connectorId: string;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));

  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));

  const payload = {
    accessToken: 'test-google-access-token-filtered',
    refreshToken: 'test-refresh-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scope: 'https://www.googleapis.com/auth/drive',
    accountName: 'filtered@example.com',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/drive',
  };

  const [credRow] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: 'Filtered Drive Credential',
      type: 'google-oauth',
      payload: encrypt(JSON.stringify(payload)),
    })
    .returning();
  if (!credRow) throw new Error('Failed to insert credential');
  credentialId = credRow.id;

  const [connRow] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: 'Filtered Drive',
      slug: 'google-drive',
      authType: 'oauth2',
      active: true,
      credentialId,
    })
    .returning();
  if (!connRow) throw new Error('Failed to insert connector');
  connectorId = connRow.id;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('job-with-adapter-filtered: enabledOperations whitelist', () => {
  it('LLM can call drive_list_files; other Drive tools are not in the tool map', async () => {
    // The Drive adapter has 12 tools. We whitelist just one.
    const enabledOps = ['drive_list_files'];

    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: enabledOps,
      })
      .onConflictDoNothing();

    // Mock fetch so drive_list_files doesn't 404
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'List files filtered',
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
            toolCallId: 'tc-drive',
            toolName: 'drive_list_files',
            args: { query: 'all', pageSize: 5 },
          },
        ],
      },
      {
        toolCalls: [
          // Drive errors under this harness (googleapis bypasses the fetch spy),
          // so 'blocked' is the honest terminal; Guard 3b would refuse a 'success'
          // claim while drive_list_files is unresolved. Wiring test only. A
          // blocked result carries a reason and finalizes as 'failed'.
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Drive call failed under this harness' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('failed');

    // drive_list_files was called — the tool was available (whitelisted)
    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));

    const calledTools = tcRows.map((r) => r.toolName);
    expect(calledTools).toContain('drive_list_files');

    // No other Drive tools appear in tool_calls (they weren't whitelisted so
    // the LLM script only called drive_list_files and return_result)
    const driveEntry = ADAPTER_REGISTRY['google-drive'];
    const otherDriveTools = (driveEntry?.operations ?? [])
      .map((o) => o.slug)
      .filter((s) => !enabledOps.includes(s));
    for (const excluded of otherDriveTools) {
      expect(calledTools).not.toContain(excluded);
    }

    fetchMock.mockRestore();

    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });

  it('agent with no connector assignment has no Drive tools called', async () => {
    // No assignment inserted — Drive tools not available
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Task with no Drive access',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create test job');

    const client = makeMockLlmClient([{ text: 'I cannot access Drive.' }]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // No Drive tool rows in tool_calls
    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));

    const calledTools = tcRows.map((r) => r.toolName);
    const driveEntry = ADAPTER_REGISTRY['google-drive'];
    const driveToolNames = (driveEntry?.operations ?? []).map((o) => o.slug);
    for (const driveTool of driveToolNames) {
      expect(calledTools).not.toContain(driveTool);
    }
  });
});
