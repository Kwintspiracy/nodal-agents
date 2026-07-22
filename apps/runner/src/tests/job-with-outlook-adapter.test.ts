// job-with-outlook-adapter.test.ts — integration test for Outlook Mail connector tool injection
//
// Mirrors job-with-adapter.test.ts (Google Drive) for the outlook-mail
// adapter: an agent assigned to an outlook-mail connector (backed by a
// microsoft-oauth credential) executes a job where the mocked LLM calls
// outlook_list_messages, then return_result. Asserts the tool_calls row is
// written with tool_name = 'outlook_list_messages' — proving the adapter was
// instantiated from the DB-resolved credential and the tool reached the
// LLM's whitelist.

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
      if (!active) throw new Error('job-with-outlook-adapter.test: no active LLM client set');
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
  PORT: 3097,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3097',
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

  // Insert an encrypted Microsoft OAuth credential
  const payload = {
    accessToken: 'test-microsoft-access-token',
    refreshToken: 'test-microsoft-refresh-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scope: 'Mail.ReadWrite Mail.Send offline_access',
    accountName: 'test@example.com',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'Mail.ReadWrite Mail.Send offline_access',
  };
  const [credRow] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: 'Test Outlook Mail',
      type: 'microsoft-oauth',
      payload: encrypt(JSON.stringify(payload)),
    })
    .returning();
  if (!credRow) throw new Error('Failed to insert credential');
  credentialId = credRow.id;

  // Insert an Outlook Mail connector linked to the credential
  const [connRow] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: 'Outlook Mail',
      slug: 'outlook-mail',
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

describe('job-with-outlook-adapter: Outlook Mail connector fully enabled (enabledOperations=null)', () => {
  it('tool_calls row is written for outlook_list_messages when LLM calls it', async () => {
    // Assign the outlook-mail connector to the agent — null = all operations enabled
    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: null,
      })
      .onConflictDoNothing();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'List messages in Outlook',
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
            toolCallId: 'tc-outlook',
            toolName: 'outlook_list_messages',
            args: { query: 'invoice', max_results: 5 },
          },
        ],
      },
      {
        toolCalls: [
          {
            // The mocked Graph call errors under this harness (the Graph SDK
            // makes its own network call — no fetch spy wired here — same
            // pattern as job-with-adapter.test.ts's Drive scenario), so the
            // honest terminal is 'blocked' — Guard 3b (no-false-success) would
            // correctly refuse a 'success' claim while outlook_list_messages
            // is unresolved. This test only verifies wiring (the tool_calls
            // row). A blocked result must carry a reason; it finalizes as
            // 'failed' (error='agent_blocked') with the reason surfaced.
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Outlook call failed under this harness' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('failed');

    // Primary assertion: tool_calls table must have a row for outlook_list_messages.
    // This proves the adapter was instantiated and the tool was available to the LLM.
    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));

    const toolNames = tcRows.map((r) => r.toolName);
    expect(toolNames).toContain('outlook_list_messages');

    // Clean up assignment for subsequent tests
    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });
});
