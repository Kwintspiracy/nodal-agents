// execute.test.ts — full E2E job loop with mocked LLM, asserts each transition
// Tests:
//   - pending → processing → completed on return_result
//   - anti-loop: 51 tool_use blocks → tool_call_limit_exceeded
//   - tool whitelist violation → whitelist_violation:tool_name
//   - awaiting_approval does NOT bump chain_count

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentAssignments,
  approvalRequests,
  approvalRules,
  agentMemory,
  chatMessages,
  conversations,
  entities,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { DeliveryError } from '@nodal-agents/delivery';
import { findModelCatalogEntry } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import {
  executeJob,
  describeUnavailableTool,
  shortBlockReason,
  BLOCK_NO_REASON,
} from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { VERIFY_BEFORE_ASSERT_NUDGE } from '@nodal-agents/orchestration';

// ─── Module-level mock registry ───────────────────────────────────────────────
// Approval-gate regression imports (used in the approval-gate describe block below)
// execute.ts calls createLlmClient() directly (Brique 25: no env fallback).
// We intercept that call here and forward to the per-test mock client.
// vi.hoisted ensures the factory runs before module imports are resolved.
const { sendTelegramMessageMock, sendTelegramPhotoMock, getActiveLlmClient, setActiveLlmClient } =
  vi.hoisted(() => {
    let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
    return {
      sendTelegramMessageMock: vi.fn().mockResolvedValue({ messageId: 999 }),
      sendTelegramPhotoMock: vi.fn().mockResolvedValue({ messageId: 998 }),
      getActiveLlmClient: () => _activeLlmClient,
      setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
        _activeLlmClient = c;
      },
    };
  });

// S3 (multichannel plan): the 6 delivery tools + notify.ts now dispatch
// through getAdapter(...).sendText/sendMedia/sendApprovalCard rather than
// calling sendTelegramMessage/sendTelegramPhoto directly — telegramAdapter's
// own methods import those from a RELATIVE path inside @nodal-agents/delivery,
// so overriding the package's named exports (as this mock did pre-S3) no
// longer intercepts anything. The fake adapter below reproduces
// telegramAdapter's exact wire shape (see channels/telegram-adapter.ts) but
// forwards into the SAME sendTelegramMessageMock/sendTelegramPhotoMock so
// every existing assertion in this file keeps working unchanged.
const fakeTelegramAdapter = {
  channel: 'telegram' as const,
  capabilities: { buttons: true, threads: false, media: true, editMessage: true },
  async sendText(creds: { botToken: string }, chatId: string, text: string) {
    const r = await sendTelegramMessageMock({ chatId, text, botToken: creds.botToken });
    return { messageId: String(r.messageId) };
  },
  async sendMedia(
    creds: { botToken: string },
    chatId: string,
    media: { bytes: unknown; filename: string; caption?: string },
  ) {
    const r = await sendTelegramPhotoMock({
      chatId,
      botToken: creds.botToken,
      photo: media.bytes,
      filename: media.filename,
      caption: media.caption,
    });
    return { messageId: String(r.messageId) };
  },
  async sendApprovalCard(
    creds: { botToken: string },
    chatId: string,
    card: { text: string; approveLabel: string; rejectLabel: string; callbackId: string },
  ) {
    const inlineKeyboard = [
      [
        { text: card.approveLabel, callback_data: `${card.callbackId}:a` },
        { text: card.rejectLabel, callback_data: `${card.callbackId}:r` },
      ],
    ];
    const r = await sendTelegramMessageMock({
      chatId,
      botToken: creds.botToken,
      text: card.text,
      inlineKeyboard,
    });
    return { messageId: String(r.messageId) };
  },
};

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return {
    ...actual,
    sendTelegramMessage: sendTelegramMessageMock,
    sendTelegramPhoto: sendTelegramPhotoMock,
    getAdapter: () => fakeTelegramAdapter,
  };
});

// Intercept createLlmClient called by execute.ts so it returns the per-test mock.
// createEmbeddingClient and all other exports are passed through unchanged.
vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active)
        throw new Error('execute.test: no active LLM client set — call setActiveLlmClient() first');
      return active;
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockLlmClient(
  responses: Array<{
    text?: string;
    reasoning?: string;
    promptTokens?: number;
    /** Cache-read subset of promptTokens — drives the public usage.cachedInputTokens. */
    cachedTokens?: number;
    /**
     * Simulated per-call billed cost in USD, as OpenRouter reports in
     * `providerMetadata.openrouter.usage.cost`. Drives Guard 1e in execute.ts.
     * When omitted, the mock returns no cost metadata (provider-silent path).
     */
    costUsd?: number;
    /**
     * Simulated upstream provider name as OpenRouter reports in
     * `providerMetadata.openrouter.provider`. Drives served-upstream observability
     * (P0-B) in execute.ts. When omitted the field is absent from providerMetadata.
     */
    providerName?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  }>,
  capturedPrompts?: unknown[],
  configOverride?: { provider: string; model: string },
  /** The keys of the `tools` object handed to the model each turn — the REAL whitelist. */
  capturedToolKeysPerCall?: string[][],
): RunnerDeps['llmClient'] {
  let callIndex = 0;

  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      // Record the prompt each call receives so a test can assert what actually
      // reached the provider (e.g. reasoning round-tripped from a prior turn).
      if (capturedPrompts) capturedPrompts.push(options.prompt);
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;

      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      // Reasoning part first — mirrors how a reasoning model streams: think, then act.
      if (response.reasoning) content.push({ type: 'reasoning', text: response.reasoning });
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
      // Simulate OpenRouter's providerMetadata.openrouter.usage.cost when the
      // test response specifies a costUsd. This is the exact path execute.ts reads
      // in Guard 1e: providerMetadata?.openrouter?.usage?.cost.
      // Also simulate providerMetadata.openrouter.provider (upstream name, P0-B).
      const hasMeta = response.costUsd !== undefined || response.providerName !== undefined;
      const providerMetadata = hasMeta
        ? {
            openrouter: {
              ...(response.costUsd !== undefined ? { usage: { cost: response.costUsd } } : {}),
              ...(response.providerName !== undefined ? { provider: response.providerName } : {}),
            },
          }
        : undefined;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: {
            total: response.promptTokens ?? 10,
            noCache: (response.promptTokens ?? 10) - (response.cachedTokens ?? 0),
            cacheRead: response.cachedTokens,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
        ...(providerMetadata ? { providerMetadata } : {}),
      };
    },
  });

  return {
    config: (configOverride ?? {
      provider: 'anthropic',
      model: 'mock',
    }) as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      if (capturedToolKeysPerCall) {
        const tools = (args as { tools?: Record<string, unknown> }).tools ?? {};
        capturedToolKeysPerCall.push(Object.keys(tools));
      }
      return generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

async function createTestJob(db: TestDb, seed: Awaited<ReturnType<typeof seedMinimal>>) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'Run a test task',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();

  if (!job) throw new Error('Failed to create test job');
  return job;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  // Make the agent a worker role (not orchestrator) so whitelist logic uses registry
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true }) // systemAgent = gets always-on tools
    .where(eq(agents.id, seed.agentId));
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);

  // Register the mock client so the vi.mock('@nodal-agents/llm') intercept returns it
  // when execute.ts calls createLlmClient() for this test (Brique 25).
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

/**
 * Build `n` turns that each call the same tool with DISTINCT tool-call ids
 * (real LLMs never reuse an id; reusing one trips the duplicate_tool_use
 * message-structure guard). Module-scoped so every describe block can use it.
 */
function repeatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  n: number,
): Array<{
  toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}> {
  return Array.from({ length: n }, (_v, i) => ({
    toolCalls: [{ toolCallId: `tc-${toolName}-${i}`, toolName, args }],
  }));
}

describe('describeUnavailableTool', () => {
  it('suggests the prefixed tool when the bad name is a dropped-prefix form', () => {
    const msg = describeUnavailableTool('store_memory', [
      'cogni_cortex_java__store_memory',
      'get_feed',
      'return_result',
    ]);
    expect(msg).toContain('not available to you');
    expect(msg).toContain('Did you mean: cogni_cortex_java__store_memory');
    // Lists the actual available tools so the model can pick the right one.
    expect(msg).toContain('get_feed');
  });

  it('omits the hint when nothing resembles the bad name', () => {
    const msg = describeUnavailableTool('frobnicate', ['get_feed', 'return_result']);
    expect(msg).not.toContain('Did you mean');
    expect(msg).toContain('get_feed, return_result');
  });
});

describe('shortBlockReason', () => {
  it('takes the first sentence of a multi-sentence reason (for the Error column)', () => {
    expect(
      shortBlockReason(
        'Énergie à 4 — insuffisant pour poster (coût 10) ou commenter (coût 5). La consigne dit post ou comment.',
      ),
    ).toBe('Énergie à 4 — insuffisant pour poster (coût 10) ou commenter (coût 5).');
  });

  it('returns a one-phrase reason unchanged', () => {
    expect(shortBlockReason('Could not save the memory, stopping')).toBe(
      'Could not save the memory, stopping',
    );
  });

  it('caps an over-long first sentence with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = shortBlockReason(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to a readable message when the reason is empty', () => {
    expect(shortBlockReason('')).toBe(BLOCK_NO_REASON);
    expect(shortBlockReason('   ')).toBe(BLOCK_NO_REASON);
  });
});

