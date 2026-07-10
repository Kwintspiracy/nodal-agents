// job-with-mcp-server.test.ts — regression for the MCP resolver path.
//
// The worker tool-assembly block in execute.ts must, for each assigned MCP
// server: decrypt mcp_servers.api_key, connect via createMcpTools, merge the
// discovered tools into the agent's toolset, and skip a server silently when
// its credential is missing. createMcpTools is mocked — no live MCP server.

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
import { eq, agentJobs, agents, mcpServers, agentMcpServers, toolCalls } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { executeJob } from '../job/execute.ts';
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

const mcpMock = vi.hoisted(() => ({ createMcpTools: vi.fn(), createLazyMcpTools: vi.fn() }));

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
      if (!active) throw new Error('job-with-mcp-server.test: no active LLM client set');
      return active;
    },
  };
});

// Mock only createMcpTools — slugToPrefix stays real so the runner's
// prefix-stripping logic is exercised genuinely.
vi.mock('@nodal-agents/adapter-mcp', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/adapter-mcp')>();
  return {
    ...actual,
    createMcpTools: (...args: unknown[]) => mcpMock.createMcpTools(...args),
    createLazyMcpTools: (...args: unknown[]) => mcpMock.createLazyMcpTools(...args),
  };
});

// ─── LLM mock ─────────────────────────────────────────────────────────────────

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
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
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

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let mcpServerId: string;
const COGNI_KEY = 'cog_testkey123';

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
      name: 'Cogni Cortex',
      slug: 'cogni-cortex',
      transport: 'http',
      url: 'https://cogni.example.com/api/mcp',
      apiKey: encrypt(COGNI_KEY),
      apiKeyLast4: 'y123',
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

/** A NodalAI ToolDefinition shaped like a wrapped MCP tool. */
function fakeMcpTool() {
  return {
    name: 'cogni_cortex__get_home',
    description: 'Cogni home view',
    inputSchema: z.object({}),
    riskLevel: 'read' as const,
    execute: async () => [{ type: 'text', text: '{"energy":100,"designation":"Tester"}' }],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('job-with-mcp-server: MCP resolver path', () => {
  it('decrypts the key, connects, and the agent can call the discovered MCP tool', async () => {
    mcpMock.createMcpTools.mockReset();
    const close = vi.fn().mockResolvedValue(undefined);
    let receivedKey: string | null = null;
    mcpMock.createMcpTools.mockImplementation(async (opts: { apiKey: string }) => {
      receivedKey = opts.apiKey;
      return { tools: [fakeMcpTool()], close };
    });

    await db
      .insert(agentMcpServers)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        mcpServerId,
        enabledTools: null, // all tools
      })
      .onConflictDoNothing();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Read my Cogni home',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    const client = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-home', toolName: 'cogni_cortex__get_home', args: {} }] },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // createMcpTools received the DECRYPTED key, never the ciphertext.
    expect(receivedKey).toBe(COGNI_KEY);
    // The transport was closed in the loop's finally.
    expect(close).toHaveBeenCalled();

    // A real tool_calls row proves the MCP tool actually executed.
    const tcRows = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, job.id));
    expect(tcRows.map((r) => r.toolName)).toContain('cogni_cortex__get_home');

    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
  });

  it('skips the MCP server silently when its api_key is missing', async () => {
    mcpMock.createMcpTools.mockReset();
    mcpMock.createMcpTools.mockResolvedValue({ tools: [fakeMcpTool()], close: vi.fn() });

    await db.update(mcpServers).set({ apiKey: null }).where(eq(mcpServers.id, mcpServerId));
    await db
      .insert(agentMcpServers)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        mcpServerId,
        enabledTools: null,
      })
      .onConflictDoNothing();

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'Should not reach Cogni',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    // The MCP tool must not be in the map → the LLM just answers with text.
    const client = makeMockLlmClient([{ text: 'No Cogni access available.' }]);
    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // api_key missing → the runner skipped the server before connecting.
    expect(mcpMock.createMcpTools).not.toHaveBeenCalled();

    await db
      .update(mcpServers)
      .set({ apiKey: encrypt(COGNI_KEY) })
      .where(eq(mcpServers.id, mcpServerId));
    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
  });
});

