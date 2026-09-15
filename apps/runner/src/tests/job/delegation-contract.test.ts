// delegation-contract.test.ts — issue #107, the delegation contract.
//
// Replays the real incident (job f1852d35 / sub-job 538b8d53, 2026-09-15): a
// delegated Researcher emitted a reasoning block and a bare
// `return_result{status:'success'}`, produced NO text, and was finalized
// `completed` with an empty result. The parent read "(no output)" as an answer
// and told the user "recherche lancée, je te renvoie la synthèse" — a promise
// for a result that had already failed to exist.
//
// The contract now mirrors Hermes (`tools/delegate_tool.py:2064-2078`):
// the sub-agent's final text IS the deliverable, an empty one is a FAILURE, and
// the parent receives a typed record rather than a string it has to interpret.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents } from '@nodal-agents/db';
import { completeJob } from '../../job/state.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { resumeDelegated } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('delegation-contract.test: no active LLM client set');
      return active;
    },
  };
});

type MockTurn = {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

function makeMockLlmClient(responses: MockTurn[]): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.reasoning) content.push({ type: 'reasoning', text: response.reasoning });
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

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
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

async function insertJob(values: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'Fais une recherche sur la longueur de Planck',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function jobRow(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Flatten a persisted transcript to plain text so a nudge can be asserted on. */
function transcriptText(messages: unknown): string {
  return JSON.stringify(messages ?? []);
}

describe('delegated sub-job deliverable @cap:organiser-equipe/moteur', () => {
  it('nudges once then FAILS an internal sub-job that signals success with no text', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      pendingDelegation: { toolUseId: 'assign-x', toolName: 'assign_researcher' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-x',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    // The incident turn, replayed verbatim: a reasoning block announcing the
    // delivery, then `return_result{status:'success'}` and nothing else.
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: "I'll deliver via return_result and also send to Telegram",
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          reasoning: 'still nothing to say',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(childId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(childId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('empty_deliverable');
    // The first signal was NOT accepted silently: the transcript carries the
    // one nudge asking for the deliverable, before the failure.
    expect(transcriptText(row.messages)).toContain('ta réponse écrite EST le livrable');
  });

  it('ACCEPTS the sub-job when the second turn writes the deliverable', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      pendingDelegation: { toolUseId: 'assign-x', toolName: 'assign_researcher' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-x',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    const deliverable =
      'Planck length: 1.616255e-35 m, derived from ħ, G and c. Sources: NIST CODATA 2022.';
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'done searching',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: deliverable,
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(childId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(childId);
    expect(row.status).toBe('completed');
    // The deliverable is the agent's own text, stored verbatim — not a signal.
    expect(row.result).toContain('1.616255e-35');
  });

  it('FAILS a head job on `api` that signals success with no text and no delivery', async () => {
    const jobId = await insertJob({ channel: 'api' });
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'I consider this done',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          reasoning: 'still done',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('empty_deliverable');
    // Never a completed row with nothing in it — the whole point of #107.
    expect(row.status).not.toBe('completed');
  });
});

describe('parent receives a typed delegation record @cap:organiser-equipe/moteur', () => {
  it('injects {status, summary, error, exit_reason, tools_used} for a completed child', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'recherche' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-1',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
      pendingDelegation: { toolUseId: 'assign-1', toolName: 'assign_researcher' },
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'completed',
        summary: 'Planck length is 1.616255e-35 m.',
        error: null,
        exit_reason: 'return_result_success',
        tools_used: ['tavily_search', 'return_result'],
      },
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(last.role).toBe('tool');
    expect(part.output.type).toBe('text');
    const payload = JSON.parse(part.output.value) as Record<string, unknown>;
    expect(payload['status']).toBe('completed');
    expect(payload['summary']).toBe('Planck length is 1.616255e-35 m.');
    expect(payload['exit_reason']).toBe('return_result_success');
    expect(payload['tools_used']).toEqual(['tavily_search', 'return_result']);
  });

  it('injects an error-text record that forbids a waiting message for a failed child', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'recherche' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-2',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
      pendingDelegation: { toolUseId: 'assign-2', toolName: 'assign_researcher' },
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'failed',
        summary: '',
        error: 'empty_deliverable',
        exit_reason: 'empty_deliverable',
        tools_used: ['tavily_search'],
      },
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe('error-text');
    expect(part.output.value).toContain('"status": "failed"');
    expect(part.output.value).toContain('"error": "empty_deliverable"');
    // "(no output)" is gone: the parent is told the delegation delivered nothing
    // AND that announcing progress is not one of its options.
    expect(part.output.value).not.toContain('(no output)');
    expect(part.output.value).toContain('DO NOT tell the user the work is in progress');
  });
});

describe('a parent cannot promise over a failed delegation @cap:organiser-equipe/moteur', () => {
  it('nudges the parent that sends a waiting message and then signals success', async () => {
    // Parent state exactly as `resumeDelegated` leaves it after a failed child.
    const parentId = await insertJob({
      channel: 'api',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-3',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-3',
              toolName: 'assign_researcher',
              output: { type: 'error-text', value: '{"status":"failed"} delivered NOTHING' },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          // The incident's parent turn: a promise, then a success signal.
          text: 'Recherche lancée sur la longueur de Planck, je te renvoie la synthèse dès que c’est prêt',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: 'Recherche toujours en cours, je reviens vers toi',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: 'Toujours rien',
          toolCalls: [
            { toolCallId: 'rr-3', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    // The first success signal was refused, not accepted.
    const row = await jobRow(parentId);
    expect(row.status).not.toBe('completed');
    expect(outcome.status).toBe('failed');
    const transcript = transcriptText(row.messages);
    expect(transcript).toContain("Ne déclare pas un succès qui n'a pas eu lieu");
    expect(transcript).toContain('le travail est lancé ou à venir');
  });
});

describe('a child with no deliverable is never "(no output)" @cap:organiser-equipe/moteur', () => {
  it('compiles a FAILURE into the parent result, not an empty-looking answer', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      status: 'failed',
      error: 'empty_deliverable',
    });

    // The parent finishes without republishing: `completeJob` compiles its
    // children into the user-facing result.
    await completeJob(db, parentId, '', ['assign_researcher'], undefined, [
      { role: 'user', content: 'recherche' },
    ]);

    const row = await jobRow(parentId);
    expect(row.result).not.toContain('(no output)');
    expect(row.result).toContain('empty_deliverable');
  });

  it('marks a NON-failed child that produced nothing as a failed delegation', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    await insertJob({ channel: 'internal', parentJobId: parentId, status: 'cancelled' });

    await completeJob(db, parentId, '', ['assign_researcher'], undefined, [
      { role: 'user', content: 'recherche' },
    ]);

    const row = await jobRow(parentId);
    expect(row.result).not.toContain('(no output)');
    expect(row.result).toContain('no deliverable');
  });
});
