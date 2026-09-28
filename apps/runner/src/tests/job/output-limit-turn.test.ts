// output-limit-turn.test.ts — a turn cut on the output-token cap does not act (#554)
//
// Run 04229144 (ComfyArtist, z-ai/glm-5.3 via OpenRouter): turn 6 stopped at
// exactly the output cap, 131 072 tokens, and the runner executed ~25 tool
// calls parsed out of it: three memories written, a real project registered,
// and a placeholder `ask_user` that parked the job in `awaiting_approval`.
//
// Proven here on the REAL path: executeJob, a real test database, and the REAL
// LLM client (`createLlmClient` from @nodal-agents/llm) over a mock provider
// model, so the refusal is the client's own, reached the way a run reaches it.
// What is read back is what the incident left behind: memory rows, tool_calls
// rows, approval requests, the job row and its llm_calls row.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agentJobs,
  agentMemory,
  agents,
  approvalRequests,
  llmCalls,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';

type Finish = 'length' | 'tool-calls' | 'stop';

const { setFinish, currentModel } = vi.hoisted(() => {
  let finish: 'length' | 'tool-calls' | 'stop' = 'tool-calls';
  let output = 1_200;
  let model: unknown = null;
  return {
    /** The reply's finish reason and how many output tokens it billed. */
    setFinish: (f: 'length' | 'tool-calls' | 'stop', out: number) => {
      finish = f;
      output = out;
    },
    currentModel: {
      get finish() {
        return finish;
      },
      get output() {
        return output;
      },
      get model() {
        return model;
      },
      set model(m: unknown) {
        model = m;
      },
    },
  };
});

// The provider builder is the one seam replaced: everything above it (the
// client, its retry, clocks and refusal) is the production code.
vi.mock('../../../../../packages/llm/src/providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildOpenRouterModel: () => currentModel.model };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    // Whatever the agent's row configures, the run gets the real client on the
    // mock model, with the SAME options (the llm_calls sink included).
    createLlmClient: (
      _config: Parameters<typeof actual.createLlmClient>[0],
      opts?: Parameters<typeof actual.createLlmClient>[1],
    ) => actual.createLlmClient(PROVIDER_CONFIG, opts),
  };
});

const PROVIDER_CONFIG = { provider: 'openrouter' as const, model: 'z-ai/glm-5.3', apiKey: 'k' };
const FACT = 'the illustration folder is outputs-illustrations';
const QUESTION = 'placeholder';

/** A provider stream part (the type lives in `@ai-sdk/provider`, outside the runner's dependencies). */
type StreamPart = Record<string, unknown>;

/** The incident's shape: a memory write, then a placeholder question. */
function turnParts(finish: Finish, output: number): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'Saving what I found.' },
    { type: 'text-end', id: 't' },
    {
      type: 'tool-call',
      toolCallId: 'sm-1',
      toolName: 'save_memory',
      input: JSON.stringify({ fact: FACT, category: 'context' }),
    },
    {
      type: 'tool-call',
      toolCallId: 'ask-1',
      toolName: 'ask_user',
      input: JSON.stringify({ question: QUESTION, options: ['ok', 'ko'] }),
    },
    {
      type: 'finish',
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: output, text: output, reasoning: undefined },
      },
    },
  ];
}

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: PROVIDER_CONFIG.model,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: turnParts(currentModel.finish, currentModel.output),
      }) as never,
    }),
  });
}

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'openrouter',
  LLM_MODEL: PROVIDER_CONFIG.model,
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

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let llm: typeof import('@nodal-agents/llm');

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));
  llm = await import('@nodal-agents/llm');
});

