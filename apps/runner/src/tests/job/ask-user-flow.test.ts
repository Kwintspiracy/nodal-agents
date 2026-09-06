// ask-user-flow.test.ts — la boucle complète de P10a, dans le vrai runner :
// l'agent pose une question, le travail SE SUSPEND, un humain choisit, le
// travail REPREND et le transcript porte la réponse.
//
// C'est le test qui compte. Les autres prouvent chacun une pièce ; celui-ci
// prouve le CÂBLAGE — la leçon du lot du 27/08, où quatre tests ont été verts
// en testant la fonction sans jamais tester son branchement. Ce qui est relu
// ici, ce sont les messages PERSISTÉS du job et ses lignes `tool_calls`, pas
// une valeur rendue par un helper.
//
// Harnais (LLM factice, testEnv, deps) repris de run-command-flow.test.ts.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents, approvalRequests, toolCalls } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM client interception ─────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('ask-user-flow.test: no active LLM client');
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
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

const QUESTION = 'Where should I write the summary?';
const OPTIONS = ['The repo README', 'A new file in notes'];
const CALL_ID = 'tc-ask-1';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));
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

async function createJob(): Promise<{ id: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'write a summary somewhere',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create test job');
  return job;
}

/** Tous les textes de résultats d'outils du transcript persisté, dans l'ordre. */
async function toolResultTexts(jobId: string): Promise<string[]> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  const messages = (row?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool-result') continue;
      const output = block['output'] as { type: string; value: unknown } | undefined;
      const raw = output?.type === 'text' ? output.value : JSON.stringify(output?.value ?? null);
      out.push(typeof raw === 'string' ? raw : JSON.stringify(raw));
    }
  }
  return out;
}

describe('ask_user — la boucle complète dans le runner', () => {
  it('suspend, puis reprend avec la réponse : le marqueur disparaît, la réponse est dans le transcript', async () => {
    const job = await createJob();
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: CALL_ID,
            toolName: 'ask_user',
            args: { question: QUESTION, options: OPTIONS },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // ── Phase 1 : le travail se suspend sur la question ──────────────────────
    const suspended = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspended.status).toBe('awaiting_approval');

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.kind, 'question')));
    expect(pending).toBeDefined();
    expect(pending!.status).toBe('pending');
    expect(pending!.toolCallId).toBe(CALL_ID);

    const suspendedTexts = await toolResultTexts(job.id);
    expect(suspendedTexts.some((t) => t.includes('[AWAITING_APPROVAL]'))).toBe(true);

    // ── Phase 2 : un humain choisit, par le VRAI chemin de résolution ────────
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    const resolved = await resolveApprovalDecision(makeDeps(llmClient), testEnv, {
      approvalRequestId: pending!.id,
      decision: 'approve',
      answer: OPTIONS[1]!,
      resolvedBy: 'api',
    });
    expect(resolved.ok).toBe(true);

    // ── Phase 3 : la reprise rejoue l'appel et lit la réponse ────────────────
    const resumed = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumed.status).toBe('completed');

    const texts = await toolResultTexts(job.id);
    // Plus aucun marqueur d'attente…
    expect(texts.some((t) => t.includes('[AWAITING_APPROVAL]'))).toBe(false);
    // …et la réponse EST le résultat de l'outil, telle que l'humain l'a choisie.
    expect(texts.some((t) => t.includes(OPTIONS[1]!) && t.includes('option_index'))).toBe(true);

    // La seconde ligne d'audit porte le MÊME tool_call_id et a réussi.
    const rows = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.toolCallId, CALL_ID)))
      .orderBy(toolCalls.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.toolOutput).toContain('awaiting_approval');
    expect(rows[1]!.card).toBe('question');
    expect(rows[1]!.presented).toMatchObject({
      card: 'question',
      prompt: QUESTION,
      answer: OPTIONS[1],
    });
  });

  it('DEUX questions dans le même tour : une seule suspend, l’autre est différée — jamais deux lignes (passe 37)', async () => {
    // Sans garde, deux `ask_user` d'un tour (deux outils `read`, aucune règle)
    // partaient dans le pré-passage PARALLÈLE : deux lignes en attente, deux
    // cartes, et à la reprise — qui retrouve le marqueur par nom d'outil — la
    // première réponse attribuée au mauvais appel. Un outil qui pose une
    // question suspend toujours ; la seconde est différée comme toute action
    // après une suspension.
    const job = await createJob();
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-q-a',
            toolName: 'ask_user',
            args: { question: QUESTION, options: OPTIONS },
          },
          {
            toolCallId: 'tc-q-b',
            toolName: 'ask_user',
            args: { question: 'And the second thing?', options: ['Yes', 'No'] },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const suspended = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspended.status).toBe('awaiting_approval');

    const rows = await db
      .select({ toolCallId: approvalRequests.toolCallId, status: approvalRequests.status })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.kind, 'question')));
    expect(rows, 'deux questions ont été posées en même temps').toEqual([
      { toolCallId: 'tc-q-a', status: 'pending' },
    ]);
    const texts = await toolResultTexts(job.id);
    expect(texts.filter((t) => t.includes('[AWAITING_APPROVAL]'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('[DEFERRED]'))).toHaveLength(1);

    // La réponse va à la BONNE question, et le travail finit.
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    const [pending] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.toolCallId, 'tc-q-a')));
    const resolved = await resolveApprovalDecision(makeDeps(llmClient), testEnv, {
      approvalRequestId: pending!.id,
      decision: 'approve',
      answer: OPTIONS[0]!,
      resolvedBy: 'api',
    });
    expect(resolved.ok).toBe(true);
    const resumed = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumed.status).toBe('completed');
    const after = await toolResultTexts(job.id);
    expect(after.some((t) => t.includes(OPTIONS[0]!) && t.includes('option_index'))).toBe(true);
    expect(after.some((t) => t.includes('[AWAITING_APPROVAL]'))).toBe(false);
  });

  it('une question DÉCLINÉE reprend le travail sur le marqueur [REJECTED], sans réponse inventée', async () => {
    const job = await createJob();
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-ask-2',
            toolName: 'ask_user',
            args: { question: QUESTION, options: OPTIONS },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-2', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    const suspended = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspended.status).toBe('awaiting_approval');

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.kind, 'question')));
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    const declined = await resolveApprovalDecision(makeDeps(llmClient), testEnv, {
      approvalRequestId: pending!.id,
      decision: 'reject',
      notes: 'None of these fits',
      resolvedBy: 'api',
    });
    expect(declined.ok).toBe(true);

    const resumed = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumed.status).toBe('completed');

    const texts = await toolResultTexts(job.id);
    expect(texts.some((t) => t.includes('[REJECTED]') && t.includes('None of these fits'))).toBe(
      true,
    );
    expect(texts.some((t) => t.includes('option_index'))).toBe(false);
  });
});