describe('executeJob', () => {
  it('returns already_handled when job status is not pending/processing', async () => {
    const job = await createTestJob(db, seed);

    // Set to completed
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, job.id));

    const llmClient = makeMockLlmClient([]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('already_handled');
  });

  it('returns failed with job_not_found for nonexistent jobId', async () => {
    const llmClient = makeMockLlmClient([]);
    const result = await executeJob(
      '00000000-0000-0000-0000-000000000000' as JobId,
      makeDeps(llmClient),
      testEnv,
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('job_not_found');
    }
  });

  // ─── Invariant 8: delegation depth guard ──────────────────────────────────

  it('a job at max delegation depth RUNS but its delegation is refused, not killed (F1)', async () => {
    // F1: a job already at DEFAULT_LIMITS.maxDelegationDepth (3) is a leaf — it
    // must still do its OWN work; only DELEGATING further is refused. The old
    // guard failed such a job before it ran a single tool.
    // A FRESH orchestrator (not seed.agentId — don't pollute the shared seed for
    // later tests) with a real child worker, so `assign_<slug>` is a genuine
    // whitelisted tool (otherwise it's just an unavailable-tool nudge and never
    // reaches the depth-cap pre-check).
    const ts = Date.now();
    const [orch] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'F1 Orchestrator',
        slug: `f1-orch-${ts}`,
        personality: 'orch',
        llmKeyId: seed.llmKeyId,
        role: 'orchestrator',
        orchestratorMode: 'router',
        systemAgent: true,
      })
      .returning();
    const childSlug = `f1-child-${ts}`;
    const [child] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'F1 Child',
        slug: childSlug,
        personality: 'child',
        llmKeyId: seed.llmKeyId,
        role: 'agent',
        systemAgent: true,
      })
      .returning();
    await db.insert(agentAssignments).values({
      orchestratorId: orch!.id,
      subAgentId: child!.id,
      entityId: seed.entityId,
    });
    const assignTool = `assign_${childSlug.replace(/-/g, '_')}`;

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: orch!.id,
        channel: 'api',
        task: 'delegate again',
        status: 'pending',
        messages: [],
        chainCount: 0,
        delegationDepth: 3,
      })
      .returning();
    if (!job) throw new Error('Failed to create depth-exceeded test job');

    // Turn 1: the LLM tries to delegate — must be REFUSED with a tool_result,
    // not kill the job. Turn 2: it does the sensible thing and returns a result
    // → the job COMPLETES.
    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-a', toolName: assignTool, args: { task: 'sub' } }] },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // The job ran and completed — it was NOT failed at entry.
    expect(result.status).toBe('completed');

    // No child job was spawned — the delegation was refused, not performed.
    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, job.id));
    expect(children).toHaveLength(0);

    // The refusal reached the transcript as a tool_result the LLM could react to.
    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(JSON.stringify(row?.messages ?? [])).toContain('delegation_depth_exceeded');
  });

  it('a job BELOW the delegation depth max (0) is not blocked by the depth guard', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'a plain task',
        status: 'pending',
        messages: [],
        chainCount: 0,
        delegationDepth: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create depth-0 test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.error).toBeNull();
  });

  it('completes when LLM returns text only (no tools)', async () => {
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([{ text: 'Here is my answer to the task.' }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Verify DB row, including token usage / turn / duration persisted on completion
    const rows = await db
      .select({
        status: agentJobs.status,
        result: agentJobs.result,
        inputTokens: agentJobs.inputTokens,
        outputTokens: agentJobs.outputTokens,
        turn: agentJobs.turn,
        totalDurationMs: agentJobs.totalDurationMs,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toBe('Here is my answer to the task.');
    expect(rows[0]?.inputTokens).toBe(10);
    expect(rows[0]?.outputTokens).toBe(5);
    expect(rows[0]?.turn).toBe(1); // single LLM call → turn 1
    // Wall-clock timer: should have elapsed time (>= 0, often > 0). On very
    // fast runs Date.now() can resolve to the same ms, so assert non-null.
    expect(rows[0]?.totalDurationMs).not.toBeNull();
    expect(rows[0]?.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('integration: agent with telegramBotToken sends via telegram_send_message tool (outbound tool path)', async () => {
    // Set the seeded agent's telegramBotToken so telegram_send_message is injected
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Say hi on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram test job');

    // LLM calls telegram_send_message (omitting chatId — falls back to job.chatId)
    // then return_result to finish (Brique 33: status-only, no text)
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: 'hi' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');

    // Assert sendTelegramMessage was called with the real args (not a call count)
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'hi',
      botToken: 'fake-token',
    });

    // Clean up token so other tests aren't affected
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Anti-spam guard: consecutive delivery-only turns ─────────────────────

  it('anti-spam: caps consecutive delivery-only turns at maxConsecutiveDeliveryTurns and fails loud', async () => {
    // Regression for live incident job 9bbdbfd7 (2026-05-29): the agent emitted
    // 11 filler/emoji telegram_send_message turns in a row, never calling
    // return_result, spamming the user. The guard must cut it off.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [spamJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!spamJob) throw new Error('Failed to create spam test job');

    // Every turn is a single telegram_send_message and the LLM NEVER calls
    // return_result. Distinct toolCallIds keep the message structure valid
    // across turns. Six turns offered; the guard (default 3) must stop earlier.
    const deliveryOnly = (i: number) => ({
      toolCalls: [
        {
          toolCallId: `tc-spam-${i}`,
          toolName: 'telegram_send_message',
          args: { text: `msg ${i}` },
        },
      ],
    });
    const llmClient = makeMockLlmClient([
      deliveryOnly(1),
      deliveryOnly(2),
      deliveryOnly(3),
      deliveryOnly(4),
      deliveryOnly(5),
      deliveryOnly(6),
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(spamJob.id as JobId, makeDeps(llmClient), testEnv);

    // Guard fired: job failed loud with the dedicated code (invariant 4).
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('delivery_spam_guard');
    }

    // Real effect asserted (not a call count of the guard): the user received
    // at most maxConsecutiveDeliveryTurns (3) messages, NOT all 6 — the 4th
    // turn's send was blocked BEFORE execution.
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(3);
    expect(sendTelegramMessageMock).toHaveBeenLastCalledWith({
      chatId: '12345',
      text: 'msg 3',
      botToken: 'fake-token',
    });

    // DB row reflects the loud failure.
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, spamJob.id));
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('delivery_spam_guard');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Delivery guard: Telegram job must deliver before completing ──────────

  it('delivery guard: plain-text reply on a Telegram job is re-prompted, then delivered via the tool', async () => {
    // Regression for live incident job 5d84d72e (2026-05-29): the agent answered
    // in plain assistant text (no tool call) so nothing reached Telegram. The
    // guard must re-prompt and force a real telegram_send_message.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create delivery test job');

    // Turn 1: plain text, NO tool calls (the slip). Turn 2 (after nudge):
    // telegram_send_message + return_result (the correction).
    const llmClient = makeMockLlmClient([
      { text: 'Voici ma réponse en texte brut, non livrée.' },
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: 'la vraie réponse' },
          },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // Real effect: the reply WAS delivered (once), with the right args.
    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'la vraie réponse',
      botToken: 'fake-token',
    });

    // The nudge forced a second turn (turn 1 = slip, turn 2 = delivery).
    const rows = await db
      .select({ status: agentJobs.status, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.turn).toBe(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('cron confirmation: a cron job WITH a chatId (notify_on_success) forces the agent to deliver a confirmation', async () => {
    // notify_on_success opt-in: the cron tick sets chat_id, which makes the
    // runner hold a 'cron' job to the same delivery bar as Telegram — the agent
    // must send the user a confirmation before completing.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: '12345',
        task: 'Nettoyage quotidien',
        status: 'pending',
        messages: [{ role: 'user', content: 'Nettoyage quotidien' }],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create cron-notify test job');

    // Turn 1: the agent tries to finish WITHOUT confirming → must be nudged.
    // Turn 2: it sends the confirmation, then finishes.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg',
            toolName: 'telegram_send_message',
            args: { text: '✅ Nettoyage quotidien terminé.' },
          },
          { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    // The confirmation actually reached the user (real args, not a call count).
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: '✅ Nettoyage quotidien terminé.',
      botToken: 'fake-token',
    });

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('cron silence: a cron job WITHOUT a chatId (notify_on_success off) completes silently — no forced delivery', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: null, // notify_on_success was off → no delivery target
        task: 'Maintenance silencieuse',
        status: 'pending',
        messages: [{ role: 'user', content: 'Maintenance silencieuse' }],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create cron-silent test job');

    // The agent finishes immediately. With no chatId, the runner must NOT force
    // a delivery — the job completes silently.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Conversation-first chat: runChatTurn never creates a job ─────────────

  it('runChatTurn: replies in text, persists 2 chat_messages + titles the conversation, and creates ZERO agent_jobs', async () => {
    const jobsBefore = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));

    // A conversation must exist first (the sidebar entry).
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    const llmClient = makeMockLlmClient([{ text: 'Salut Quentin, je suis là.' }]);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'salut',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toContain('Salut Quentin');

    // The conversation turn is persisted in chat_messages (user + assistant).
    const msgs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    expect(msgs.length).toBe(2);
    expect(msgs.some((m) => m.role === 'user' && m.content === 'salut')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant' && (m.content?.length ?? 0) > 0)).toBe(true);

    // The first message auto-titles the conversation.
    const [titled] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(titled?.title).toBe('salut');

    // Crucially: NO agent_jobs row was created — chat is conversation, not a job.
    const jobsAfter = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    expect(jobsAfter.length).toBe(jobsBefore.length);
  });

  it('runChatTurn: run_task escalates to a real agent_jobs (dashboard channel) and links it on the assistant message', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // The model decides this turn requires an action → calls run_task.
    const llmClient = makeMockLlmClient([
      {
        text: 'On it — pulling the numbers.',
        toolCalls: [
          {
            toolCallId: 'tc-run-task',
            toolName: 'run_task',
            args: { instruction: 'pull Q2 financials and update the sheet' },
          },
        ],
      },
    ]);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'pull my Q2 numbers',
    });

    expect(result.ok).toBe(true);
    const spawnedJobId = result.ok ? result.spawnedJobId : undefined;
    expect(spawnedJobId).toBeTruthy();

    // A real job was created on the dashboard channel — the task is the instruction
    // the model chose, not the raw chat message.
    const [job] = await db
      .select()
      .from(agentJobs)
      .where(and(eq(agentJobs.id, spawnedJobId!), eq(agentJobs.channel, 'dashboard')));
    expect(job).toBeDefined();
    expect(job?.task).toBe('pull Q2 financials and update the sheet');
    // Jobs page grouping (migration 0059): the escalated job is stamped with
    // the dashboard conversation's own id, not re-derived from a heuristic.
    expect(job?.conversationId).toBe(conv.id);

    // The assistant chat message links back to that job (drives the dispatch card).
    const msgs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.jobId).toBe(spawnedJobId);
  });

  it('runChatTurn: a NARRATED action (text, no run_task) is recovered via a re-prompt → real job (regression for MiniMax escalation misses)', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // Turn 1: the model NARRATES ("Je lance X") with NO tool call — the MiniMax
    // slip (~1 in 5). The escalation-recovery re-prompt then yields run_task.
    const llmClient = makeMockLlmClient([
      { text: 'Je lance Displacer dans le Cortex.' },
      {
        toolCalls: [
          {
            toolCallId: 'tc-recheck',
            toolName: 'run_task',
            args: { instruction: 'Lancer Displacer dans le Cortex' },
          },
        ],
      },
    ]);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'envois Displacer dans le Cortex',
    });

    expect(result.ok).toBe(true);
    const spawnedJobId = result.ok ? result.spawnedJobId : undefined;
    // Recovered: a real job WAS created despite the first reply carrying no tool call.
    expect(spawnedJobId).toBeTruthy();

    const [job] = await db
      .select()
      .from(agentJobs)
      .where(and(eq(agentJobs.id, spawnedJobId!), eq(agentJobs.channel, 'dashboard')));
    expect(job).toBeDefined();
    expect(job?.task).toBe('Lancer Displacer dans le Cortex');

    // The agent's own narration is kept as the acknowledgment, linked to the job.
    const msgs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.jobId).toBe(spawnedJobId);
    expect(assistant?.content).toContain('Je lance Displacer');
  });

  it('runChatTurn: a prior ESCALATED turn is replayed to the LLM WITH its run_task call (un-poisons the history)', async () => {
    // Root cause of the MiniMax "narrates but does nothing" bug: the chat
    // persists only the text ack, so the history shows the agent "just
    // acknowledging in prose" and the model reproduces that pattern (measured
    // 2/6 escalation on a poisoned history vs 6/6 when escalations are shown).
    // The history builder must replay an escalated turn WITH its run_task call.
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');

    // Turn 1: the agent escalates → a real job + an assistant turn carrying jobId.
    const client1 = makeMockLlmClient([
      {
        text: 'Je lance Displacer.',
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'run_task',
            args: { instruction: 'HIST-INSTRUCTION-XYZ' },
          },
        ],
      },
    ]);
    const r1 = await runChatTurn({
      deps: makeDeps(client1),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'envois Displacer',
    });
    expect(r1.ok).toBe(true);

    // Turn 2: the history sent to the LLM must REPLAY turn 1's run_task call
    // (with its instruction), not a bare text ack.
    const capturedPrompts: unknown[] = [];
    const client2 = makeMockLlmClient([{ text: 'Et voilà.' }], capturedPrompts);
    await runChatTurn({
      deps: makeDeps(client2),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'encore',
    });
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);
    // The historical escalation (its run_task instruction) is in the prompt the
    // model actually received — the few-shot escalation pattern is preserved.
    expect(JSON.stringify(capturedPrompts[0])).toContain('HIST-INSTRUCTION-XYZ');
  });

  it('runChatTurn: a prior escalation is replayed with the job\'s REAL outcome (completion + content), not a static "dispatched"', async () => {
    // The bug Quentin hit: the run_task tool-result was hardcoded "Task
    // dispatched." forever, so the orchestrator could never tell a finished
    // delegation from a pending one — it looped on sequential work and never saw
    // what a dispatched agent produced (live: the Conciergus Cortex sequence).
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'seq' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // A prior escalation whose job COMPLETED with a real result.
    const [priorJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        status: 'completed',
        channel: 'dashboard',
        task: 'Run Displacer in the Cortex',
        result: 'DISPLACER-REPORT: read 20 posts, 3 comments, energy 31.',
        completedAt: new Date(),
      })
      .returning({ id: agentJobs.id });
    if (!priorJob) throw new Error('failed to create prior job');
    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'launch Displacer',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'On it.',
        jobId: priorJob.id,
      },
    ]);

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient([{ text: 'Displacer is done.' }], capturedPrompts);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'did Displacer finish?',
    });

    const flat = JSON.stringify(capturedPrompts);
    // The orchestrator now SEES the completion signal AND the content…
    expect(flat).toContain('Completed');
    expect(flat).toContain('DISPLACER-REPORT');
    // …and the blind static placeholder is gone.
    expect(flat).not.toContain('Task dispatched');
  });

  it('runChatTurn: a completed escalation surfaces the delegated child output (completeJob fills the parent, chat reflects it)', async () => {
    // Live forensic case end-to-end: a Conciergus delegation job finishes
    // without re-publishing a summary (own result empty) while the child holds
    // the real report. completeJob fills the parent from the child (the root
    // fix), and the chat history then carries that CONTENT to the orchestrator.
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'seq2' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    const [parent] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        status: 'processing',
        channel: 'dashboard',
        task: 'Assign work to the sub-agent',
        result: '', // the parent never re-published a summary of its own
      })
      .returning({ id: agentJobs.id });
    if (!parent) throw new Error('failed to create parent job');
    // The delegated child carries the actual output.
    await db.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      parentJobId: parent.id,
      status: 'completed',
      channel: 'internal',
      task: 'sub task',
      result: 'CHILD-OUTPUT: did the thing.',
      completedAt: new Date(),
    });
    // The real fix: completing the parent with no result of its own fills it
    // from the child, so the parent's `result` column carries the content.
    const { completeJob } = await import('../../job/state.ts');
    await completeJob(db as Parameters<typeof completeJob>[0], parent.id, '');
    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'go',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'Dispatched.',
        jobId: parent.id,
      },
    ]);

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient([{ text: 'ok' }], capturedPrompts);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'and now?',
    });

    const flat = JSON.stringify(capturedPrompts);
    // The child's content is surfaced even though the parent result was empty.
    expect(flat).toContain('CHILD-OUTPUT');
    expect(flat).not.toContain('Task dispatched');
  });

  it('runChatTurn: a phantom tool-call (tool not on this surface) recovers via a tool-free retry — text reply, no job', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    const jobsBefore = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));

    // Turn 1: the model calls a tool that does NOT exist on the chat surface
    // (query_memory) and emits no text. Turn 2 (the tool-free retry) replies.
    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-phantom', toolName: 'query_memory', args: { q: 'me' } }] },
      { text: 'You are Quentin, the builder of Nodal-Agents.' },
    ]);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'what do you know about me?',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toContain('Quentin');
      // It recovered as plain conversation — NOT an escalation.
      expect(result.spawnedJobId).toBeUndefined();
    }

    // No agent_jobs row — a recovered conversation is still conversation.
    const jobsAfter = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.agentId, seed.agentId));
    expect(jobsAfter.length).toBe(jobsBefore.length);

    // The recovered assistant reply is persisted.
    const msgs = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv.id));
    expect(msgs.some((m) => m.role === 'assistant' && (m.content ?? '').includes('Quentin'))).toBe(
      true,
    );
  });

  // ─── F-12 (audit #2): history bounded by char budget, not turn count ───────
  //
  // Before this fix, history was capped at HISTORY_LIMIT=20 TURNS regardless
  // of size — 20 large turns could still overflow the model's context window.
  // History is now bounded by a char budget (thread-history.ts's convention),
  // dropping the OLDEST turns first.
  //
  // Round 2 (post-review): per-message head+tail truncation is a LAST RESORT
  // — applied only if the conversation STILL exceeds the budget after
  // dropping every older turn it can. It is NOT an unconditional per-turn
  // cap: a short conversation that fits comfortably under budget must carry
  // every turn INTACT, including one large paste, or a user pasting a big
  // block of code/text into the chat would see it silently chopped even
  // though there was no overflow risk at all.

  it('runChatTurn: a single large turn passes INTACT when the whole conversation fits under budget', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // A short conversation (2 small prior pairs) plus ONE ~5000-char pasted
    // turn — total well under the 16KB budget, so nothing should be trimmed
    // OR truncated.
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    await db.insert(chatMessages).values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: 'hi',
        createdAt: new Date(base),
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'assistant',
        content: 'hello',
        createdAt: new Date(base + 1_000),
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role: 'user',
        content: `PASTE-HEAD-${'z'.repeat(5000)}-PASTE-TAIL`,
        createdAt: new Date(base + 2_000),
      },
    ]);

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient([{ text: 'got it' }], capturedPrompts);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'follow-up after the paste',
    });
    expect(result.ok).toBe(true);

    const promptStr = JSON.stringify(capturedPrompts[0]);
    // The full 5000-char run survives UNBROKEN — no truncation marker, no
    // gap between head and tail.
    expect(promptStr).toContain('PASTE-HEAD-' + 'z'.repeat(5000) + '-PASTE-TAIL');
    expect(promptStr).not.toContain('[…truncated…]');
  });

  it('runChatTurn: 20 heavy prior turns are trimmed under budget by dropping the OLDEST first', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // 20 prior (user, assistant) pairs of ~1KB each — well over the 16KB
    // history budget, so only the most recent handful should survive.
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 20; i++) {
      const t = new Date(base + i * 60_000);
      await db.insert(chatMessages).values([
        {
          entityId: seed.entityId,
          agentId: seed.agentId,
          conversationId: conv.id,
          role: 'user',
          content: `TURN-${i}-` + 'x'.repeat(1000),
          createdAt: t,
        },
        {
          entityId: seed.entityId,
          agentId: seed.agentId,
          conversationId: conv.id,
          role: 'assistant',
          content: `TURN-${i}-REPLY-` + 'x'.repeat(1000),
          createdAt: new Date(t.getTime() + 30_000),
        },
      ]);
    }

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient([{ text: 'ok' }], capturedPrompts);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: 'new message after 20 heavy prior turns',
    });
    expect(result.ok).toBe(true);

    const promptStr = JSON.stringify(capturedPrompts[0]);

    // Oldest turns dropped — nowhere near enough budget to keep them.
    expect(promptStr).not.toContain('TURN-0-');
    expect(promptStr).not.toContain('TURN-1-');
    // The most recent turns survive, fully intact (no truncation needed —
    // each individual message is small; only whole OLDER turns were cut).
    expect(promptStr).toContain('TURN-19-REPLY-' + 'x'.repeat(1000));
  });

  it('runChatTurn: a single turn that ALONE exceeds the budget is truncated head+tail as a last resort', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, title: '' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to create conversation');

    // No prior history at all — the CURRENT message itself is bigger than
    // the entire 16KB budget on its own (e.g. a huge first paste in a fresh
    // conversation). runChatTurn persists it as the user turn BEFORE loading
    // history (step 1b), so it becomes the sole history row; dropping older
    // turns can't help (there are none), so truncation must still fire to
    // avoid overflowing the model's context window.
    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient([{ text: 'ok' }], capturedPrompts);
    const { runChatTurn } = await import('../../chat/run-chat-turn.ts');
    const result = await runChatTurn({
      deps: makeDeps(llmClient),
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      message: `HEAD-MARKER-${'y'.repeat(20_000)}-TAIL-MARKER`,
    });
    expect(result.ok).toBe(true);

    const promptStr = JSON.stringify(capturedPrompts[0]);
    expect(promptStr).toContain('HEAD-MARKER-');
    expect(promptStr).toContain('-TAIL-MARKER');
    expect(promptStr).toContain('[…truncated…]');
    expect(promptStr).not.toContain('y'.repeat(2000));
  });

  it('delivery guard: persistent plain-text on a Telegram job fails loud (telegram_not_delivered), nothing sent', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create delivery-fail test job');

    // The model never uses the tool — every turn is plain text.
    const llmClient = makeMockLlmClient([{ text: 'texte brut, encore et toujours' }]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('telegram_not_delivered');
    }
    // Nothing was ever delivered to the user.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('telegram_not_delivered');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('delivery guard: return_result without any send on a Telegram job is re-prompted, then delivered', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create return_result-only test job');

    // Turn 1: return_result ALONE (no prior send). Turn 2: deliver + return_result.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'enfin livré' } },
          { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'enfin livré',
      botToken: 'fake-token',
    });
    const rows = await db
      .select({ turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.turn).toBe(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('delivery guard: recommended one-turn pattern [telegram_send_message, return_result] completes with no nudge', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Reply on Telegram',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create one-turn test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'pile poil' } },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('completed');
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    // No nudge: the whole job is a single turn.
    const rows = await db
      .select({ turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.turn).toBe(1);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Brique 18.6: sibling-tool-error guard ────────────────────────────────

  it('Brique 18.6: tool error in same turn as return_result blocks finalization, LLM gets fresh turn with error', async () => {
    // Set telegramBotToken so the tool is whitelisted
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    // An always-on tool that ERRORS (save_memory with invalid args) is the failing
    // sibling — the guard is about an error next to return_result, not which tool.
    // (Was telegram_send_message; that's now gated off channels with no recipient.)
    const [guardJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'Send telegram message',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!guardJob) throw new Error('Failed to create guard test job');

    // Turn 1: [save_memory (invalid args → errors), return_result(success)] — the
    // sibling error must block finalization. Turn 2: [return_result(blocked)].
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-bad', toolName: 'save_memory', args: {} },
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr2',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'save_memory failed, cannot proceed' },
          },
        ],
      },
    ]);

    const result = await executeJob(guardJob.id as JobId, makeDeps(llmClient), testEnv);

    // Job finalizes on turn 2, not turn 1. The honest block ends it as 'failed'.
    expect(result.status).toBe('failed');

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, guardJob.id));

    // LLM was called twice (turn === 2, not 1) — the invariant under test: the
    // sibling tool error forced a second turn before finalization.
    expect(rows[0]?.turn).toBe(2);
    expect(rows[0]?.status).toBe('failed');
    // The block reason is surfaced to the user via the result column.
    expect(rows[0]?.result).toBe('save_memory failed, cannot proceed');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 18.6: tool error WITHOUT return_result in same turn → loop continues unchanged (regression guard)', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [loopJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Send telegram message with retry',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!loopJob) throw new Error('Failed to create loop regression job');

    // First call throws, subsequent calls succeed
    sendTelegramMessageMock.mockClear();
    sendTelegramMessageMock.mockImplementationOnce(() => {
      throw new DeliveryError('telegram_rate_limited', 'Rate limited');
    });
    // Remaining calls use the default resolved mock (messageId: 999)

    // Turn 1: telegram_send_message only (no return_result) — mock throws once
    // Turn 2: telegram_send_message again — mock succeeds
    // Turn 3: return_result — finalize (Brique 33: status-only)
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg1', toolName: 'telegram_send_message', args: { text: 'first' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-tg2', toolName: 'telegram_send_message', args: { text: 'retry' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(loopJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Brique 33: result is empty — no dashboard_publish was called. The Telegram
    // delivery already happened via telegram_send_message, which is the correct path.
    // sendTelegramMessage called exactly twice: once errored (turn 1), once succeeded (turn 2)
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 18.6: tool success + return_result same turn → nominal finalization (regression guard)', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [happyJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Send and finalize',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!happyJob) throw new Error('Failed to create happy path job');

    // sendTelegramMessageMock resolves normally
    sendTelegramMessageMock.mockClear();
    sendTelegramMessageMock.mockResolvedValue({ messageId: 1 });

    // Single turn: [telegram_send_message (succeeds), return_result]
    // Brique 33: return_result is status-only; result column stays empty
    // because no dashboard_publish was called (delivery happened to Telegram).
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg', toolName: 'telegram_send_message', args: { text: 'hi' } },
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(happyJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ result: agentJobs.result, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, happyJob.id));

    // Delivery went to Telegram, not dashboard → result column stays null/empty
    expect(rows[0]?.result ?? '').toBe('');
    // LLM called only once — guard must NOT have triggered
    expect(rows[0]?.turn).toBe(1);
    // sendTelegramMessage called exactly once with correct args
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: '12345',
      text: 'hi',
      botToken: 'fake-token',
    });

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('accumulates token usage across multiple LLM turns', async () => {
    const job = await createTestJob(db, seed);

    // Two-turn scenario: first calls save_memory, second returns final text.
    // Mock returns 10/5 per call → expected 20/10 totals after 2 calls.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-1',
            toolName: 'save_memory',
            args: { fact: 'remembered', category: 'context' },
          },
        ],
      },
      { text: 'Done.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({
        inputTokens: agentJobs.inputTokens,
        outputTokens: agentJobs.outputTokens,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.inputTokens).toBe(20);
    expect(rows[0]?.outputTokens).toBe(10);
    expect(rows[0]?.turn).toBe(2); // two LLM calls → turn 2
  });

  it('completes when LLM calls dashboard_publish + return_result (Brique 33)', async () => {
    // Brique 33: return_result is status-only. The dashboard's `result` column
    // is populated by dashboard_publish (a delivery tool with a side-effect that
    // updates agent_jobs.result). When return_result fires alone with no prior
    // delivery tool, agent_jobs.result stays empty.
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-pub',
            toolName: 'dashboard_publish',
            args: { text: 'Task is done!' },
          },
          {
            toolCallId: 'tc-1',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('completed');
    // dashboard_publish's side-effect populated result; completeJob preserves it
    // (finalResult is '' from return_result, so completeJob doesn't overwrite).
    expect(rows[0]?.result).toBe('Task is done!');

    // Regression for the silent delegation-result loss bug: ExecuteJobResult.result
    // must carry the dashboard_publish text (not '') so resumeDelegated can inject
    // it into the parent's tool-result for assign_<sub>. Pre-fix, the runner
    // returned result:'' here and the parent orchestrator hallucinated answers
    // because it never saw what the sub-agent produced.
    if (result.status === 'completed') {
      expect(result.result).toBe('Task is done!');
    }
  });

  it('fails with no_tool_calls_no_text after exhausting empty-turn retries', async () => {
    const job = await createTestJob(db, seed);

    // The mock repeats its last response, so every attempt (initial + 2
    // retries) is empty → the retry budget is exhausted and the job fails loud.
    const llmClient = makeMockLlmClient([{ text: '', toolCalls: [] }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no_tool_calls_no_text');
    }
  });

  it('retries an empty LLM turn and completes when the retry succeeds', async () => {
    const job = await createTestJob(db, seed);

    // Turn 1: empty response (transient model glitch). The retry re-calls the
    // LLM, which this time returns text → the job recovers and completes
    // instead of hard-failing. Regression for job beb3a4b9 (2026-05-20).
    const llmClient = makeMockLlmClient([
      { text: '', toolCalls: [] },
      { text: 'Recovered answer after the empty turn.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toBe('Recovered answer after the empty turn.');
    }

    const rows = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toBe('Recovered answer after the empty turn.');
  });

  it('recovers on the last allowed retry (2 empty turns then success)', async () => {
    const job = await createTestJob(db, seed);

    // Initial attempt + 2 retries = 3 LLM calls. Two empty turns then a
    // success on the third call still completes the job — proves the budget
    // boundary recovers rather than failing one retry short.
    const llmClient = makeMockLlmClient([
      { text: '', toolCalls: [] },
      { text: '', toolCalls: [] },
      { text: 'Recovered on the final retry.' },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toBe('Recovered on the final retry.');
    }
  });

  // ─── Transcript checkpoint (regression for the 9-turns-lost bug) ───────────
  // Job 8b66b21d (2026-05-17) ran 9 successful turns of CMB research then
  // crashed on the 10th LLM call. Because the catch path's failJob doesn't
  // touch `messages` and saveCheckpoint only fired on delegation/approval,
  // the entire 9-turn transcript was lost — DB stored just the user task.
  // Fix: saveCheckpoint at the end of every loop iteration (execute.ts:927+).

  it('persists per-turn checkpoint so a later crash preserves prior turns in DB', async () => {
    const job = await createTestJob(db, seed);

    // Two clean turns (save_memory) then empty LLM responses: turn 3 is empty
    // and the 2 retries (turns 4 & 5) are empty too → the job fails with
    // no_tool_calls_no_text once the retry budget is exhausted.
    // After failure, DB must reflect what was done in turns 1 & 2.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-a',
            toolName: 'save_memory',
            args: { fact: 'turn-1 fact', category: 'context', importance: 3 },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-b',
            toolName: 'save_memory',
            args: { fact: 'turn-2 fact', category: 'context', importance: 3 },
          },
        ],
      },
      // Turn 3 onward: empty response (mock repeats it) → retried twice, then
      // the runner fails with no_tool_calls_no_text at turn 5.
      { text: '', toolCalls: [] },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('no_tool_calls_no_text');
    }

    const rows = await db
      .select({
        messages: agentJobs.messages,
        toolsUsed: agentJobs.toolsUsed,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    // PRE-FIX behaviour: messages.length === 1 (only user task), toolsUsed=[],
    // even though turn>1. POST-FIX: messages reflects both completed turns
    // (user + asst1 + tool1 + asst2 + tool2 = 5 entries) and toolsUsed
    // includes save_memory. The empty turns 3-5 `continue` before the
    // end-of-loop checkpoint, so they never overwrite the turn-2 transcript.
    const persistedMessages = (rows[0]?.messages ?? []) as unknown[];
    expect(persistedMessages.length).toBe(5);
    expect(rows[0]?.toolsUsed).toContain('save_memory');
    expect(rows[0]?.turn).toBe(5);

    // Spot-check shape: messages[1] is the turn-1 assistant tool_call,
    // messages[2] is the turn-1 tool_result with the save_memory id.
    const m1 = persistedMessages[1] as { role: string; content: unknown };
    expect(m1.role).toBe('assistant');
    const m2 = persistedMessages[2] as { role: string; content: unknown };
    expect(m2.role).toBe('tool');
    const ids = Array.isArray(m2.content)
      ? (m2.content as Array<{ toolCallId?: string }>).map((b) => b.toolCallId)
      : [];
    expect(ids).toContain('tc-mem-a');
  });

  // ─── Reasoning round-trip (regression for the OpenRouter reasoning-amputation) ─
  // A reasoning model (MiniMax M3, DeepSeek, Gemini 3 via OpenRouter) emits a
  // hidden chain-of-thought that the provider returns as reasoning_details and
  // REQUIRES echoed back unmodified on the next turn to keep reasoning across
  // tool calls. The runner used to rebuild the assistant turn from tool calls
  // ALONE (execute.ts step e), amputating the reasoning → the model degraded /
  // looped on multi-turn tool tasks. The fix appends response.response.messages
  // (which carry the reasoning parts) instead. This locks both halves: the
  // reasoning is PERSISTED in the transcript AND actually re-sent to the LLM.
  it('reasoning round-trip: a tool-call turn’s reasoning is persisted AND replayed to the next LLM call', async () => {
    const job = await createTestJob(db, seed);

    const capturedPrompts: unknown[] = [];
    // Turn 1: the model reasons, then calls a tool. Turn 2: it answers.
    const llmClient = makeMockLlmClient(
      [
        {
          reasoning: 'REASONING-MARKER: I must save the key fact before answering.',
          toolCalls: [
            {
              toolCallId: 'tc-reason',
              toolName: 'save_memory',
              args: { fact: 'reasoned fact', category: 'context' },
            },
          ],
        },
        { text: 'All done after reasoning.' },
      ],
      capturedPrompts,
    );

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // (1) The reasoning is PRESERVED in the persisted transcript — the turn-1
    //     assistant message carries a reasoning part, not a tool-calls-only
    //     amputation. Messages: user(0), assistant(1), tool(2), assistant(3).
    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const msgs = (rows[0]?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const asst1 = msgs[1];
    expect(asst1?.role).toBe('assistant');
    const asst1Parts = Array.isArray(asst1?.content)
      ? (asst1!.content as Array<{ type: string; text?: string }>)
      : [];
    const reasoningPart = asst1Parts.find((p) => p.type === 'reasoning');
    expect(reasoningPart?.text).toContain('REASONING-MARKER');
    // The same turn still carries its tool call (pairing intact).
    expect(asst1Parts.some((p) => p.type === 'tool-call')).toBe(true);

    // (2) The SECOND LLM call actually RECEIVED that reasoning in its request
    //     prompt — the round-trip the OpenRouter provider depends on. Asserting
    //     the real request body (invariant 5), not a call count.
    expect(capturedPrompts.length).toBe(2);
    expect(JSON.stringify(capturedPrompts[1])).toContain('REASONING-MARKER');
  });

  it('reasoning + parallel tool calls across turns complete without unmatched_tool_use (regression for job 8fc974fb)', async () => {
    // Live regression: Displacer on MiniMax M3 (job 8fc974fb) ran reasoning +
    // parallel MCP tool calls over several turns and died on
    // message_structure_invalid:unmatched_tool_use. The cause was rebuilding the
    // assistant turn from the SDK's response messages, which can surface a tool
    // call not in response.toolCalls → an assistant tool_use with no matching
    // tool_result. The fix builds the assistant turn's tool calls from
    // rawToolCalls (== what we execute), keeping reasoning. This locks it: a
    // multi-turn flow with PARALLEL tool calls and reasoning must complete, with
    // each turn's reasoning round-tripped.
    const job = await createTestJob(db, seed);
    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          reasoning: 'TURN1-REASON: gather both sources first.',
          toolCalls: [
            {
              toolCallId: 'p1',
              toolName: 'save_memory',
              args: { fact: 'fact A', category: 'context' },
            },
            {
              toolCallId: 'p2',
              toolName: 'save_memory',
              args: { fact: 'fact B', category: 'context' },
            },
          ],
        },
        {
          reasoning: 'TURN2-REASON: now recall what I saved.',
          toolCalls: [{ toolCallId: 'p3', toolName: 'query_memory', args: { query: 'facts' } }],
        },
        { text: 'Done — both facts handled.' },
      ],
      capturedPrompts,
    );

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    // Completes — NOT message_structure_invalid:unmatched_tool_use.
    expect(result.status).toBe('completed');

    // Each reasoning turn round-tripped into the next request (real body).
    expect(capturedPrompts.length).toBe(3);
    expect(JSON.stringify(capturedPrompts[1])).toContain('TURN1-REASON');
    expect(JSON.stringify(capturedPrompts[2])).toContain('TURN2-REASON');
  });

  it('anti-loop: 51 tool_use blocks → tool_call_limit_exceeded', async () => {
    const job = await createTestJob(db, seed);

    // Build 51 tool calls, ALTERNATING between two always-on whitelisted
    // tools so no single tool ever runs 24+ in a row — otherwise Guard 1f
    // (S1 same-tool streak, see chain-counters.ts) would fail the job first
    // and mask the per-turn tool_call_limit_exceeded cap this test targets.
    const manyToolCalls = Array.from({ length: 51 }, (_, i) => ({
      toolCallId: `tc-${i}`,
      toolName: i % 2 === 0 ? 'save_memory' : 'query_memory',
      args: i % 2 === 0 ? { fact: `fact ${i}`, category: 'context' } : { query: `fact ${i}` },
    }));

    // LLM returns 51 tool calls, then text (never reached due to limit)
    const llmClient = makeMockLlmClient([{ toolCalls: manyToolCalls }, { text: 'done' }]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('tool_call_limit_exceeded');
    }

    // Verify DB row
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('tool_call_limit_exceeded');
  });

  it('tool whitelist: calling unregistered tool fails with whitelist_violation', async () => {
    const job = await createTestJob(db, seed);

    // An unregistered tool is now RECOVERABLE: the model is nudged (bounded) to
    // use a valid name. Calling it on every turn exhausts the budget and the job
    // fails loud with whitelist_violation — the tool is never executed.
    const llmClient = makeMockLlmClient(
      repeatToolCall('gmail_send', { to: 'hacker@evil.com', subject: 'pwned' }, 4),
    );

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/whitelist_violation/);
    }
  });

  it('a single unavailable-tool call is recoverable: the model is nudged (not hard-killed) and finishes', async () => {
    const job = await createTestJob(db, seed);
    // Turn 1: the model slips and names a tool it does not have. Turn 2: it
    // recovers with a valid call. One naming slip must NOT kill the job.
    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-bad', toolName: 'definitely_not_a_tool', args: {} }] },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    // Recovered and completed — no whitelist_violation hard-kill.
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ messages: agentJobs.messages, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    // Finished on the recovery turn, not turn 1.
    expect(row?.turn).toBe(2);
    // The slip was fed back as a tool-result naming the unavailable tool, so the
    // model had what it needed to self-correct.
    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const hasNudge = msgs.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type?: string; output?: unknown }>).some(
          (b) =>
            b.type === 'tool-result' &&
            JSON.stringify(b.output ?? '').includes('not available to you'),
        ),
    );
    expect(hasNudge).toBe(true);
  });

  it('agent without telegramBotToken cannot invoke telegram_send_message (whitelist enforcement)', async () => {
    // Ensure the seeded agent has no telegramBotToken (should already be null by default,
    // but be explicit so order-of-execution doesn't matter)
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));

    const job = await createTestJob(db, seed);

    // LLM repeatedly attempts telegram_send_message though the agent has no token.
    // It's nudged (never executed), then fails loud once the budget is spent.
    const llmClient = makeMockLlmClient(
      repeatToolCall('telegram_send_message', { text: 'leak attempt' }, 4),
    );

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // The security guarantee under test: telegram_send_message is not whitelisted
    // (no bot token) → it is NEVER executed, and the job fails loud rather than
    // falsely succeeding. The unavailable call is nudged, then caught by a guard
    // (whitelist budget, or the delivery-spam guard since it's a delivery tool) —
    // either way the delivery never happens.
    expect(result.status).toBe('failed');
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    const rows = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(rows[0]?.status).toBe('failed');
  });

  it('channel-aware delivery: a phantom telegram_send_message on a dashboard job with no recipient still fails loud, never delivers (regression for jobs 2ddb15e3/920fd89c)', async () => {
    // Historical bug: the agent completed a dashboard task successfully via
    // another channel, then ALSO tried a redundant Telegram confirmation,
    // which failed (telegram_no_recipient) and tripped the no-false-success
    // guard, wrongly blocking an otherwise-successful task.
    //
    // The tool registration gate used to be job.chatId-based (excluding
    // dashboard jobs entirely). That gate has since been widened: registration
    // now only depends on the agent having a bot token — recipient resolution
    // (including an OWNER fallback for jobs with no jobChatId, see
    // delivery-guard.ts) is delivery-guard's job, not tool-whitelist's. So
    // telegram_send_message IS now offered here. The security property under
    // test still holds: this seeded agent has no registered OWNER chat, so
    // the owner fallback also resolves to null and the call still fails loud
    // with no-recipient — the delivery function is NEVER reached.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        chatId: null,
        task: 'Publish the result',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('failed to create dashboard test job');

    const llmClient = makeMockLlmClient(repeatToolCall('telegram_send_message', { text: 'hi' }, 4));

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    // No recipient resolvable (no jobChatId, no registered owner) → the tool
    // call itself throws repeatedly; a guard catches it and the job fails
    // loud rather than falsely succeeding (the security property under test).
    expect(result.status).toBe('failed');
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('capability whitelist: a cron job (chatId null) for an agent WITH a bot token includes telegram_send_message and send_image (fix for the silent-watcher gap)', async () => {
    // The exact live gap this closes: a cron watcher job (notify_on_success
    // off → job.chatId is null) whose agent HAS a Telegram bot token used to
    // get NO delivery tools at all — it could detect something worth
    // reporting and have no way to speak. Registration must depend only on a
    // resolvable bot token, never on job.chatId/channel.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: null,
        task: 'Watch for something and report it',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('failed to create cron test job');

    const toolKeysPerCall: string[][] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          toolCalls: [
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      undefined,
      undefined,
      toolKeysPerCall,
    );

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Assert on the REAL tool list the LLM was handed on its first turn.
    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const firstTurnTools = new Set(toolKeysPerCall[0]);
    expect(firstTurnTools.has('telegram_send_message')).toBe(true);
    expect(firstTurnTools.has('send_image')).toBe(true);
    // list_conversations shares the exact same registration gate as the send
    // tools above — a bot token must be enough on its own, same as them.
    expect(firstTurnTools.has('list_conversations')).toBe(true);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('capability whitelist: a cron job for an agent with NO token anywhere gets no delivery tools (regression)', async () => {
    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'cron',
        chatId: null,
        task: 'Watch for something and report it',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('failed to create cron test job');

    const toolKeysPerCall: string[][] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          toolCalls: [
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      undefined,
      undefined,
      toolKeysPerCall,
    );

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    expect(toolKeysPerCall.length).toBeGreaterThan(0);
    const firstTurnTools = new Set(toolKeysPerCall[0]);
    expect(firstTurnTools.has('telegram_send_message')).toBe(false);
    expect(firstTurnTools.has('send_image')).toBe(false);
    expect(firstTurnTools.has('list_conversations')).toBe(false);
  });

  // ─── Brique 25: fail-loud on missing llmKeyId ──────────────────────────────

  it('Brique 25: agent without llmKeyId fails with agent_no_llm_configured', async () => {
    // Clear the llmKeyId that seedMinimal sets — simulates a legacy/misconfigured agent.
    await db.update(agents).set({ llmKeyId: null }).where(eq(agents.id, seed.agentId));

    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([{ text: 'Should never reach LLM' }]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('agent_no_llm_configured');
    }

    // Verify DB row reflects the error
    const rows = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBe('agent_no_llm_configured');

    // Restore llmKeyId for subsequent tests
    await db.update(agents).set({ llmKeyId: seed.llmKeyId }).where(eq(agents.id, seed.agentId));
  });

  // ─── Brique 31: Job context block in system_prompt ────────────────────────────

  it('Brique 31: Telegram-channel job persists ## Job context block in system_prompt', async () => {
    // A real Telegram job belongs to an agent with a bot token; it must deliver
    // via telegram_send_message (the delivery guard now enforces this), so the
    // mock sends then finalizes — same single turn, system_prompt still persisted.
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgContextJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Context test',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgContextJob) throw new Error('Failed to create telegram context test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg-ctx', toolName: 'telegram_send_message', args: { text: 'done' } },
          { toolCallId: 'tc-rr-ctx', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgContextJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Assert the persisted system_prompt contains the Job context block
    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, tgContextJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('## Job context');
    expect(sp).toContain('- origin: telegram');
    expect(sp).toContain('- telegram_chat_id: 12345');

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('Brique 31: api-channel job system_prompt has Job context with origin=api, no telegram_chat_id', async () => {
    const [apiContextJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'API context test',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!apiContextJob) throw new Error('Failed to create api context test job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-api',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(apiContextJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, apiContextJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('## Job context');
    expect(sp).toContain('- origin: api');
    expect(sp).not.toContain('telegram_chat_id');
  });

  // ─── Turn cap (invariant 8) ───────────────────────────────────────────────────

  it('turn cap: job that loops forever fails with turn_limit_exceeded after DEFAULT_LIMITS.maxTurns turns (Guard 1d disabled)', async () => {
    // Import DEFAULT_LIMITS to drive the assertion — the test must not hardcode 50.
    const { DEFAULT_LIMITS } = await import('@nodal-agents/orchestration');

    // Guard 1d (no-delivery runaway detector) normally fires BEFORE the turn cap
    // for a same-work-tool loop (that is its purpose: catch runaways early). To
    // verify the turn cap (maxTurns=50) still works as a backstop, we disable
    // Guard 1d by setting its thresholds to values higher than maxTurns so only
    // the turn cap fires. This validates the guard is still in place for edge
    // cases not caught by Guard 1d (e.g. extremely spaced out tool patterns).
    const savedEnv = {
      NO_DELIVERY_NUDGE_AT: process.env['NO_DELIVERY_NUDGE_AT'],
      SAME_TOOL_STREAK_NUDGE_AT: process.env['SAME_TOOL_STREAK_NUDGE_AT'],
      NO_DELIVERY_FAIL_AT: process.env['NO_DELIVERY_FAIL_AT'],
    };
    process.env['NO_DELIVERY_NUDGE_AT'] = '999';
    process.env['SAME_TOOL_STREAK_NUDGE_AT'] = '999';
    process.env['NO_DELIVERY_FAIL_AT'] = '999';

    try {
      const job = await createTestJob(db, seed);

      // LLM always returns save_memory/query_memory (always-on, whitelisted)
      // — never return_result. We need 51 distinct entries (one per turn)
      // with unique toolCallIds so the message-structure validator doesn't
      // reject duplicate_tool_use_id before the turn cap fires. The last
      // response is reused for turns beyond the array length — so we generate
      // DEFAULT_LIMITS.maxTurns + 1 entries, all unique. ALTERNATING the two
      // tools keeps Guard 1f's S1 same-tool streak (see chain-counters.ts)
      // from firing first and masking the turn_limit_exceeded cap this test
      // targets — a real agent looping on ONE tool for 51 turns is exactly
      // the pattern Guard 1f exists to catch, so this test deliberately
      // avoids that shape to isolate the turn cap instead.
      const loopingLlmClient = makeMockLlmClient(
        Array.from({ length: DEFAULT_LIMITS.maxTurns + 1 }, (_, i) => ({
          toolCalls: [
            {
              toolCallId: `tc-loop-${i}`,
              toolName: i % 2 === 0 ? 'save_memory' : 'query_memory',
              args:
                i % 2 === 0 ? { fact: `loop ${i}`, category: 'context' } : { query: `loop ${i}` },
            },
          ],
        })),
      );

      const result = await executeJob(job.id as JobId, makeDeps(loopingLlmClient), testEnv);

      // Return value assertion
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toBe('turn_limit_exceeded');
      }

      // Real DB row assertion — failJob must have persisted the error code
      const rows = await db
        .select({ status: agentJobs.status, error: agentJobs.error, turn: agentJobs.turn })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));

      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.error).toBe('turn_limit_exceeded');
      // The cap check fires AFTER `turn += 1`, so when `turn > maxTurns` (51 > 50), the
      // persisted turn value is 51. The LLM was called exactly maxTurns (50) times.
      expect(rows[0]?.turn).toBe(DEFAULT_LIMITS.maxTurns + 1);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  // ─── Tool-result truncation ───────────────────────────────────────────────────

  it('tool-result truncation: oversized string tool result is truncated before entering messages', async () => {
    const { z } = await import('zod');
    const { createEmbeddingClient } = await import('@nodal-agents/llm');
    const { LocalTrustProvider } = await import('@nodal-agents/auth');
    const { createToolRegistry: makeReg, registerBuiltins: regBuiltins } =
      await import('@nodal-agents/tools');

    const job = await createTestJob(db, seed);

    // Build a custom registry where save_memory (an always-on, whitelisted tool)
    // is overridden to return a very large string. This tests the truncation path
    // without FK issues — save_memory is in ALWAYS_ON_TOOLS so it's guaranteed
    // to be in the whitelist regardless of skill assignments.
    const customRegistry = makeReg();
    regBuiltins(customRegistry);

    const LARGE_OUTPUT = 'lorem ipsum dolor sit amet '.repeat(8_000);
    // Override save_memory to return a large string for this test
    customRegistry.register({
      name: 'save_memory',
      description: 'save_memory override for truncation test',
      inputSchema: z.object({ fact: z.string(), category: z.string().optional() }),
      riskLevel: 'read' as const,
      execute: async () => LARGE_OUTPUT,
    });

    // LLM: turn 1 calls save_memory (returns 200K chars), turn 2 calls return_result
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem',
            toolName: 'save_memory',
            args: { fact: 'test fact', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    setActiveLlmClient(llmClient);
    const customDeps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry: customRegistry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await executeJob(job.id as JobId, customDeps, testEnv);
    expect(result.status).toBe('completed');

    // Real effect: messages persisted via completeJob must contain truncated tool result
    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    type OutputBlock = {
      type: string;
      toolName: string;
      output: { type: string; value: unknown };
    };
    type MsgRow = { role: string; content: unknown };
    const msgs = rows[0]?.messages as MsgRow[] | undefined;
    expect(msgs).toBeDefined();

    // Find the tool-result message (role: 'tool')
    const toolMsg = msgs?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const blocks = toolMsg?.content as OutputBlock[] | undefined;
    const memBlock = blocks?.find((b) => b.toolName === 'save_memory');
    expect(memBlock).toBeDefined();

    const val = memBlock?.output.value;
    expect(typeof val).toBe('string');
    // Must be truncated: well under the original 200K, <= 50_000 + ~120 marker overhead
    expect((val as string).length).toBeLessThanOrEqual(50_000 + 120);
    expect((val as string).length).not.toBe(200_000);
    // Must carry the explicit truncation marker so the model knows content was cut
    expect(val as string).toContain('[... truncated:');
  });

  it('tool-result truncation: oversized OBJECT tool result switches to text variant and is truncated', async () => {
    // Production case: firecrawl_scrape returns an OBJECT ({ url, markdown, ... }),
    // so truncation hits the JSON branch of toResultOutput — serialize, length
    // check, then switch to the 'text' variant (truncated JSON would not parse).
    const { z } = await import('zod');
    const { createEmbeddingClient } = await import('@nodal-agents/llm');
    const { LocalTrustProvider } = await import('@nodal-agents/auth');
    const { createToolRegistry: makeReg, registerBuiltins: regBuiltins } =
      await import('@nodal-agents/tools');

    const job = await createTestJob(db, seed);

    // Override save_memory (always-on, whitelisted) to return a large OBJECT.
    const customRegistry = makeReg();
    regBuiltins(customRegistry);

    const LARGE_MARKDOWN = 'lorem ipsum dolor sit amet '.repeat(8_000);
    customRegistry.register({
      name: 'save_memory',
      description: 'save_memory override returning a large object for truncation test',
      inputSchema: z.object({ fact: z.string(), category: z.string().optional() }),
      riskLevel: 'read' as const,
      execute: async () => ({ url: 'http://example.com', markdown: LARGE_MARKDOWN }),
    });

    // LLM: turn 1 calls save_memory (returns big object), turn 2 calls return_result
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-mem-obj',
            toolName: 'save_memory',
            args: { fact: 'test fact', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-obj', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    setActiveLlmClient(llmClient);
    const customDeps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry: customRegistry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await executeJob(job.id as JobId, customDeps, testEnv);
    expect(result.status).toBe('completed');

    // Real effect: messages persisted via completeJob must contain truncated tool result
    const rows = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    type OutputBlock = {
      type: string;
      toolName: string;
      output: { type: string; value: unknown };
    };
    type MsgRow = { role: string; content: unknown };
    const msgs = rows[0]?.messages as MsgRow[] | undefined;
    expect(msgs).toBeDefined();

    const toolMsg = msgs?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();

    const blocks = toolMsg?.content as OutputBlock[] | undefined;
    const memBlock = blocks?.find((b) => b.toolName === 'save_memory');
    expect(memBlock).toBeDefined();

    // Oversized structured result must switch to the 'text' variant — a truncated
    // JSON string would not parse, so the discriminated union flips to 'text'.
    expect(memBlock?.output.type).toBe('text');

    const val = memBlock?.output.value;
    expect(typeof val).toBe('string');
    // The original serialized object is well over 200K chars; truncated result
    // must be <= 50_000 + ~120 marker overhead and far under the original.
    const originalSerializedLen = JSON.stringify({
      url: 'http://example.com',
      markdown: LARGE_MARKDOWN,
    }).length;
    expect((val as string).length).toBeLessThanOrEqual(50_000 + 120);
    expect((val as string).length).not.toBe(originalSerializedLen);
    // Must carry the explicit truncation marker so the model knows content was cut
    expect(val as string).toContain('[... truncated:');
  });

  // ─── chat_id semantics: explicit, no runtime fallback ────────────────────────
  // `agent_jobs.chat_id` is the single source of truth for Telegram-delivery
  // intent. The runner does NOT override a NULL chat_id at execute time using
  // agent.lastSeenChatIdTelegram — that would silently flip a deliberate "no
  // Telegram" (e.g. dashboard checkbox unticked) into "yes Telegram".
  // Job-creation sources (cron tick, sendTaskAction, telegram poller) are
  // each responsible for populating chat_id when delivery is wanted.

  it('NULL chat_id stays NULL in Job context, even when the agent has a last-seen Telegram chat', async () => {
    // Agent has been DM'd before — last-seen is populated.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: '99887766' })
      .where(eq(agents.id, seed.agentId));

    // But this job has chat_id=null (e.g. dashboard send with checkbox unticked).
    const [optedOutJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        chatId: null,
        task: 'dashboard task without telegram delivery',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!optedOutJob) throw new Error('Failed to create opted-out job');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-no-tg',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    const result = await executeJob(optedOutJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ systemPrompt: agentJobs.systemPrompt })
      .from(agentJobs)
      .where(eq(agentJobs.id, optedOutJob.id));

    const sp = rows[0]?.systemPrompt ?? '';
    expect(sp).toContain('- origin: api');
    // Critical: telegram_chat_id MUST NOT appear, despite the agent having a
    // last-seen chat. Otherwise the skill would instruct the LLM to deliver
    // when the user explicitly opted out.
    expect(sp).not.toContain('telegram_chat_id');
    expect(sp).not.toContain('99887766');

    // Cleanup so subsequent tests aren't affected.
    await db
      .update(agents)
      .set({ lastSeenChatIdTelegram: null })
      .where(eq(agents.id, seed.agentId));
  });
});

// ─── Approval-gate regression tests ──────────────────────────────────────────
// Covers the three bugs fixed in feat/v4-root-agent:
//   Bug A: sibling tool_use blocks in the same turn as a gated tool got no
//          tool_result → invalid message structure on resume (unmatched_tool_use).
//   Bug B: injectApproval looked for block.result (string) but AI SDK v6 stores
//          the output under block.output → the replacement was a no-op.
//   Bug C: on resume execute.ts only injected [APPROVED] text, never actually
//          executed the tool.
//
// Gated tool: save_memory, which is in ALWAYS_ON_TOOLS → always in the
// whitelist regardless of skill assignments. Real side-effect: an agent_memory
// row in DB. We assert that row exists (approve path) or is absent (reject path)
// to prove real execution, not just a marker swap.

describe('executeJob — approval gate (Bugs A, B, C)', () => {
  // Fresh DB per suite so approval rules and memory rows don't bleed across tests.
  let approvalDb: TestDb;
  let approvalSeed: Awaited<ReturnType<typeof seedMinimal>>;

  beforeAll(async () => {
    const result = await spinUpTestDb();
    approvalDb = result.db;
    approvalSeed = await seedMinimal(approvalDb);

    // Worker role so the whitelist uses registry (not orchestrator paths).
    await approvalDb
      .update(agents)
      .set({ role: 'agent' })
      .where(eq(agents.id, approvalSeed.agentId));
  });

  function makeApprovalDeps(llmClient: ReturnType<typeof makeMockLlmClient>): RunnerDeps {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    setActiveLlmClient(llmClient);

    return {
      db: approvalDb as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };
  }

  async function createApprovalJob() {
    const [job] = await approvalDb
      .insert(agentJobs)
      .values({
        entityId: approvalSeed.entityId,
        agentId: approvalSeed.agentId,
        channel: 'api',
        task: 'Do the gated thing',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!job) throw new Error('Failed to create approval test job');
    return job;
  }

  it('Bug A: two tools in same turn — gated save_memory + sibling save_memory → messages structurally valid', async () => {
    // Seed a require_approval rule for save_memory on this entity.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    // LLM emits two save_memory calls in one turn. First one needs approval (gated),
    // second is the sibling that must get a [DEFERRED] marker (not executed).
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-a',
            toolName: 'save_memory',
            args: { fact: 'gated fact A', category: 'context' },
          },
          {
            toolCallId: 'tc-sibling-a',
            toolName: 'save_memory',
            args: { fact: 'sibling fact A', category: 'context' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);

    // Job must suspend awaiting_approval.
    expect(result.status).toBe('awaiting_approval');

    // Load the saved messages from DB.
    const rows = await approvalDb
      .select({ messages: agentJobs.messages, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(rows[0]?.status).toBe('awaiting_approval');

    type MsgShape = { role: string; content: unknown };
    type ToolCallBlock = { type: string; toolCallId: string };
    type ToolResultBlock = { type: string; toolCallId: string };

    const msgs = rows[0]?.messages as MsgShape[];
    expect(msgs).toBeDefined();

    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    const toolMsg = msgs.find((m) => m.role === 'tool');

    expect(assistantMsg).toBeDefined();
    expect(toolMsg).toBeDefined();

    const toolCallIds = (assistantMsg!.content as ToolCallBlock[])
      .filter((b) => b.type === 'tool-call')
      .map((b) => b.toolCallId);

    const toolResultIds = (toolMsg!.content as ToolResultBlock[])
      .filter((b) => b.type === 'tool-result')
      .map((b) => b.toolCallId);

    // Every tool_use id must have a matching tool_result id — Bug A fix.
    for (const id of toolCallIds) {
      expect(toolResultIds).toContain(id);
    }

    type ResultBlock = {
      type: string;
      toolCallId: string;
      output: { type: string; value: string };
    };

    // First tool got the [AWAITING_APPROVAL] marker.
    const gatedBlock = (toolMsg!.content as ResultBlock[]).find(
      (b) => b.toolCallId === 'tc-gated-a',
    );
    expect(gatedBlock?.output.value).toContain('[AWAITING_APPROVAL]');

    // Second tool (sibling) got the [DEFERRED] marker.
    const siblingBlock = (toolMsg!.content as ResultBlock[]).find(
      (b) => b.toolCallId === 'tc-sibling-a',
    );
    expect(siblingBlock?.output.value).toContain('[DEFERRED]');

    // Cleanup rule.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });

  it('Telegram heads-up: a gated tool on a Telegram job warns the user (via telegram_send_message) before suspending', async () => {
    // Regression for live incident job eeb2b587 (2026-05-31): a gated meta-tool
    // suspended the job in awaiting_approval with ZERO Telegram signal — the user
    // had no way to know an approval was waiting. The runner must give the agent
    // a bounded turn to tell the user, in its own voice via its own delivery tool,
    // THEN suspend.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });
    // telegramBotToken makes telegram_send_message available + marks the channel
    // tool-only, so the heads-up guard engages.
    await approvalDb
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, approvalSeed.agentId));
    // The approval CARD is delivered to the bot OWNER's chat, never straight
    // from the job's chat_id (self-approval fix) — this job's own chat IS the
    // owner chat here, the common case.
    await approvalDb.insert(telegramAllowedChats).values({
      entityId: approvalSeed.entityId,
      agentId: approvalSeed.agentId,
      chatId: '199791464',
      role: 'owner',
      status: 'active',
    });

    const [tgJob] = await approvalDb
      .insert(agentJobs)
      .values({
        entityId: approvalSeed.entityId,
        agentId: approvalSeed.agentId,
        channel: 'telegram',
        chatId: '199791464',
        task: 'Mémorise un truc important',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram approval test job');

    // Turn 1: gated save_memory → gate fires.
    // Turn 2 (after the approval nudge): the agent tells the user on Telegram.
    const HEADS_UP = "J'ai lancé la mémorisation, j'attends ton approbation pour continuer.";
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-tg',
            toolName: 'save_memory',
            args: { fact: 'truc important', category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-headsup', toolName: 'telegram_send_message', args: { text: HEADS_UP } },
        ],
      },
    ]);

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeApprovalDeps(llmClient), testEnv);

    // Job still suspends — the gate is unchanged, only the comms is added.
    expect(result.status).toBe('awaiting_approval');

    // The DETERMINISTIC approval card reached Telegram — sent by the runner itself
    // the instant the gate fired, NOT dependent on the LLM nudge (which was the
    // fragile old behavior that silently sent nothing). It carries the gated
    // action and ✅/❌ inline buttons so the user can resolve from Telegram.
    const cardCall = sendTelegramMessageMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { inlineKeyboard?: unknown } | undefined)?.inlineKeyboard,
    );
    expect(cardCall).toBeDefined();
    const card = (cardCall as unknown[])[0] as {
      chatId: string;
      botToken: string;
      text: string;
      inlineKeyboard: { text: string; callback_data: string }[][];
    };
    expect(card.chatId).toBe('199791464');
    expect(card.botToken).toBe('fake-token');
    expect(card.text).toContain('save_memory');
    expect(card.inlineKeyboard[0]!.map((b) => b.callback_data.split(':')[2])).toEqual(['a', 'r']);

    // And a pending approval_request was genuinely created for the gated tool.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, tgJob.id));
    expect(approvalRows.some((r) => r.toolName === 'save_memory' && r.status === 'pending')).toBe(
      true,
    );

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
    await approvalDb
      .update(agents)
      .set({ telegramBotToken: null })
      .where(eq(agents.id, approvalSeed.agentId));
    await approvalDb
      .delete(telegramAllowedChats)
      .where(eq(telegramAllowedChats.entityId, approvalSeed.entityId));
  });

  it('Bug C: approve → save_memory ACTUALLY runs (agent_memory row created) and executed_at stamped', async () => {
    // Seed the require_approval rule for save_memory.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    // Unique fact string — used to assert the real DB row was created by
    // save_memory.execute() on resume (not by any earlier code path).
    const GATED_FACT = `approval-gate-test-fact-${Date.now()}`;

    // Turn 1: LLM emits save_memory → job suspends.
    // Turn 2 (after approval): LLM calls return_result to finish.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-b',
            toolName: 'save_memory',
            args: { fact: GATED_FACT, category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-b', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // First execution → suspends, save_memory NOT executed yet.
    const suspendResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // Confirm no agent_memory row exists yet for the unique fact.
    const memBefore = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, GATED_FACT));
    expect(memBefore.length).toBe(0);

    // Find the pending approval_requests row created by executeTool.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'save_memory' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();

    // Drive the approval through the real path: mark approved, set job back to pending.
    // This mirrors what approveRoute now does (it only records the decision + re-queues).
    await approvalDb
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await approvalDb
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // Resume — execute.ts step 11.7 executes the approved tool.
    const resumeResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // Core assertion (Bug C): save_memory.execute() ran → agent_memory row exists.
    // This is a REAL DB side-effect, not hand-seeded.
    const memAfter = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, GATED_FACT));
    expect(memAfter.length).toBeGreaterThan(0);

    // executed_at is stamped on the approval_requests row.
    const updatedApproval = await approvalDb
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(updatedApproval[0]?.executedAt).not.toBeNull();

    // The messages in DB must NOT contain [AWAITING_APPROVAL] — replaced with real output.
    const jobRow = await approvalDb
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
    let foundAwaiting = false;
    for (const tm of messages.filter((m) => m.role === 'tool')) {
      for (const block of tm.content as Array<{ output?: { value?: string } }>) {
        if (block.output?.value?.includes?.('[AWAITING_APPROVAL]')) foundAwaiting = true;
      }
    }
    expect(foundAwaiting).toBe(false);

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });

  it('rejection: rejected save_memory → [REJECTED] marker replaces [AWAITING_APPROVAL], NO memory row created', async () => {
    // Seed the require_approval rule.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await createApprovalJob();

    const REJECTED_FACT = `rejection-gate-test-fact-${Date.now()}`;

    // LLM: turn 1 emits save_memory, turn 2 (after rejection) calls return_result.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-gated-c',
            toolName: 'save_memory',
            args: { fact: REJECTED_FACT, category: 'context' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-c',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Memory save was rejected, cannot continue' },
          },
        ],
      },
    ]);

    // First execution → suspends.
    const suspendResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // Find the pending approval_requests row.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'save_memory' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();

    // Reject the request.
    await approvalDb
      .update(approvalRequests)
      .set({ status: 'rejected', resolvedAt: new Date(), resolvedBy: 'test', notes: 'Too risky' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await approvalDb
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    // Resume.
    const resumeResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('failed');

    // save_memory.execute() must NOT have run — no agent_memory row for the fact.
    const memAfter = await approvalDb
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.fact, REJECTED_FACT));
    expect(memAfter.length).toBe(0);

    // executed_at is stamped even for rejections (marker was replaced, work is done).
    const updatedApproval = await approvalDb
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRow!.id));
    expect(updatedApproval[0]?.executedAt).not.toBeNull();

    // Messages must contain [REJECTED], NOT [AWAITING_APPROVAL].
    const jobRow = await approvalDb
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const messages = jobRow[0]?.messages as Array<{ role: string; content: unknown }>;
    let foundRejected = false;
    let foundAwaiting = false;
    for (const tm of messages.filter((m) => m.role === 'tool')) {
      for (const block of tm.content as Array<{ output?: { value?: string } }>) {
        if (block.output?.value?.includes?.('[REJECTED]')) foundRejected = true;
        if (block.output?.value?.includes?.('[AWAITING_APPROVAL]')) foundAwaiting = true;
      }
    }
    expect(foundRejected).toBe(true);
    expect(foundAwaiting).toBe(false);

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });

  it("Fix #11: totalCostUsd is NOT lost across a suspend/resume — the triggering turn's cost survives the approval checkpoint", async () => {
    // Regression for the audit finding: saveCheckpoint at the suspendForApproval
    // site omitted totalCostUsd, so the in-memory accumulator (seeded from the
    // costed LLM turn that emitted the gated call) never reached the DB row —
    // resuming re-seeded totalCostUsd from the STALE persisted value (0), and
    // the Guard 1e $ cap silently forgot the cost of every suspended turn.
    await approvalDb.insert(approvalRules).values({
      entityId: approvalSeed.entityId,
      agentId: null,
      toolName: 'save_memory',
      action: 'require_approval',
    });

    const job = await approvalDb
      .insert(agentJobs)
      .values({
        entityId: approvalSeed.entityId,
        agentId: approvalSeed.agentId,
        channel: 'api',
        task: 'Do the gated thing',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning()
      .then((rows) => rows[0]!);

    // Turn 1 costs $0.42 and emits the gated save_memory call → suspends.
    // Turn 2 (after approval) costs $0.10 and finishes with return_result.
    const llmClient = makeMockLlmClient([
      {
        costUsd: 0.42,
        toolCalls: [
          {
            toolCallId: 'tc-cost-a',
            toolName: 'save_memory',
            args: { fact: 'costed gated fact', category: 'context' },
          },
        ],
      },
      {
        costUsd: 0.1,
        toolCalls: [
          { toolCallId: 'tc-cost-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const suspendResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(suspendResult.status).toBe('awaiting_approval');

    // The DB row must already carry the $0.42 from the triggering turn —
    // NOT 0 — right after the suspend checkpoint (before any resume).
    const [suspendedRow] = await approvalDb
      .select({ totalCostUsd: agentJobs.totalCostUsd })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(suspendedRow?.totalCostUsd).toBeCloseTo(0.42, 5);

    // Approve and resume.
    const approvalRows = await approvalDb
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const approvalRow = approvalRows.find(
      (r) => r.toolName === 'save_memory' && r.status === 'pending',
    );
    expect(approvalRow).toBeDefined();
    await approvalDb
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, approvalRow!.id));
    await approvalDb
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, job.id));

    const resumeResult = await executeJob(job.id as JobId, makeApprovalDeps(llmClient), testEnv);
    expect(resumeResult.status).toBe('completed');

    // The accumulator picked up where it left off ($0.42) and added the resume
    // turn's $0.10 — total $0.52. Neither lost (would be $0.10 alone) nor
    // double-counted (would be $0.94 if the pre-suspend turn were replayed).
    const [finalRow] = await approvalDb
      .select({ totalCostUsd: agentJobs.totalCostUsd })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(finalRow?.totalCostUsd).toBeCloseTo(0.52, 5);

    // Cleanup.
    await approvalDb.delete(approvalRules).where(eq(approvalRules.entityId, approvalSeed.entityId));
  });
});

// ─── Reliability guards (generic, channel-agnostic) ─────────────────────────
// Guard 1a (token budget), Guard 1b (no-progress detector), Guard 3b
// (no-false-success on unresolved tool failures). All assert on the real
// agent_jobs row — status + error code — never on call counts.
describe('reliability guards', () => {
  // Build N responses each carrying a unique toolCallId so the saved transcript
  // stays structurally valid (no duplicate tool ids), while toolName+input stay
  // identical — the no-progress signature ignores the id.
  function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[key];
    process.env[key] = value;
    return fn().finally(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
  }

  it('Guard 1a: fails token_budget_exceeded once cumulative tokens cross the ceiling', async () => {
    const job = await createTestJob(db, seed);
    // Budget 1 token: the first turn's 15 tokens trip it AFTER accumulation,
    // BEFORE the completion path — so even a text-only turn fails loud.
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '1', async () => {
      const llmClient = makeMockLlmClient([{ text: 'thinking…' }]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toBe('token_budget_exceeded');
    });

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('token_budget_exceeded');
  });

  it('Guard 1a is CACHE-AWARE: a prompt-cached turn whose RAW input exceeds the budget still completes', async () => {
    const job = await createTestJob(db, seed);
    // Budget 500. One text turn with 1000 RAW input but 995 cache-read ⇒ 5
    // EFFECTIVE input + 5 output = 10 ≪ 500. Under the old raw-token budget this
    // would die (1000 > 500); cache-aware accounting lets it finish — exactly
    // what makes a re-sent cached history survive (the JobHunter fix).
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '500', async () => {
      const llmClient = makeMockLlmClient([
        { text: 'done', promptTokens: 1000, cachedTokens: 995 },
      ]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('completed');
    });

    // Real DB row: raw input persisted as 1000, but the budgeted EFFECTIVE input
    // is only the 5 non-cached tokens.
    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        inputTokens: agentJobs.inputTokens,
        effectiveInputTokens: agentJobs.effectiveInputTokens,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
    expect(row?.error).toBeNull();
    expect(row?.inputTokens).toBe(1000);
    expect(row?.effectiveInputTokens).toBe(5);
  });

  it('Guard 1a still trips on FRESH tokens: same raw input, zero cache ⇒ token_budget_exceeded', async () => {
    const job = await createTestJob(db, seed);
    // Same 1000 raw input and same 500 budget as the cached test above, but
    // cachedTokens=0 ⇒ effective input = 1000 > 500 ⇒ a genuine runaway still
    // fails loud. Proves the relaxation is cache-conditional, not blanket.
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '500', async () => {
      const llmClient = makeMockLlmClient([
        { text: 'spinning', promptTokens: 1000, cachedTokens: 0 },
      ]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toBe('token_budget_exceeded');
    });

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('token_budget_exceeded');
  });

  it('Guard 1c: compacts old tool results once a turn crosses the context threshold', async () => {
    const job = await createTestJob(db, seed);
    // 'mock' model → DEFAULT_CONTEXT_WINDOW (128k) → threshold = min(0.7*128k, 120k)
    // = 89_600. promptTokens 100k > threshold → compaction fires; keep last 3.
    const sm = (i: number) => ({
      promptTokens: 100_000,
      toolCalls: [
        {
          toolCallId: `tc-${i}`,
          toolName: 'save_memory',
          args: { fact: `fact ${i}`, category: 'context' },
        },
      ],
    });
    const llmClient = makeMockLlmClient([
      sm(1),
      sm(2),
      sm(3),
      sm(4),
      sm(5),
      { promptTokens: 100_000, text: 'all done' },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // The persisted transcript has its OLD tool results evicted to a marker while
    // the most recent stay intact — the real result, not a call count.
    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const toolResults = msgs
      .filter((m) => m.role === 'tool' && Array.isArray(m.content))
      .flatMap(
        (m) => m.content as Array<{ type: string; output?: { type: string; value: unknown } }>,
      )
      .filter((p) => p.type === 'tool-result');
    const elided = toolResults.filter(
      (p) => p.output?.type === 'text' && String(p.output.value).includes('elided'),
    );
    expect(elided.length).toBeGreaterThanOrEqual(1);
    expect(elided.length).toBeLessThan(toolResults.length);
  });

  it('Guard 1c: does NOT compact a large-window model below its window-relative threshold', async () => {
    const job = await createTestJob(db, seed);
    // deepseek-v4-pro → 1M window → threshold 0.7×1M = 733K. A 150k prompt — which
    // the OLD 120k absolute cap would have compacted every turn — must NOT trigger
    // compaction. That premature eviction is exactly what busted the prompt cache
    // (cacheRatio 0.9 → 0.08) and pushed JobHunter into token_budget_exceeded.
    const sm = (i: number) => ({
      promptTokens: 150_000,
      toolCalls: [
        {
          toolCallId: `tc-${i}`,
          toolName: 'save_memory',
          args: { fact: `fact ${i}`, category: 'context' },
        },
      ],
    });
    const llmClient = makeMockLlmClient(
      [sm(1), sm(2), sm(3), sm(4), { promptTokens: 150_000, text: 'all done' }],
      undefined,
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
    );
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const elided = msgs
      .filter((m) => m.role === 'tool' && Array.isArray(m.content))
      .flatMap(
        (m) => m.content as Array<{ type: string; output?: { type: string; value: unknown } }>,
      )
      .filter(
        (p) =>
          p.type === 'tool-result' &&
          p.output?.type === 'text' &&
          String(p.output.value).includes('elided'),
      );
    // 150k ≪ 733k threshold → no eviction at all on a 1M-window model.
    expect(elided.length).toBe(0);
  });

  it('runs an all-reads turn via the parallel pre-pass — every read produces a result, none dropped', async () => {
    const job = await createTestJob(db, seed);
    // A turn of 3 independent read tools (file_list, riskLevel 'read', always-on).
    // The parallel pre-pass executes them concurrently; the serial loop then
    // consumes the cached results. The invariant: all 3 produce a tool-result
    // (no [DEFERRED], no dropped/unmatched calls), then the job finishes cleanly.
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'r1', toolName: 'file_list', args: { path: 'a' } },
          { toolCallId: 'r2', toolName: 'file_list', args: { path: 'b' } },
          { toolCallId: 'r3', toolName: 'file_list', args: { path: 'c' } },
        ],
      },
      { text: 'done' },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const toolResults = msgs
      .filter((m) => m.role === 'tool' && Array.isArray(m.content))
      .flatMap((m) => m.content as Array<{ type: string; toolName?: string; toolCallId?: string }>)
      .filter((p) => p.type === 'tool-result' && p.toolName === 'file_list');
    // All three calls executed and matched (one result per tool_use block).
    expect(toolResults.map((p) => p.toolCallId).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('persists the transcript on a mid-turn failure so the failure is diagnosable', async () => {
    // Regression for the lost-transcript bug (live: job 2ddb15e3 kept only 3
    // messages). A whitelist_violation fails the job MID-iteration — before the
    // end-of-loop saveCheckpoint — so the only thing that can persist the turn is
    // failJob itself. The assistant turn (reasoning + the offending tool call)
    // must survive so we can see WHAT the agent did.
    const job = await createTestJob(db, seed);
    // gmail_send isn't whitelisted → nudged, then whitelist_violation once the
    // budget is spent (mid-iteration, before the end-of-loop saveCheckpoint).
    const llmClient = makeMockLlmClient(repeatToolCall('gmail_send', { to: 'x@y.z' }, 4));
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toMatch(/whitelist_violation/);

    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    // The failed job's transcript is persisted — not just the initial task. The
    // turn's assistant message (with its offending tool call) is there.
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    const hasOffendingCall =
      !!asst &&
      Array.isArray(asst.content) &&
      (asst.content as Array<{ type?: string; toolName?: string }>).some(
        (p) => p.type === 'tool-call' && p.toolName === 'gmail_send',
      );
    expect(hasOffendingCall).toBe(true);
  });

  it('Guard 1b: fails no_progress_detected when an identical tool call repeats', async () => {
    const job = await createTestJob(db, seed);
    // Same invalid save_memory every turn → identical invalid_input error output
    // → identical signature. Threshold lowered to 3 so it trips on turn 3.
    await withEnv('MAX_NO_PROGRESS_REPEATS', '3', async () => {
      const llmClient = makeMockLlmClient(repeatToolCall('save_memory', {}, 5));
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toBe('no_progress_detected');
    });

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('no_progress_detected');
  });

  it('Guard 1b: does NOT trip when each turn does distinct work (anti-false-positive)', async () => {
    const job = await createTestJob(db, seed);
    // Three DISTINCT valid saves (different facts → different outputs/signatures)
    // then return_result. Even with the threshold at 3, no 3-in-a-row identical
    // signature exists, so the job completes normally.
    await withEnv('MAX_NO_PROGRESS_REPEATS', '3', async () => {
      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'sm-a',
              toolName: 'save_memory',
              args: { fact: 'reliability alpha', category: 'context' },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: 'sm-b',
              toolName: 'save_memory',
              args: { fact: 'reliability beta', category: 'context' },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: 'sm-c',
              toolName: 'save_memory',
              args: { fact: 'reliability gamma', category: 'context' },
            },
          ],
        },
        {
          toolCalls: [{ toolCallId: 'rr', toolName: 'return_result', args: { status: 'success' } }],
        },
      ]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('completed');
    });

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
  });

  it('Guard 3b: a NON-delivery side-tool failure does NOT make a success false — the job completes', async () => {
    const job = await createTestJob(db, seed);
    // Turn 1: save_memory fails (a non-delivery side action). Turn 2:
    // return_result(status='success'). The deliverable is unaffected, so this is
    // NOT a false success — the job COMPLETES; the failed call stays visible in
    // the persisted transcript. Live regression this fixes: Java/Cortex sessions
    // did all their work, then died on unresolved_tool_failure over a self-vote /
    // dedup rejection the agent literally cannot retry to success.
    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'sm-bad', toolName: 'save_memory', args: {} }] },
      {
        toolCalls: [{ toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } }],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
  });

  it('Guard 3b: a DELIVERY tool failure DOES make a success false — the job fails loud', async () => {
    const { z } = await import('zod');
    const { createEmbeddingClient } = await import('@nodal-agents/llm');
    const { LocalTrustProvider } = await import('@nodal-agents/auth');
    const { createToolRegistry: makeReg, registerBuiltins: regBuiltins } =
      await import('@nodal-agents/tools');

    const job = await createTestJob(db, seed);
    const customRegistry = makeReg();
    regBuiltins(customRegistry);
    // Override dashboard_publish (a DELIVERY tool) to fail: the user got nothing,
    // so a 'success' declaration IS false and must fail loud — the Conciergus
    // telegram-without-chat black-hole, generalised. This is the branch the
    // benign-side-failure relaxation must NOT weaken.
    customRegistry.register({
      name: 'dashboard_publish',
      description: 'failing dashboard_publish for the delivery-failure test',
      inputSchema: z.object({ text: z.string() }),
      riskLevel: 'write' as const,
      execute: async () => {
        throw new Error('publish failed');
      },
    });

    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'dp', toolName: 'dashboard_publish', args: { text: 'hi' } }] },
      {
        toolCalls: [{ toolCallId: 'rr1', toolName: 'return_result', args: { status: 'success' } }],
      },
      {
        toolCalls: [{ toolCallId: 'rr2', toolName: 'return_result', args: { status: 'success' } }],
      },
      {
        toolCalls: [{ toolCallId: 'rr3', toolName: 'return_result', args: { status: 'success' } }],
      },
    ]);
    setActiveLlmClient(llmClient);
    const customDeps: RunnerDeps = {
      db: db as RunnerDeps['db'],
      llmClient,
      embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
      registry: customRegistry,
      authProvider: new LocalTrustProvider(),
      close: async () => {},
    };

    const result = await executeJob(job.id as JobId, customDeps, testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('unresolved_tool_failure');
  });

  it('Guard 3b: an honest return_result(status="blocked") after a failure finalizes as agent_blocked', async () => {
    const job = await createTestJob(db, seed);
    // Turn 1: save_memory fails. Turn 2: the agent is HONEST — status='blocked'.
    // Guard 3b must NOT convert this into unresolved_tool_failure: an honest block
    // passes through to its own terminal — 'failed' with error='agent_blocked',
    // carrying the agent's reason (never a false success, never silence).
    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'sm-bad2', toolName: 'save_memory', args: {} }] },
      {
        toolCalls: [
          {
            toolCallId: 'rr-blocked',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'Could not save the memory, stopping' },
          },
        ],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    // NOT unresolved_tool_failure — the honest block is its own terminal. The
    // error column carries the agent's SHORT reason (readable), not a code; the
    // full reason is in result.
    expect(row?.error).toBe('Could not save the memory, stopping');
    expect(row?.result).toBe('Could not save the memory, stopping');
  });

  it('return_result(status="blocked") with NO reason → nudged, then finalizes with a generic explanation (never completed, never silent)', async () => {
    const job = await createTestJob(db, seed);
    // The agent declares itself blocked but gives no reason on every turn. The
    // runner nudges (MAX_BLOCKED_REASON_NUDGES=2) for a user-facing reason, then
    // finalizes honestly with a generic backstop — the user is NEVER left
    // without an explanation, and the job is NEVER a fake 'completed'.
    // Distinct tool-call ids per turn (real LLMs never reuse an id; reusing one
    // would trip the duplicate_tool_use message-structure guard).
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'rr-nr-1', toolName: 'return_result', args: { status: 'blocked' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'rr-nr-2', toolName: 'return_result', args: { status: 'blocked' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'rr-nr-3', toolName: 'return_result', args: { status: 'blocked' } },
        ],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');

    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        result: agentJobs.result,
        turn: agentJobs.turn,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    // No reason given → a readable fallback in BOTH error and result, never a
    // bare code, never silence.
    expect(row?.error).toBe('Blocked — the agent stopped without giving a reason.');
    expect(row?.result).toBe('Blocked — the agent stopped without giving a reason.');
    // Two nudges (turns 1 & 2) before finalizing on turn 3.
    expect(row?.turn).toBe(3);
  });

  it('two return_result in one turn (first deferred) → no unmatched_tool_use; finalizes cleanly', async () => {
    // Reproduces job 777d2730: minimax emitted return_result TWICE in a turn.
    // The first is deferred (a sibling tool failed), the second was stripped
    // from the loop with NO tool_result → message_structure_invalid:
    // unmatched_tool_use on the next turn. Both tool_use blocks must be matched.
    const job = await createTestJob(db, seed);
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'sm-bad', toolName: 'save_memory', args: {} }, // invalid → errors
          { toolCallId: 'rr-a', toolName: 'return_result', args: { status: 'success' } },
          { toolCallId: 'rr-b', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'rr-final',
            toolName: 'return_result',
            args: { status: 'blocked', reason: 'save_memory failed, stopping' },
          },
        ],
      },
    ]);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    // It reaches turn 2 and finalizes honestly — NOT message_structure_invalid.
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).not.toMatch(/message_structure_invalid/);
      expect(result.error).toBe('save_memory failed, stopping');
    }
  });

  // ─── Guard 1d — no-delivery runaway detector ─────────────────────────────
  // Regression for real failed jobs 0ff86a1f / ac31d982 / 394b13f4:
  // the agent looped calling varying work-tool queries without ever delivering,
  // running to the 50-turn wall. Guard 1b (no-progress) was defeated because args
  // varied each turn. Guard 1d keys on turns-without-delivery and same-tool streak.

  it('Guard 1d (no-delivery runaway): same work tool every turn → nudge injected, then no_delivery_runaway fail', async () => {
    // Use short thresholds via env so the test doesn't need 12+ turns.
    // sameToolStreakNudgeAt=3, maxNoDeliveryNudges=2, nudgeSpacing=1, noDeliveryFailAt=5
    // Turn 1-3: save_memory (streak=3 → nudge 1 at turn 3)
    // Turn 4-6: save_memory (streak continues, nudge 2 at turn 6 after spacing)
    // Turn 7+: streak/delivery counter keeps climbing past noDeliveryFailAt=5 → fail
    const savedEnv = {
      SAME_TOOL_STREAK_NUDGE_AT: process.env['SAME_TOOL_STREAK_NUDGE_AT'],
      MAX_NO_DELIVERY_NUDGES: process.env['MAX_NO_DELIVERY_NUDGES'],
      NO_DELIVERY_NUDGE_SPACING: process.env['NO_DELIVERY_NUDGE_SPACING'],
      NO_DELIVERY_FAIL_AT: process.env['NO_DELIVERY_FAIL_AT'],
      NO_DELIVERY_NUDGE_AT: process.env['NO_DELIVERY_NUDGE_AT'],
    };
    process.env['SAME_TOOL_STREAK_NUDGE_AT'] = '3';
    process.env['MAX_NO_DELIVERY_NUDGES'] = '2';
    process.env['NO_DELIVERY_NUDGE_SPACING'] = '1';
    process.env['NO_DELIVERY_FAIL_AT'] = '5';
    process.env['NO_DELIVERY_NUDGE_AT'] = '99'; // disable noDeliveryNudgeAt trigger so only streak fires

    try {
      const job = await createTestJob(db, seed);

      // Build enough turns: the mock repeats its last entry, so 20 entries is enough.
      const saveTurn = (i: number) => ({
        toolCalls: [
          {
            toolCallId: `sm-streak-${i}`,
            toolName: 'save_memory',
            args: { fact: `fact ${i}`, category: 'context', importance: 3 },
          },
        ],
      });

      // We never call return_result or dashboard_publish — it loops forever until the guard fires.
      const llmClient = makeMockLlmClient(Array.from({ length: 20 }, (_, i) => saveTurn(i + 1)));
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

      // (a) Job must fail with the dedicated error code before turn 50.
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toBe('no_delivery_runaway');
      }

      // (b) Assert the forcing control message actually appears in the persisted
      // messages array (assert on real transcript, not call counts).
      const [row] = await db
        .select({ messages: agentJobs.messages, turn: agentJobs.turn, error: agentJobs.error })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));

      expect(row?.error).toBe('no_delivery_runaway');
      const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
      const nudgeMsg = msgs.find(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('STOP gathering now'),
      );
      expect(nudgeMsg).toBeDefined();

      // (c) It failed well before maxTurns=50 — guard fired at the expected turn.
      // With sameToolStreakNudgeAt=3, maxNoDeliveryNudges=2, noDeliveryFailAt=5:
      // first nudge at turn 3, second at turn 5 (spacing=1), fail at turn >5
      // once delivery counter passes noDeliveryFailAt. Well before 50.
      expect(row?.turn ?? 50).toBeLessThan(30);
    } finally {
      // Restore env regardless of test outcome.
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('Guard 1d (turnsSinceDelivery path): varying work tools without delivery → nudge then fail', async () => {
    // Tests the noDeliveryNudgeAt path (not same-tool streak): each turn uses a
    // DIFFERENT tool, varying the arg; Guard 1b (same signature) would NOT fire.
    const savedEnv = {
      NO_DELIVERY_NUDGE_AT: process.env['NO_DELIVERY_NUDGE_AT'],
      MAX_NO_DELIVERY_NUDGES: process.env['MAX_NO_DELIVERY_NUDGES'],
      NO_DELIVERY_NUDGE_SPACING: process.env['NO_DELIVERY_NUDGE_SPACING'],
      NO_DELIVERY_FAIL_AT: process.env['NO_DELIVERY_FAIL_AT'],
      SAME_TOOL_STREAK_NUDGE_AT: process.env['SAME_TOOL_STREAK_NUDGE_AT'],
    };
    process.env['NO_DELIVERY_NUDGE_AT'] = '3';
    process.env['MAX_NO_DELIVERY_NUDGES'] = '2';
    process.env['NO_DELIVERY_NUDGE_SPACING'] = '1';
    process.env['NO_DELIVERY_FAIL_AT'] = '5';
    process.env['SAME_TOOL_STREAK_NUDGE_AT'] = '99'; // disable streak path

    try {
      const job = await createTestJob(db, seed);

      // Alternating save_memory / query_memory so args AND tool names vary (defeats Guard 1b).
      const mixedTurns = Array.from({ length: 20 }, (_, i) => ({
        toolCalls: [
          {
            toolCallId: `mixed-${i}`,
            toolName: i % 2 === 0 ? 'save_memory' : 'query_memory',
            args:
              i % 2 === 0
                ? { fact: `varying fact ${i}`, category: 'context', importance: 3 }
                : { query: `varying query ${i}` },
          },
        ],
      }));

      const llmClient = makeMockLlmClient(mixedTurns);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toBe('no_delivery_runaway');
      }

      const [row] = await db
        .select({ messages: agentJobs.messages, turn: agentJobs.turn })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));

      // Nudge message in transcript.
      const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
      const nudge = msgs.find(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('STOP gathering now'),
      );
      expect(nudge).toBeDefined();
      // Failed before turn 50.
      expect(row?.turn ?? 50).toBeLessThan(30);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('Guard 1d (false positive check): a normal job completes within threshold — no nudge injected', async () => {
    // Control case: the agent does 2 work-tool turns then delivers + return_result.
    // turnsSinceDelivery never hits the nudge threshold (NO_DELIVERY_NUDGE_AT=99
    // in default env), so NO nudge is injected and the job completes normally.
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'fp-sm-1',
            toolName: 'save_memory',
            args: { fact: 'first fact', category: 'context', importance: 3 },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'fp-sm-2',
            toolName: 'save_memory',
            args: { fact: 'second fact', category: 'context', importance: 3 },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolCallId: 'fp-pub',
            toolName: 'dashboard_publish',
            args: { text: 'Research complete.' },
          },
          { toolCallId: 'fp-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Assert no nudge message appears in the persisted transcript.
    const [row] = await db
      .select({ messages: agentJobs.messages, turn: agentJobs.turn })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    const msgs = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
    const nudge = msgs.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('STOP gathering now'),
    );
    expect(nudge).toBeUndefined();
    // Completed in exactly 3 turns — no extra turns from nudges.
    expect(row?.turn).toBe(3);
  });

  // ─── Guard 1e — real dollar cost cap ─────────────────────────────────────
  // Regression coverage for the $0.7–1.6 runaway burns on OpenRouter/DeepSeek
  // jobs that don't benefit from prompt caching (cached_tokens genuinely 0).
  // The token budget (Guard 1a) was the only backstop — Guard 1e is the real
  // dollar backstop that kicks in regardless of caching behaviour.

  it('Guard 1e: fails cost_budget_exceeded when cumulative cost crosses the cap', async () => {
    const job = await createTestJob(db, seed);
    // Three save_memory turns each costing $0.80 → cumulative: $0.80, $1.60, $2.40.
    // The job does NOT call return_result, so it continues until a guard fires.
    // With cap $2.00, the THIRD turn (cumulative $2.40 > $2.00) must fail loud
    // BEFORE acting on its output. Turns 1 ($0.80) and 2 ($1.60) are ≤ $2.00 → proceed.
    await withEnv('MAX_COST_PER_JOB_USD', '2.0', async () => {
      const llmClient = makeMockLlmClient([
        {
          costUsd: 0.8,
          toolCalls: [
            {
              toolCallId: 'tc-1',
              toolName: 'save_memory',
              args: { fact: 'a', category: 'context' },
            },
          ],
        },
        {
          costUsd: 0.8,
          toolCalls: [
            {
              toolCallId: 'tc-2',
              toolName: 'save_memory',
              args: { fact: 'b', category: 'context' },
            },
          ],
        },
        {
          costUsd: 0.8,
          toolCalls: [
            {
              toolCallId: 'tc-3',
              toolName: 'save_memory',
              args: { fact: 'c', category: 'context' },
            },
          ],
        },
      ]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toBe('cost_budget_exceeded');
    });

    // The DB row reflects the loud failure with the accumulated cost persisted.
    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        totalCostUsd: agentJobs.totalCostUsd,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('cost_budget_exceeded');
    // The cumulative cost at failure is $2.40 (three $0.80 calls — the third
    // turn's cost is accumulated before the guard fires and failJob persists it).
    expect(row?.totalCostUsd).toBeCloseTo(2.4, 5);
  });

  it('Guard 1e: a job under budget completes normally and persists total_cost_usd as the sum', async () => {
    const job = await createTestJob(db, seed);
    // Two turns costing $0.30 and $0.20 → total $0.50, well under $2.00 cap.
    // The job must complete and persist the real cost.
    await withEnv('MAX_COST_PER_JOB_USD', '2.0', async () => {
      const llmClient = makeMockLlmClient([
        {
          costUsd: 0.3,
          toolCalls: [
            {
              toolCallId: 'tc-sm',
              toolName: 'save_memory',
              args: { fact: 'x', category: 'context' },
            },
          ],
        },
        {
          costUsd: 0.2,
          toolCalls: [
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('completed');
    });

    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        totalCostUsd: agentJobs.totalCostUsd,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
    expect(row?.error).toBeNull();
    // total_cost_usd = $0.30 + $0.20 = $0.50 (the real sum of per-call costs).
    expect(row?.totalCostUsd).toBeCloseTo(0.5, 5);
  });

  it('Guard 1e: a provider reporting no cost (costUsd undefined) never trips the cost guard — token budget governs', async () => {
    const job = await createTestJob(db, seed);
    // No costUsd on any response → totalCostUsd stays 0 → Guard 1e never fires.
    // Token budget (Guard 1a) is still the backstop — a token-capped run fails
    // with token_budget_exceeded, NOT cost_budget_exceeded.
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '1', async () => {
      // Very low cost cap too — but cost is 0 so it must NOT fire.
      await withEnv('MAX_COST_PER_JOB_USD', '0.0001', async () => {
        const llmClient = makeMockLlmClient([{ text: 'answer' }]); // no costUsd
        const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
        expect(result.status).toBe('failed');
        // Must be token budget, not cost budget.
        if (result.status === 'failed') expect(result.error).toBe('token_budget_exceeded');
      });
    });

    const [row] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        totalCostUsd: agentJobs.totalCostUsd,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('token_budget_exceeded'); // Guard 1a fired, not Guard 1e
    expect(row?.totalCostUsd).toBe(0); // no cost reported → stays 0
  });

  // ─── Fix #21: cost derivation for native/BYOK providers ───────────────────
  // Before this fix, totalCostUsd only ever grew via
  // providerMetadata.openrouter.usage.cost — a native provider (DeepSeek,
  // MiniMax, Anthropic-direct, …) never populates that path, so Guard 1e could
  // never fire for those jobs regardless of real spend. The fix derives a
  // call's cost from tokens × the model catalog's list price whenever the
  // provider stays silent. deepseek/deepseek-chat is catalogued with real
  // pricing (packages/shared/src/model-catalog.ts) — used here as the "known
  // priced native model" fixture.

  it('Fix #21: a native provider (no openrouter cost metadata) derives cost from catalog pricing × tokens', async () => {
    const pricing = findModelCatalogEntry('deepseek', 'deepseek-chat')?.pricing;
    if (!pricing) throw new Error('test fixture stale: deepseek-chat has no catalog pricing');

    const job = await createTestJob(db, seed);
    const promptTokens = 2_000_000; // round number → a clean expected value

    // Guard 1a (token budget) is checked BEFORE Guard 1e (cost) — raise it well
    // above this turn's token count so it's the cost derivation under test that
    // decides the outcome, not an incidental token-budget trip.
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '10000000', async () => {
      await withEnv('MAX_COST_PER_JOB_USD', '1000', async () => {
        const llmClient = makeMockLlmClient(
          [
            {
              promptTokens,
              // No costUsd → no providerMetadata.openrouter → exercises the
              // native-provider derivation path, not the OpenRouter self-report.
              toolCalls: [
                { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
              ],
            },
          ],
          undefined,
          { provider: 'deepseek', model: 'deepseek-chat' },
        );
        const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
        expect(result.status).toBe('completed');
      });
    });

    const [row] = await db
      .select({ totalCostUsd: agentJobs.totalCostUsd })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    // Same formula the fix uses in execute.ts (estimateModelCostUsd): tokens ×
    // catalog list price. This mock's outputTokens is fixed at 5 (see
    // makeMockLlmClient above).
    const expectedCostUsd =
      (promptTokens / 1_000_000) * pricing.inputPerMillionUsd +
      (5 / 1_000_000) * pricing.outputPerMillionUsd;
    expect(row?.totalCostUsd).toBeGreaterThan(0);
    expect(row?.totalCostUsd).toBeCloseTo(expectedCostUsd, 6);
  });

  it('Fix #21: derived native-provider cost can trip Guard 1e (cost_budget_exceeded)', async () => {
    const job = await createTestJob(db, seed);
    // 5M prompt tokens × $0.27/M (deepseek-chat catalog price) = $1.35, well
    // over a $0.10 cap — the derived cost alone must trip the guard. Token
    // budget is raised out of the way (see the test above) so it's the cost
    // guard that fires, not an incidental token-budget trip.
    await withEnv('MAX_TOTAL_TOKENS_PER_JOB', '10000000', async () => {
      await withEnv('MAX_COST_PER_JOB_USD', '0.1', async () => {
        const llmClient = makeMockLlmClient(
          [
            {
              promptTokens: 5_000_000,
              toolCalls: [
                {
                  toolCallId: 'tc-sm',
                  toolName: 'save_memory',
                  args: { fact: 'x', category: 'context' },
                },
              ],
            },
          ],
          undefined,
          { provider: 'deepseek', model: 'deepseek-chat' },
        );
        const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
        expect(result.status).toBe('failed');
        if (result.status === 'failed') expect(result.error).toBe('cost_budget_exceeded');
      });
    });

    const [row] = await db
      .select({ error: agentJobs.error, totalCostUsd: agentJobs.totalCostUsd })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.error).toBe('cost_budget_exceeded');
    // 1.35 from input tokens + a tiny output-token contribution (this mock's
    // outputTokens is fixed at 5) — precision 4 comfortably covers both.
    expect(row?.totalCostUsd).toBeCloseTo(1.35, 4);
  });

  // ─── P0-B: served-upstream observability ──────────────────────────────────

  it('P0-B: served_provider is persisted on the DB row when OpenRouter reports an upstream provider', async () => {
    // When OpenRouter returns providerMetadata.openrouter.provider (e.g. 'TestUpstream'),
    // execute.ts must capture the last non-empty value and persist it on the
    // agent_jobs row via completeJob. This is the real DB assertion — not a call count.
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        costUsd: 0.01,
        providerName: 'TestUpstream',
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ servedProvider: agentJobs.servedProvider })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.servedProvider).toBe('TestUpstream');
  });

  it('P0-B: served_provider is null when the provider reports no upstream identity', async () => {
    // When the response carries no providerMetadata.openrouter.provider, the column
    // must remain null — we never hallucinate a value.
    const job = await createTestJob(db, seed);

    const llmClient = makeMockLlmClient([
      {
        // costUsd present (Guard 1e path exercised) but no providerName
        costUsd: 0.01,
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success' },
          },
        ],
      },
    ]);

    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const [row] = await db
      .select({ servedProvider: agentJobs.servedProvider })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));

    expect(row?.servedProvider).toBeNull();
  });

  // ─── F1 regression: double-execution / zombie-execution guards ────────────

  // Test 1 — Atomic claim: two concurrent executeJob calls on the same pending
  // job. Exactly one should complete; the other should return already_handled.
  // The mock LLM completes in one turn (return_result). This asserts the DB row
  // ends up 'completed' exactly once and the losing caller returns already_handled.
  it('F1/Leg1: two concurrent executeJob calls — one completes, other already_handled', async () => {
    const job = await createTestJob(db, seed);

    // Both callers use a mock that resolves in one turn.
    const llmA = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-a',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);
    const llmB = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-b',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ]);

    // Run both concurrently on the same jobId.
    const [resultA, resultB] = await Promise.all([
      executeJob(job.id as JobId, makeDeps(llmA), testEnv),
      executeJob(job.id as JobId, makeDeps(llmB), testEnv),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    // Exactly one 'completed' and one 'already_handled'.
    expect(statuses).toEqual(['already_handled', 'completed']);

    // DB row is 'completed' exactly once (not 'processing' or double-written).
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
  });

  // Test 2 — Reap-during-loop (zombie): a job enters the loop; between turns the
  // orphan reaper flips the row to 'failed'. The top-of-turn check (Leg 2) must
  // detect this and stop. The conditional writer (Leg 3) ensures completeJob does
  // NOT overwrite the 'failed' row.
  //
  // Strategy: use a 2-call mock where the first call does a real tool call, and
  // the second call would return return_result. Between the two calls we flip the
  // DB row to 'failed'. We verify the loop exits before making the second LLM
  // call and the row stays 'failed'.
  it('F1/Leg2+3: orphan reaper flips row to failed mid-loop — loop stops, row stays failed', async () => {
    const job = await createTestJob(db, seed);

    // Track LLM call count to verify the loop stopped early.
    let llmCallCount = 0;

    // We build a custom mock where the first call returns a save_memory tool call,
    // and the second call returns return_result. Between the two we flip the DB.
    // We hijack the mock by pre-staging the flip via a vi.fn side effect.
    const reaperFlippedJobId = job.id;

    const responsesWithReap = [
      // Turn 1: a real tool call (save_memory, which is an always-on builtin)
      {
        toolCalls: [
          {
            toolCallId: 'tc-sm',
            toolName: 'save_memory',
            args: { key: 'test', value: 'test-value' },
          },
        ],
      },
      // Turn 2: return_result — but we'll flip the DB before this is called.
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr',
            toolName: 'return_result',
            args: { status: 'success', text: 'done' },
          },
        ],
      },
    ];

    let callIndex = 0;
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock',
      doGenerate: async (_options) => {
        const response =
          responsesWithReap[callIndex] ?? responsesWithReap[responsesWithReap.length - 1]!;
        llmCallCount++;
        callIndex++;

        // After the first LLM call result is returned, simulate the orphan reaper
        // flipping the row to 'failed'. We do this by directly updating the DB
        // row DURING the second call (i.e., before we return turn-2's response).
        if (callIndex === 2) {
          // This is the second call — flip the row BEFORE returning, simulating
          // a reaper that ran between turns.
          await db
            .update(agentJobs)
            .set({ status: 'failed', error: 'orphan_job_reset' })
            .where(eq(agentJobs.id, reaperFlippedJobId));
        }

        const content: Array<{
          type: 'tool-call';
          toolCallId: string;
          toolName: string;
          input: string;
        }> = [];
        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            content.push({
              type: 'tool-call' as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: JSON.stringify(tc.args),
            });
          }
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

    const mockLlmClient: RunnerDeps['llmClient'] = {
      config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
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
        throw new Error('not supported');
      },
      generateObject: () => {
        throw new Error('not supported');
      },
    };

    setActiveLlmClient(mockLlmClient);
    const result = await executeJob(job.id as JobId, makeDeps(mockLlmClient), testEnv);

    // The loop must have exited due to terminal_observed_mid_loop (Leg 2).
    expect(result.status).toBe('already_handled');

    // The LLM was called exactly once (turn 1: save_memory). Turn 2's call is
    // what flips the DB; after that, the top-of-turn check on turn 2 (BEFORE
    // calling LLM for that turn's actual generation) should stop the loop.
    // Note: the mock flips the DB DURING the second LLM call, so llmCallCount
    // will be 2 (the flip happens inside doGenerate). The key assertion is that
    // the loop didn't proceed to a THIRD call.
    expect(llmCallCount).toBeLessThanOrEqual(2);

    // Most importantly: the DB row must still be 'failed' — completeJob's
    // conditional WHERE (Leg 3) must NOT have overwritten it.
    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('orphan_job_reset');
  });

  // Test 4 — Legitimate resume: the atomic claimJob (Leg 1) must NOT block a
  // job that was reset to 'pending' by an external writer (approval/delegation
  // resume path). We simulate this by: running a job to completion, then manually
  // resetting it to 'pending' and re-executing — verifying the second run can
  // claim it and complete again. This is the critical invariant: pending→processing
  // must always succeed on a genuine 'pending' row.
  it('F1/Leg1: job reset to pending by external writer is claimable and completes', async () => {
    const job = await createTestJob(db, seed);

    // First run: completes normally.
    const llmFirst = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-1',
            toolName: 'return_result',
            args: { status: 'success', text: 'first run' },
          },
        ],
      },
    ]);
    const resultFirst = await executeJob(job.id as JobId, makeDeps(llmFirst), testEnv);
    expect(resultFirst.status).toBe('completed');

    // Simulate the approval resume path: flip the row back to 'pending'.
    // (In production this is done by approve.ts + resumeDelegated.)
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, job.id));

    // Second run on the same job (now pending again): claimJob succeeds and the
    // job completes normally.
    const llmSecond = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rr-2',
            toolName: 'return_result',
            args: { status: 'success', text: 'second run' },
          },
        ],
      },
    ]);
    const resultSecond = await executeJob(job.id as JobId, makeDeps(llmSecond), testEnv);
    expect(resultSecond.status).toBe('completed');

    // DB row is 'completed'.
    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('completed');
  });
});

