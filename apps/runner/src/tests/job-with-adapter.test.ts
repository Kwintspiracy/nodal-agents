// job-with-adapter.test.ts — integration test for connector adapter tool injection
//
// Tests:
//  - Agent assigned to Google Drive connector executes a job.
//    The mocked LLM calls drive_list_files, then return_result.
//    Asserts the tool_calls row is written with tool_name = 'drive_list_files'.
//  - enabledOperations=null (all tools available) — job succeeds with drive tool called.

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
      if (!active) throw new Error('job-with-adapter.test: no active LLM client set');
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

      // AI SDK v6 returns `content: Array<LanguageModelV3Content>` mixing text
      // and tool-call parts. Build the array from the test's text/toolCalls.
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
};

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let credentialId: string;
let connectorId: string;

beforeAll(async () => {
  // Set up encryption key so getDecryptedCredentialById can decrypt
  _setMasterKeyForTests(randomBytes(32));

  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Make agent a worker
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));

  // Insert an encrypted Google OAuth credential
  const payload = {
    accessToken: 'test-google-access-token',
    refreshToken: 'test-google-refresh-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scope: 'https://www.googleapis.com/auth/drive',
    accountName: 'test@example.com',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/drive',
  };
  const [credRow] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: 'Test Google Drive',
      type: 'google-oauth',
      payload: encrypt(JSON.stringify(payload)),
    })
    .returning();
  if (!credRow) throw new Error('Failed to insert credential');
  credentialId = credRow.id;

  // Insert a Google Drive connector linked to the credential
  const [connRow] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: 'Google Drive',
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

describe('job-with-adapter: Drive connector fully enabled (enabledOperations=null)', () => {
  it('tool_calls row is written for drive_list_files when LLM calls it', async () => {
    // Assign the Drive connector to the agent — null = all operations enabled
    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: null,
      })
      .onConflictDoNothing();

    // Mock Google Drive API so drive_list_files doesn't make real HTTP calls
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ files: [{ id: 'file-1', name: 'doc.txt' }] }), {
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
        task: 'List files in Drive',
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
            args: { query: 'name contains "doc"', pageSize: 5 },
          },
        ],
      },
      {
        toolCalls: [
          {
            // The mocked Drive call errors under this harness (googleapis uses
            // its own HTTP transport, not the global fetch spy), so the honest
            // terminal is 'blocked' — and Guard 3b (no-false-success) would
            // correctly refuse a 'success' claim while drive_list_files is
            // unresolved. This test only verifies wiring (the tool_calls row).
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'blocked' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // Primary assertion: tool_calls table must have a row for drive_list_files.
    // This proves the adapter was instantiated and the tool was available to the LLM.
    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));

    const toolNames = tcRows.map((r) => r.toolName);
    expect(toolNames).toContain('drive_list_files');

    fetchMock.mockRestore();

    // Clean up assignment for subsequent tests
    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });
});
