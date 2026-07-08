// tool-error-truncation-guard.test.ts — Fix #19 regression.
//
// toResultOutput (execute.ts) forces `type: 'text'` instead of `type: 'json'`
// once the serialized `{error: ...}` object exceeds MAX_TOOL_RESULT_CHARS
// (50K) — truncateForContext takes over. Before the fix, the sibling-tool-error
// guard (isToolErrorBlock) only recognized `type: 'json'` errors, so an
// oversized tool error in the same turn as return_result(status='success')
// slipped past it and the job finalized 'completed' despite the failed side
// effect — a direct violation of invariant #4 (no silent fallback / faux
// completed). This mirrors the existing "Brique 18.6" sibling-error tests in
// execute.test.ts, but forces the error through the >50K truncation path via
// a fake MCP tool whose execute() throws an oversized error (the same harness
// pattern as job-with-mcp-server.test.ts).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents, mcpServers, agentMcpServers } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Mock registries ──────────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _active = c;
    },
  };
});

const mcpMock = vi.hoisted(() => ({ createMcpTools: vi.fn() }));

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
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('tool-error-truncation-guard.test: no active LLM client set');
      return active;
    },
  };
});

// Mock only createMcpTools — this lets a test register an arbitrary
// ToolDefinition (including one whose execute() throws whatever we want)
// without needing a real MCP transport.
vi.mock('@nodal-agents/adapter-mcp', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/adapter-mcp')>();
  return {
    ...actual,
    createMcpTools: (...args: unknown[]) => mcpMock.createMcpTools(...args),
  };
});

// ─── LLM mock ─────────────────────────────────────────────────────────────────

function makeMockLlmClient(
  responses: Array<{
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
      const content: Array<{
        type: 'tool-call';
        toolCallId: string;
        toolName: string;
        input: string;
      }> = [];
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      return {
        content,
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
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

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let mcpServerId: string;
const FAKE_KEY = 'fake_testkey_456';

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));

  const [row] = await db
    .insert(mcpServers)
    .values({
      entityId: seed.entityId,
      name: 'Error Bay',
      slug: 'error-bay',
      transport: 'http',
      url: 'https://error-bay.example.com/api/mcp',
      apiKey: encrypt(FAKE_KEY),
      apiKeyLast4: '_456',
      authScheme: 'header',
      authParamName: 'x-api-key',
      active: true,
    })
    .returning();
  if (!row) throw new Error('Failed to insert mcp_servers row');
  mcpServerId = row.id;
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

const BIG_ERROR_TOOL_NAME = 'error_bay__blow_up';

/**
 * A tool whose execute() ALWAYS throws an error message well over
 * MAX_TOOL_RESULT_CHARS (50K) — the real-world shape a misbehaving connector
 * can produce (e.g. an upstream API dumping a huge stack trace/HTML error page
 * back at the agent). Uses varied, space-separated text (not a repeated run of
 * one character) so the base64-elision regex in truncateForContext does NOT
 * collapse it first — this specifically exercises the length-truncation path
 * (`[... truncated: ...]`), which is where Fix #19 lives.
 */
function fakeBigErrorTool() {
  return {
    name: BIG_ERROR_TOOL_NAME,
    description: 'Always fails with an oversized error',
    inputSchema: z.object({}),
    riskLevel: 'read' as const,
    execute: async () => {
      throw new Error('Error output line. '.repeat(3_000)); // ~60K chars
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('tool-error-truncation-guard: Fix #19', () => {
  it('a >50K tool error in the same turn as return_result(success) still blocks finalization', async () => {
    mcpMock.createMcpTools.mockReset();
    mcpMock.createMcpTools.mockResolvedValue({
      tools: [fakeBigErrorTool()],
      close: vi.fn().mockResolvedValue(undefined),
    });

    await db
      .insert(agentMcpServers)
      .values({ entityId: seed.entityId, agentId: seed.agentId, mcpServerId, enabledTools: null })
      .onConflictDoNothing();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Trigger the big error tool then report success',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    // Turn 1: [error_bay__blow_up (>50K error), return_result(success)] — the
    // guard must NOT let this finalize as completed. Turn 2: honest block.
    const client = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-big-error', toolName: BIG_ERROR_TOOL_NAME, args: {} },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr2',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'blow_up tool failed, cannot proceed' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);

    // Real assertion on status: NOT falsely 'completed'.
    expect(result.status).toBe('failed');

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    // The guard forced a second turn before finalization (LLM called twice) —
    // without Fix #19 the job would have finalized 'completed' on turn 1.
    expect(rows[0]?.turn).toBe(2);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.result).toBe('blow_up tool failed, cannot proceed');

    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
  });
});