function makeDeps(): RunnerDeps {
  currentModel.model = mockModel();
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: llm.createLlmClient(PROVIDER_CONFIG),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function insertJob(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'draw the series and file it',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

function readLlmRows(jobId: string) {
  return db
    .select({ outputTokens: llmCalls.outputTokens, error: llmCalls.error })
    .from(llmCalls)
    .where(eq(llmCalls.jobId, jobId));
}

async function effects(jobId: string) {
  const memories = await db
    .select({ fact: agentMemory.fact })
    .from(agentMemory)
    .where(eq(agentMemory.agentId, seed.agentId));
  const calls = await db
    .select({ toolName: toolCalls.toolName })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId));
  const questions = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.jobId, jobId));
  const [job] = await db
    .select({ status: agentJobs.status, error: agentJobs.error })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  // The llm_calls sink writes without being awaited: read until the row lands.
  const until = Date.now() + 2_000;
  let llmRows = await readLlmRows(jobId);
  while (llmRows.length === 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
    llmRows = await readLlmRows(jobId);
  }
  return {
    memoryFacts: memories.map((m) => m.fact).filter((f) => f === FACT),
    toolNames: calls.map((c) => c.toolName),
    questions,
    job: job!,
    llmRows,
  };
}

describe('a job turn cut on the output-token cap does not act @cap:suivre-execution/moteur', () => {
  it('executes none of its tool calls and fails with output_limit_reached', async () => {
    setFinish('length', 131_072);
    const jobId = await insertJob();

    const outcome = await executeJob(jobId as JobId, makeDeps(), testEnv);

    expect(outcome.status).toBe('failed');
    const after = await effects(jobId);
    // Nothing the cut reply asked for happened.
    expect(after.memoryFacts).toEqual([]);
    expect(after.toolNames).toEqual([]);
    expect(after.questions).toEqual([]);
    // The job says why, as a code with its facts.
    expect(after.job.status).toBe('failed');
    expect(after.job.error).toBe(
      'output_limit_reached:openrouter/z-ai/glm-5.3 ' +
        '(turn 1, 131072 output tokens, 2 tool calls not executed)',
    );
    // The billed call is on record, with the refusal as its error.
    expect(after.llmRows).toHaveLength(1);
    expect(after.llmRows[0]?.outputTokens).toBe(131_072);
    expect(after.llmRows[0]?.error ?? '').toMatch(/^LLMOutputLimitError: /);
  });

  it('the same calls with a normal finish are executed as before', async () => {
    setFinish('tool-calls', 1_200);
    const jobId = await insertJob();

    const outcome = await executeJob(jobId as JobId, makeDeps(), testEnv);

    expect(outcome.status).toBe('awaiting_approval');
    const after = await effects(jobId);
    expect(after.memoryFacts).toEqual([FACT]);
    expect(after.toolNames).toContain('save_memory');
    expect(after.questions).toEqual([{ status: 'pending' }]);
    expect(after.job.error).toBeNull();
  });
});

// #563 — job da91bdbb (xiaomi/mimo-v2.6-pro, DeepInfra through OpenRouter):
// 65 536 output tokens, 307 tool calls, and no 'length' from the provider. The
// client states its output cap on the request; a reply that reaches it is cut
// whatever finish reason the provider reports.
describe('a job turn that reaches the stated output cap does not act, whatever its finish @cap:suivre-execution/moteur', () => {
  for (const finish of ['tool-calls', 'stop'] as const) {
    it(`finish '${finish}' at 65 536 output tokens: nothing executed, output_limit_reached`, async () => {
      setFinish(finish, 65_536);
      // The control above wrote the fact for real: start from none.
      await db.delete(agentMemory).where(eq(agentMemory.agentId, seed.agentId));
      const jobId = await insertJob();

      const outcome = await executeJob(jobId as JobId, makeDeps(), testEnv);

      expect(outcome.status).toBe('failed');
      const after = await effects(jobId);
      expect(after.memoryFacts).toEqual([]);
      expect(after.toolNames).toEqual([]);
      expect(after.questions).toEqual([]);
      expect(after.job.error).toBe(
        'output_limit_reached:openrouter/z-ai/glm-5.3 ' +
          '(turn 1, 65536 output tokens, 2 tool calls not executed)',
      );
      // The request stated the cap it was judged on.
      const model = currentModel.model as MockLanguageModelV3;
      expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(65_536);
    });
  }
});
