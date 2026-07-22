// job-google-oauth-refresh.test.ts — audit#2 M-12 regression
//
// Before the fix, execute.ts resolved a Google OAuth connector's access token
// ONCE at job setup (getDecryptedCredentialById called a single time) and
// baked that static string into the adapter's tools for the tool's entire
// lifetime via entry.toolFactory(accessToken). A job whose Google token
// expired mid-run (Google tokens live ~1h; IDLE_RESET is 4h) got a permanent
// gmail_unauthorized / drive_unauthorized even though the DB credential was
// still valid and refreshable.
//
// This test proves the fix at the seam that matters: when the LLM calls a
// Google-oauth-backed tool MULTIPLE times in the same job, the credential is
// re-read from the DB before each underlying network attempt — not captured
// once. We assert this by counting invocations of getDecryptedCredentialById
// (spied via a partial module mock), which is exactly what the resolver
// execute.ts now passes to entry.toolFactoryWithResolver calls on every
// resolution (see packages/runner-adapters/src/registry.ts and
// apps/runner/src/job/execute.ts).
//
// Before the fix: calling drive_list_files twice would still only invoke
// getDecryptedCredentialById ONCE (the one-shot setup read) — this test would
// have failed (call count stuck at 1) prior to the M-12 change.

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
      if (!active) throw new Error('job-google-oauth-refresh.test: no active LLM client set');
      return active;
    },
  };
});

// Spy on getDecryptedCredentialById while delegating to the real
// implementation — we need the REAL advisory-lock / decrypt behavior, just
// with visibility into how many times execute.ts calls it.
vi.mock('@nodal-agents/db', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/db')>();
  return {
    ...actual,
    getDecryptedCredentialById: vi.fn(actual.getDecryptedCredentialById),
  };
});

import { getDecryptedCredentialById } from '@nodal-agents/db';
const getDecryptedCredentialByIdMock = vi.mocked(getDecryptedCredentialById);

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

describe('job-google-oauth-refresh: M-12 — token resolved per-call, not once at setup', () => {
  it('getDecryptedCredentialById is invoked again for a second drive_list_files call in the same job', async () => {
    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: null,
      })
      .onConflictDoNothing();

    getDecryptedCredentialByIdMock.mockClear();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'List Drive files twice',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create test job');

    // Two separate turns each calling drive_list_files, before return_result.
    // The underlying gaxios HTTP call to Google will fail in this harness (no
    // real network) — that's fine, we only assert on how many times the
    // credential resolver ran, not on the tool's result.
    const client = makeMockLlmClient([
      {
        toolCalls: [{ toolCallId: 'tc-1', toolName: 'drive_list_files', args: { pageSize: 5 } }],
      },
      {
        toolCalls: [{ toolCallId: 'tc-2', toolName: 'drive_list_files', args: { pageSize: 5 } }],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Drive call unresolved under this harness' },
          },
        ],
      },
    ]);

    await executeJob(job.id as JobId, makeDeps(client), testEnv);

    // Filter to calls for THIS test's credential — other jobs / suites running
    // against the same shared mock share the module-level spy.
    const callsForThisCredential = getDecryptedCredentialByIdMock.mock.calls.filter(
      ([, id]) => id === credentialId,
    );

    // Before the M-12 fix, execute.ts resolved the token exactly ONCE per job
    // (the one-shot setup read) regardless of how many times the tool was
    // called — this assertion would have failed (stuck at 1).
    expect(callsForThisCredential.length).toBeGreaterThan(1);

    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });
});