// ─── Guard 1f: non-progress detector (per-tool-call streaks) ────────────────
// Incident 2026-07-11: a worker looped 38 turns of `run_command` probing for a
// ComfyUI install (dir/where/findstr…), never progressing, never telling the
// user; watcher agents separately burned turns retrying attach_mcp/create_mcp
// after failures instead of reporting. Guard 1b (identical turn signature) and
// Guard 1d (per-turn same-tool-only streak) both miss this because the tool
// INPUTS vary turn to turn. Guard 1f tracks the raw sequence of tool CALLS
// (S1: same tool name N times in a row; S2: N calls in a row erroring) — see
// chain-counters.ts for the pure reducers and thresholds (12/24, 5/10).
describe('Guard 1f: non-progress detector', () => {
  it('S1: 12 consecutive file_list calls → the NEXT LLM request carries a nudge naming the tool and the count; job continues', async () => {
    const job = await createTestJob(db, seed);
    const capturedPrompts: unknown[] = [];
    // `glob` varies per call (ignored by file_list when `path` is omitted, but
    // it keeps each call's INPUT distinct) so Guard 1b's identical-turn-
    // signature detector — whose default threshold also happens to be 12 —
    // never latches; this test isolates Guard 1f alone.
    const responses: Array<{
      toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
    }> = Array.from({ length: 12 }, (_v, i) => ({
      toolCalls: [{ toolCallId: `fl-${i}`, toolName: 'file_list', args: { glob: `probe-${i}` } }],
    }));
    responses.push({
      toolCalls: [
        { toolCallId: 'rr-s1-nudge', toolName: 'return_result', args: { status: 'success' } },
      ],
    });
    const llmClient = makeMockLlmClient(responses, capturedPrompts);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // The 13th call (index 12) is the one made AFTER the 12th file_list call —
    // its prompt must carry the nudge naming the tool and the exact count.
    expect(capturedPrompts.length).toBe(13);
    const nudgedPrompt = JSON.stringify(capturedPrompts[12]);
    expect(nudgedPrompt).toContain('file_list');
    expect(nudgedPrompt).toContain('12 times in a row');
  });

  it('S1: 24 consecutive same-tool calls → fails loud with non_progress_detected naming the tool', async () => {
    const job = await createTestJob(db, seed);
    // Distinct `glob` per call keeps Guard 1b (identical-signature, threshold
    // also 12) from tripping first — this isolates Guard 1f's own fail path.
    const responses = Array.from({ length: 24 }, (_v, i) => ({
      toolCalls: [{ toolCallId: `fl2-${i}`, toolName: 'file_list', args: { glob: `probe-${i}` } }],
    }));
    const llmClient = makeMockLlmClient(responses);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('non_progress_detected');
      expect(result.error).toContain('file_list');
    }

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('non_progress_detected');
    expect(row?.error).toContain('file_list');
  });

  it('S1 regression: alternating tools for 30 calls never nudges or fails', async () => {
    const job = await createTestJob(db, seed);
    const capturedPrompts: unknown[] = [];
    const responses = Array.from({ length: 30 }, (_v, i) => ({
      toolCalls: [
        {
          toolCallId: `alt-${i}`,
          toolName: i % 2 === 0 ? 'file_list' : 'list_schedules',
          args: {},
        },
      ],
    }));
    responses.push({
      toolCalls: [{ toolCallId: 'rr-alt', toolName: 'return_result', args: { status: 'success' } }],
    });
    const llmClient = makeMockLlmClient(responses, capturedPrompts);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const allPrompts = JSON.stringify(capturedPrompts);
    expect(allPrompts).not.toContain('times in a row');
    expect(allPrompts).not.toContain('non_progress_detected');
  });

  it('S2: 5 consecutive failing tool calls → the NEXT LLM request carries the error-streak nudge', async () => {
    const job = await createTestJob(db, seed);
    const capturedPrompts: unknown[] = [];
    // save_memory with {} is invalid input → errors every time (Guard 1b fixture).
    const responses = Array.from({ length: 5 }, (_v, i) => ({
      toolCalls: [{ toolCallId: `sm-err-${i}`, toolName: 'save_memory', args: {} }],
    }));
    responses.push({
      toolCalls: [
        { toolCallId: 'rr-s2-nudge', toolName: 'return_result', args: { status: 'success' } },
      ],
    });
    const llmClient = makeMockLlmClient(responses, capturedPrompts);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    expect(capturedPrompts.length).toBe(6);
    const nudgedPrompt = JSON.stringify(capturedPrompts[5]);
    expect(nudgedPrompt).toContain('save_memory');
    expect(nudgedPrompt).toContain('5 consecutive tool calls have failed');
  });

  it('S2: 10 consecutive failing tool calls → fails loud with the error-streak message', async () => {
    const job = await createTestJob(db, seed);
    const responses = Array.from({ length: 10 }, (_v, i) => ({
      toolCalls: [{ toolCallId: `sm-err2-${i}`, toolName: 'save_memory', args: {} }],
    }));
    const llmClient = makeMockLlmClient(responses);
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('non_progress_detected');
      expect(result.error).toContain('10 consecutive failing tool calls');
      expect(result.error).toContain('save_memory');
    }

    const [row] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('non_progress_detected');
  });

  it('S2: a successful call after 4 errors resets the streak — no nudge at the 5th call overall', async () => {
    const job = await createTestJob(db, seed);
    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient(
      [
        { toolCalls: [{ toolCallId: 'sm-e1', toolName: 'save_memory', args: {} }] }, // error 1
        { toolCalls: [{ toolCallId: 'sm-e2', toolName: 'save_memory', args: {} }] }, // error 2
        { toolCalls: [{ toolCallId: 'sm-e3', toolName: 'save_memory', args: {} }] }, // error 3
        { toolCalls: [{ toolCallId: 'sm-e4', toolName: 'save_memory', args: {} }] }, // error 4
        {
          toolCalls: [
            {
              toolCallId: 'sm-ok',
              toolName: 'save_memory',
              args: { fact: 'reliability streak-reset', category: 'context' },
            },
          ],
        }, // success — resets the S2 streak to 0
        {
          toolCalls: [
            { toolCallId: 'rr-reset', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      capturedPrompts,
    );
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Prompt for the call AFTER the successful 5th call must NOT carry the
    // error-streak nudge — the reset means the streak never reached 5.
    expect(capturedPrompts.length).toBe(6);
    expect(JSON.stringify(capturedPrompts[5])).not.toContain('consecutive tool calls have failed');
  });

  it('S1 exemption: 5 parallel telegram_send_message calls never count toward or break a same-tool streak', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task: 'Guard 1f S1 exemption test',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram test job');

    const capturedPrompts: unknown[] = [];
    // Distinct `glob` per call (ignored by file_list without `path`, but keeps
    // each call's INPUT distinct) so Guard 1b's identical-signature detector
    // never interferes with this Guard 1f-only test.
    const fileListCall = (id: string, i: number) => ({
      toolCalls: [{ toolCallId: id, toolName: 'file_list', args: { glob: `probe-${id}-${i}` } }],
    });
    const responses = [
      // Turns 1-6: build a file_list streak of 6.
      ...Array.from({ length: 6 }, (_v, i) => fileListCall(`pre-${i}`, i)),
      // Turn 7: 5 PARALLEL telegram_send_message calls, no file_list — exempt
      // from S1, must be transparent (neither extend nor break the streak).
      {
        toolCalls: Array.from({ length: 5 }, (_v, i) => ({
          toolCallId: `tg-${i}`,
          toolName: 'telegram_send_message',
          args: { text: `part ${i}` },
        })),
      },
      // Turns 8-13: 6 more file_list calls — if the exemption held, the streak
      // resumes from 6 and reaches 12 on the last of these (turn 13).
      ...Array.from({ length: 6 }, (_v, i) => fileListCall(`post-${i}`, i)),
      // Turn 14: finalize.
      {
        toolCalls: [
          { toolCallId: 'rr-exempt', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ];
    const llmClient = makeMockLlmClient(responses, capturedPrompts);
    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // 14 turns total — the nudge (fired on turn 13, the 12th cumulative
    // file_list call) must be visible in the prompt for turn 14.
    expect(capturedPrompts.length).toBe(14);
    const nudgedPrompt = JSON.stringify(capturedPrompts[13]);
    expect(nudgedPrompt).toContain('file_list');
    expect(nudgedPrompt).toContain('12 times in a row');
    // The 5 telegram sends actually went out (exemption is orthogonal to
    // delivery working) — confirms this isn't passing by the calls having
    // silently failed/no-op'd.
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(5);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });
});

// ─── Guard 1g — verify-before-assert nudge (cancel/undo intent) ──────────────
//
// Live incident 2026-07-11: a user asked their agent whether it could post
// Discord release announcements. The agent created a schedule. The user said
// "Annule". The agent's ENTIRE response turn was telegram_send_message +
// return_result — it never called a read tool, and asserted "rien à annuler",
// contradicting its own prior turn. Guard 1g nudges the agent to verify
// platform state before asserting, when an inbound cancel/undo request is
// answered without any verification tool call on the job's first turn.

describe('Guard 1g — verify-before-assert nudge (cancel/undo intent)', () => {
  async function createTelegramJob(task: string) {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));

    const [tgJob] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '12345',
        task,
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();
    if (!tgJob) throw new Error('Failed to create telegram test job');
    return tgJob;
  }

  async function loadMessages(jobId: string) {
    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
  }

  it('cancel-intent task + first turn with only telegram_send_message → nudge injected before the next request', async () => {
    const tgJob = await createTelegramJob("Mais non je ne t'ai pas demandé ça. Annule.");

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg1',
            toolName: 'telegram_send_message',
            args: { text: 'Annulé, rien à faire.' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const msgs = await loadMessages(tgJob.id as string);
    const nudgeMsg = msgs.find(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudgeMsg).toBeDefined();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('task without cancel/undo words → no nudge', async () => {
    const tgJob = await createTelegramJob('Envoie un résumé du projet.');

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg1',
            toolName: 'telegram_send_message',
            args: { text: 'Voici le résumé.' },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const msgs = await loadMessages(tgJob.id as string);
    const nudgeMsg = msgs.find(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudgeMsg).toBeUndefined();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('first turn WITH a read tool (list_schedules) → no nudge', async () => {
    const tgJob = await createTelegramJob('Annule cette automation.');

    const llmClient = makeMockLlmClient([
      { toolCalls: [{ toolCallId: 'tc-ls', toolName: 'list_schedules', args: {} }] },
      {
        toolCalls: [
          {
            toolCallId: 'tc-tg1',
            toolName: 'telegram_send_message',
            args: { text: 'Vérifié : aucune automation.' },
          },
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const msgs = await loadMessages(tgJob.id as string);
    const nudgeMsg = msgs.find(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudgeMsg).toBeUndefined();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('nudge fires at most once, even if the second turn also skips verification', async () => {
    const tgJob = await createTelegramJob("Annule, j'ai changé d'avis.");

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          { toolCallId: 'tc-tg1', toolName: 'telegram_send_message', args: { text: 'ok annulé' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-tg2', toolName: 'telegram_send_message', args: { text: 'confirmé' } },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    const msgs = await loadMessages(tgJob.id as string);
    const nudges = msgs.filter(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudges).toHaveLength(1);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  // ─── Guard 1g HOLD — the exact incident shape ────────────────────────────
  // Live incident 2026-07-11: turn 1 was [telegram_send_message, return_result]
  // IN THE SAME turn — the job completed before the k-ter nudge (above) ever
  // got a chance to fire. The HOLD intercepts exactly this shape: defers
  // return_result once, injects the nudge, and lets the loop run one more turn.

  it('EXACT incident shape: return_result in the SAME turn as telegram_send_message → held once, completes on turn 2', async () => {
    const tgJob = await createTelegramJob("Mais non je t'ai pas demandé ça . Annule");

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          toolCalls: [
            {
              toolCallId: 'tc-tg1',
              toolName: 'telegram_send_message',
              args: { text: 'Aucune schedule créée — rien à annuler.' },
            },
            { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      capturedPrompts,
    );

    sendTelegramMessageMock.mockClear();
    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Two LLM calls happened — the job did NOT finalize on turn 1's
    // return_result, it looped once more.
    expect(capturedPrompts.length).toBe(2);

    // The nudge is visible in the persisted transcript, between the two turns.
    const msgs = await loadMessages(tgJob.id as string);
    const nudgeMsg = msgs.find(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudgeMsg).toBeDefined();

    // return_result's FIRST call got a "deferred" tool-result, not an
    // "acknowledged" one — it was genuinely held, not silently dropped.
    const heldResult = msgs.find(
      (m) =>
        m.role === 'tool' &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some(
          (p) =>
            p['toolCallId'] === 'tc-rr1' && JSON.stringify(p['output'] ?? '').includes('deferred'),
        ),
    );
    expect(heldResult).toBeDefined();

    // The send actually went out exactly once — the hold didn't re-send or
    // drop the delivery.
    expect(sendTelegramMessageMock).toHaveBeenCalledOnce();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('regression: cancel-intent with a read tool (list_schedules) alongside return_result on turn 1 → completes normally, no hold', async () => {
    const tgJob = await createTelegramJob('Annule cette automation.');

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          toolCalls: [
            { toolCallId: 'tc-ls', toolName: 'list_schedules', args: {} },
            {
              toolCallId: 'tc-tg',
              toolName: 'telegram_send_message',
              args: { text: 'Vérifié : aucune automation.' },
            },
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      capturedPrompts,
    );

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // ONE LLM call — return_result finalized straight away, no hold/re-loop.
    expect(capturedPrompts.length).toBe(1);

    const msgs = await loadMessages(tgJob.id as string);
    const nudgeMsg = msgs.find(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudgeMsg).toBeUndefined();

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });

  it('the hold fires at most once, even if turn 2 answers again with no verification', async () => {
    const tgJob = await createTelegramJob('Annule tout de suite.');

    const capturedPrompts: unknown[] = [];
    const llmClient = makeMockLlmClient(
      [
        {
          // Turn 1: same incident shape — held once.
          toolCalls: [
            { toolCallId: 'tc-tg1', toolName: 'telegram_send_message', args: { text: 'annulé' } },
            { toolCallId: 'tc-rr1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          // Turn 2: STILL no verification tool — must pass through unconditionally.
          toolCalls: [
            { toolCallId: 'tc-tg2', toolName: 'telegram_send_message', args: { text: 'confirmé' } },
            { toolCallId: 'tc-rr2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      capturedPrompts,
    );

    const result = await executeJob(tgJob.id as JobId, makeDeps(llmClient), testEnv);
    expect(result.status).toBe('completed');

    // Exactly 2 LLM calls — turn 2's return_result was NOT held again.
    expect(capturedPrompts.length).toBe(2);

    const msgs = await loadMessages(tgJob.id as string);
    const nudges = msgs.filter(
      (m) => m.role === 'user' && m.content === VERIFY_BEFORE_ASSERT_NUDGE,
    );
    expect(nudges).toHaveLength(1);

    await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
  });
});

// ─── F-8: tool-call heartbeat ─────────────────────────────────────────────────
//
// resetOrphanedJobs (reset-orphans.ts) reaps any 'processing' job whose
// updated_at is more than 5 minutes stale — legitimate for a genuinely dead
// job, fatal for one that's actively blocked on a single SLOW tool call (image
// gen, MCP call, external API) with no other write touching updated_at in the
// meantime. The LLM call already had a heartbeat (Leg 5); the serial tool-
// execution loop did not. This test swaps `web_search`'s execute for one held
// open by the test (via a manually-resolved promise) — same name, riskLevel,
// and inputSchema as the real builtin (already always-on + auto-approve), so
// no whitelist wiring is needed, only the timing is test-controlled. Fake
// timers drive the 60s heartbeat interval deterministically without a real
// multi-minute wait.

describe('F-8: tool-call heartbeat keeps a long single tool call from being reaped', () => {
  it('bumps updated_at via the heartbeat while the tool call is still blocked, then completes normally', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const job = await createTestJob(db, seed);

      let resolveSlowTool: (() => void) | undefined;
      const slowToolPromise = new Promise<void>((resolve) => {
        resolveSlowTool = resolve;
      });

      const llmClient = makeMockLlmClient([
        { toolCalls: [{ toolCallId: 'tc-slow', toolName: 'web_search', args: { query: 'test' } }] },
        {
          toolCalls: [
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);
      const deps = makeDeps(llmClient);

      // Override web_search's execute only — keep its real name/riskLevel/
      // inputSchema so it stays always-on and auto-approved exactly like the
      // production tool.
      const builtinWebSearch = deps.registry.get('web_search')!;
      deps.registry.register({
        ...builtinWebSearch,
        execute: async () => {
          await slowToolPromise;
          return { results: [] };
        },
      });

      const [before] = await db
        .select({ updatedAt: agentJobs.updatedAt })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      const beforeUpdatedAt = before!.updatedAt!.getTime();

      const jobPromise = executeJob(job.id as JobId, deps, testEnv);

      // Drive real microtasks forward (the turn reaching the tool call, the
      // interval being registered) and past the first 60s heartbeat tick —
      // while slowToolPromise is still unresolved, i.e. the tool call is
      // still genuinely blocked.
      await vi.advanceTimersByTimeAsync(65_000);

      const [mid] = await db
        .select({ updatedAt: agentJobs.updatedAt, status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      expect(mid?.status).toBe('processing');
      expect(mid!.updatedAt!.getTime()).toBeGreaterThan(beforeUpdatedAt);

      // Now let the tool resolve and the job run to completion.
      resolveSlowTool!();
      await vi.advanceTimersByTimeAsync(0);
      const result = await jobPromise;

      expect(result.status).toBe('completed');
      const [after] = await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, job.id));
      expect(after?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── B3 / B3bis: delegated worker inherits root's Telegram token, tells its
// parent when it delivers directly ─────────────────────────────────────────
//
// A worker delegated a job (parent_job_id set) has no Telegram bot token of
// its own — only the ROOT agent of the entity is ever given one — so it could
// never use telegram_send_message/send_image/etc. to reply on the same chat
// the orchestrator is running for. B3 fixes this: when a delegated worker's
// job carries a chatId and the agent has no token, the runner resolves the
// entity's root agent's token and offers the delivery tools with THAT token.
// B3bis: when such a worker delivers directly, the PARENT must be told (via a
// deterministic notice appended to the tool_result it sees) so it doesn't
// re-deliver or treat the task as undelivered.

describe('B3: delegated worker inherits root agent Telegram token', () => {
  async function seedRootAndWorker() {
    const ts = Date.now() + Math.random();
    const [user] = await db
      .insert((await import('@nodal-agents/db')).users)
      .values({ email: `test-b3-${ts}@ex.com` })
      .returning();
    const [entity] = await db
      .insert(entities)
      .values({ userId: user!.id, name: 'B3 Entity', slug: `e-b3-${ts}` })
      .returning();
    const [root] = await db
      .insert(agents)
      .values({
        entityId: entity!.id,
        name: 'B3 Root',
        slug: `b3-root-${ts}`,
        personality: 'root',
        llmKeyId: seed.llmKeyId,
        role: 'orchestrator',
        orchestratorMode: 'router',
        telegramBotToken: 'root-secret-token',
        systemAgent: true,
      })
      .returning();
    await db.update(entities).set({ rootAgentId: root!.id }).where(eq(entities.id, entity!.id));
    const [worker] = await db
      .insert(agents)
      .values({
        entityId: entity!.id,
        name: 'B3 Worker',
        slug: `b3-worker-${ts}`,
        personality: 'worker',
        llmKeyId: seed.llmKeyId,
        role: 'agent',
        telegramBotToken: null,
        systemAgent: true,
      })
      .returning();
    return { entityId: entity!.id, rootId: root!.id, workerId: worker!.id };
  }

  it('a delegated worker with no token, given a chatId, gets send_image and it uses the ROOT token', async () => {
    const { entityId, rootId, workerId } = await seedRootAndWorker();

    // Any existing job row satisfies the parent_job_id FK — never executed.
    const [parentJob] = await db
      .insert(agentJobs)
      .values({ entityId, agentId: rootId, channel: 'api', task: 'root task', status: 'pending' })
      .returning();

    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: workerId,
        channel: 'api',
        chatId: '555000111',
        parentJobId: parentJob!.id,
        task: 'deliver a chart',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    sendTelegramPhotoMock.mockClear();
    try {
      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-img',
              toolName: 'send_image',
              args: { source: 'http://example.local/chart.png' },
            },
            { toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);
      const result = await executeJob(childJob!.id as JobId, makeDeps(llmClient), testEnv);

      expect(result.status).toBe('completed');
      expect(sendTelegramPhotoMock).toHaveBeenCalledOnce();
      expect(sendTelegramPhotoMock).toHaveBeenCalledWith(
        expect.objectContaining({ botToken: 'root-secret-token', chatId: '555000111' }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a delegated worker with no token and NO chatId does NOT get delivery tools even though the root has one', async () => {
    const { entityId, rootId, workerId } = await seedRootAndWorker();
    const [parentJob] = await db
      .insert(agentJobs)
      .values({ entityId, agentId: rootId, channel: 'api', task: 'root task', status: 'pending' })
      .returning();
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: workerId,
        channel: 'api',
        chatId: null,
        parentJobId: parentJob!.id,
        task: 'no chat here',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();

    sendTelegramPhotoMock.mockClear();
    const llmClient = makeMockLlmClient(
      repeatToolCall('send_image', { source: 'http://example.local/chart.png' }, 4),
    );
    const result = await executeJob(childJob!.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it('a NON-delegated worker (no parentJobId) does NOT inherit the root token even with a chatId', async () => {
    const { entityId, workerId } = await seedRootAndWorker();
    const [childJob] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: workerId,
        channel: 'api',
        chatId: '555000222',
        parentJobId: null,
        task: 'standalone, not delegated',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();

    sendTelegramPhotoMock.mockClear();
    const llmClient = makeMockLlmClient(
      repeatToolCall('send_image', { source: 'http://example.local/chart.png' }, 4),
    );
    const result = await executeJob(childJob!.id as JobId, makeDeps(llmClient), testEnv);

    expect(result.status).toBe('failed');
    expect(sendTelegramPhotoMock).not.toHaveBeenCalled();
  });

  it('B3bis: a delegated child that delivers via send_image tells its parent in the assign_ tool_result', async () => {
    const ts = Date.now() + Math.random();
    const [user] = await db
      .insert((await import('@nodal-agents/db')).users)
      .values({ email: `test-b3bis-${ts}@ex.com` })
      .returning();
    const [entity] = await db
      .insert(entities)
      .values({ userId: user!.id, name: 'B3bis Entity', slug: `e-b3bis-${ts}` })
      .returning();
    const [orch] = await db
      .insert(agents)
      .values({
        entityId: entity!.id,
        name: 'B3bis Orchestrator',
        slug: `b3bis-orch-${ts}`,
        personality: 'orch',
        llmKeyId: seed.llmKeyId,
        role: 'orchestrator',
        orchestratorMode: 'router',
        telegramBotToken: 'orch-root-token',
        systemAgent: true,
      })
      .returning();
    await db.update(entities).set({ rootAgentId: orch!.id }).where(eq(entities.id, entity!.id));
    const childSlug = `b3bis-child-${ts}`;
    const [child] = await db
      .insert(agents)
      .values({
        entityId: entity!.id,
        name: 'B3bis Child',
        slug: childSlug,
        personality: 'child',
        llmKeyId: seed.llmKeyId,
        role: 'agent',
        telegramBotToken: null,
        systemAgent: true,
      })
      .returning();
    await db.insert(agentAssignments).values({
      orchestratorId: orch!.id,
      subAgentId: child!.id,
      entityId: entity!.id,
    });
    const assignTool = `assign_${childSlug.replace(/-/g, '_')}`;

    const [parentJob] = await db
      .insert(agentJobs)
      .values({
        entityId: entity!.id,
        agentId: orch!.id,
        channel: 'api',
        chatId: '555000333',
        task: 'delegate the chart delivery',
        status: 'pending',
        messages: [],
        chainCount: 0,
      })
      .returning();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    sendTelegramPhotoMock.mockClear();
    try {
      const llmClient = makeMockLlmClient([
        // Parent turn 1: delegates to the child.
        {
          toolCalls: [
            { toolCallId: 'tc-assign', toolName: assignTool, args: { task: 'send the chart' } },
          ],
        },
        // Child turn 1 (runs inline, synchronously, same test): delivers then returns.
        {
          toolCalls: [
            {
              toolCallId: 'tc-img',
              toolName: 'send_image',
              args: { source: 'http://example.local/chart.png' },
            },
            { toolCallId: 'tc-rr-child', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        // Parent turn 2 (resumed): sees the child's result, finishes.
        {
          toolCalls: [
            { toolCallId: 'tc-rr-parent', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      const result = await executeJob(parentJob!.id as JobId, makeDeps(llmClient), testEnv);
      expect(result.status).toBe('completed');

      // The child used the inherited ROOT (orchestrator's own) token — proves
      // B3 held for the assign_ delegation path too, not just a direct job.
      expect(sendTelegramPhotoMock).toHaveBeenCalledWith(
        expect.objectContaining({ botToken: 'orch-root-token' }),
      );

      // B3bis: the parent's own transcript must carry the delivery notice —
      // the orchestrator's LLM must not re-deliver or treat this as undelivered.
      const [row] = await db
        .select({ messages: agentJobs.messages })
        .from(agentJobs)
        .where(eq(agentJobs.id, parentJob!.id));
      const transcript = JSON.stringify(row?.messages ?? []);
      expect(transcript).toContain('livraison effectuée');
      expect(transcript).toContain('send_image');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