// ─── Lot A3: lazy MCP connect ──────────────────────────────────────────────────
// mcp_servers.available_tools gates whether execute.ts builds a lazy toolset
// (createLazyMcpTools — no connection at build time) or falls back to the
// eager path (createMcpTools) and writes back a fresh cache. Both factories
// are mocked; only the runner's cache-v2 decision (isUsableMcpToolCache) and
// its write-back call are under test here — the factories themselves are
// covered in packages/adapters/mcp/src/tests/lazy-tools.test.ts.

describe('job-with-mcp-server: Lot A3 — lazy MCP connect cache', () => {
  it('a usable v2 cache (every tool carries inputSchema) builds a lazy toolset — createMcpTools (eager) is never called', async () => {
    mcpMock.createMcpTools.mockReset();
    mcpMock.createLazyMcpTools.mockReset();
    const close = vi.fn().mockResolvedValue(undefined);
    mcpMock.createLazyMcpTools.mockReturnValue({ tools: [fakeMcpTool()], descriptors: [], close });

    await db
      .update(mcpServers)
      .set({
        availableTools: [
          {
            name: 'get_home',
            description: 'Cogni home view',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })
      .where(eq(mcpServers.id, mcpServerId));
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
        task: 'Read my Cogni home (v2 cache)',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    const client = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-home', toolName: 'cogni_cortex__get_home', args: {} }] },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    // The lazy factory was used, and the eager one — which would pay the
    // full connect cost — was never invoked.
    expect(mcpMock.createLazyMcpTools).toHaveBeenCalledOnce();
    expect(mcpMock.createMcpTools).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();

    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
    await db.update(mcpServers).set({ availableTools: null }).where(eq(mcpServers.id, mcpServerId));
  });

  it('a stale v1 cache ({name, description} only) takes the eager path and writes back full v2 descriptors', async () => {
    mcpMock.createMcpTools.mockReset();
    mcpMock.createLazyMcpTools.mockReset();
    const close = vi.fn().mockResolvedValue(undefined);
    const freshDescriptors = [
      {
        name: 'get_home',
        description: 'Cogni home view',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ];
    mcpMock.createMcpTools.mockResolvedValue({
      tools: [fakeMcpTool()],
      descriptors: freshDescriptors,
      close,
    });

    // v1 cache — no inputSchema — must be rejected by isUsableMcpToolCache.
    await db
      .update(mcpServers)
      .set({ availableTools: [{ name: 'get_home', description: 'Cogni home view' }] })
      .where(eq(mcpServers.id, mcpServerId));
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
        task: 'Read my Cogni home (v1 cache upgrade)',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    const client = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-home', toolName: 'cogni_cortex__get_home', args: {} }] },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    expect(mcpMock.createMcpTools).toHaveBeenCalledOnce();
    expect(mcpMock.createLazyMcpTools).not.toHaveBeenCalled();

    // The real behavior under test: available_tools got auto-upgraded to the
    // full v2 shape (inputSchema included) — the NEXT job for this server
    // would now take the lazy path.
    const [row] = await db
      .select({ availableTools: mcpServers.availableTools })
      .from(mcpServers)
      .where(eq(mcpServers.id, mcpServerId));
    expect(row?.availableTools).toEqual(freshDescriptors);

    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
    await db.update(mcpServers).set({ availableTools: null }).where(eq(mcpServers.id, mcpServerId));
  });

  it('an eager connect failure is logged loud (slug + id) and the job completes without that server', async () => {
    // No cache (availableTools null after the previous test) → the eager
    // path runs and rejects. Before this fix the catch was bare — a broken
    // MCP server vanished with zero trace anywhere in the logs.
    mcpMock.createMcpTools.mockReset();
    mcpMock.createLazyMcpTools.mockReset();
    mcpMock.createMcpTools.mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
        task: 'Cogni is down, answer without it',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create job');

    // The MCP tool never makes it into the whitelist → the LLM just answers with text.
    const client = makeMockLlmClient([{ text: 'Cogni is unreachable right now.' }]);
    const result = await executeJob(job.id as JobId, makeDeps(client), testEnv);
    expect(result.status).toBe('completed');

    const loggedMcpFailure = errorSpy.mock.calls.some(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('cogni-cortex') &&
        args[0].includes(mcpServerId) &&
        args[0].includes('ECONNREFUSED'),
    );
    expect(loggedMcpFailure).toBe(true);

    errorSpy.mockRestore();
    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, seed.agentId));
  });
});
