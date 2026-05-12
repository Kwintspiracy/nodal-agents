// job-with-apikey-adapter.test.ts — regression test for the api_key resolver path
//
// Brique 34quinquies wired api_key connectors (PATs / API keys stored in
// connectors.api_key) to the adapter registry. The resolver in execute.ts
// must:
//   - decrypt connectors.api_key for entries with credentialType === 'api_key'
//   - use credentials.payload.accessToken otherwise (already covered by
//     job-with-adapter-filtered.test.ts)
//
// We use Airtable PAT (slug 'airtable') because the same adapter is wired for
// both 'airtable-oauth' (OAuth) and 'airtable' (PAT), so any divergence is
// guaranteed to come from the resolver, not the adapter.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText } from 'ai';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests, encrypt } from '@nodalai/secrets';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import {
  eq,
  agentJobs,
  agents,
  connectors,
  agentConnectorAssignments,
  toolCalls,
} from '@nodalai/db';
import { createToolRegistry, registerBuiltins } from '@nodalai/tools';
import { createEmbeddingClient } from '@nodalai/llm';
import { LocalTrustProvider } from '@nodalai/auth';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { executeJob } from '../job/execute.ts';
import type { JobId } from '@nodalai/orchestration';

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

vi.mock('@nodalai/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodalai/delivery')>();
  return { ...actual, sendTelegramMessage: vi.fn().mockResolvedValue({ messageId: 999 }) };
});

vi.mock('@nodalai/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodalai/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('job-with-apikey-adapter.test: no active LLM client set');
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
  const mockModel = new MockLanguageModelV1({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const toolCallsRaw = response.toolCalls?.map((tc) => ({
        toolCallType: 'function' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: JSON.stringify(tc.args),
      }));
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: toolCallsRaw && toolCallsRaw.length > 0 ? 'tool-calls' : 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
        text: response.text ?? undefined,
        toolCalls: toolCallsRaw ?? [],
        content: response.text ? [{ type: 'text' as const, text: response.text }] : [],
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
      generateText({ ...args, model: mockModel }) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
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
};

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let connectorId: string;
const AIRTABLE_PAT = 'patTESTAirtable123';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));

  // Airtable PAT connector — token lives in connectors.api_key (encrypted),
  // no credentials row, credentialId is NULL.
  const [connRow] = await db
    .insert(connectors)
    .values({
      entityId: seed.entityId,
      name: 'Airtable PAT',
      slug: 'airtable',
      authType: 'api_key',
      active: true,
      apiKey: encrypt(AIRTABLE_PAT),
    })
    .returning();
  if (!connRow) throw new Error('Failed to insert airtable connector');
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

describe('job-with-apikey-adapter: api_key resolver path', () => {
  it('decrypts connectors.api_key and instantiates adapter tools (airtable PAT)', async () => {
    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: ['airtable_list_bases'],
      })
      .onConflictDoNothing();

    // Capture the Authorization header so we assert the resolver decrypted
    // connectors.api_key (not the ciphertext) and passed it to the adapter.
    let observedAuthHeader: string | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      observedAuthHeader = headers.get('authorization');
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toContain('api.airtable.com');
      return new Response(JSON.stringify({ bases: [{ id: 'app123', name: 'Test base' }] }), {
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
        task: 'List bases via airtable PAT',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    const client = makeMockLlmClient([
      {
        toolCalls: [{ toolCallId: 'tc-list', toolName: 'airtable_list_bases', args: {} }],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // The bearer must be the *decrypted* PAT, never the ciphertext.
    expect(observedAuthHeader).toBe(`Bearer ${AIRTABLE_PAT}`);

    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));
    expect(tcRows.map((r) => r.toolName)).toContain('airtable_list_bases');

    fetchMock.mockRestore();
    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });

  it('skips the connector silently when api_key column is empty (no token, no error)', async () => {
    // Replace the encrypted apiKey with empty — simulates "connector created but
    // user never saved a token yet" (shouldn't crash, just no adapter tools).
    await db.update(connectors).set({ apiKey: null }).where(eq(connectors.id, connectorId));

    await db
      .insert(agentConnectorAssignments)
      .values({
        agentId: seed.agentId,
        connectorId,
        entityId: seed.entityId,
        enabledOperations: ['airtable_list_bases'],
      })
      .onConflictDoNothing();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Should not reach airtable',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    // Mock LLM just answers with text — no tool calls, since the adapter
    // shouldn't be in the tool map (api_key missing).
    const client = makeMockLlmClient([{ text: 'No airtable access available.' }]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // Restore for any later tests in this file.
    await db
      .update(connectors)
      .set({ apiKey: encrypt(AIRTABLE_PAT) })
      .where(eq(connectors.id, connectorId));
    await db
      .delete(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
  });
});
