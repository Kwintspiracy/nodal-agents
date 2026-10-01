// mcp-elicitation-flow.test.ts — le PARCOURS COMPLET d'une question posée par
// un serveur MCP pendant un appel (élicitation, 0145), à travers `executeJob`.
//
// Le serveur est RÉEL : la fixture stdio construite avec le SDK officiel
// (packages/adapters/mcp/src/tests/fixtures/mcp-elicit-server.mjs), attachée à
// l'agent par une vraie ligne `mcp_servers`. Seul le modèle est simulé.
//
// Ce qui est relu, ce sont des faits : la ligne `approval_requests` posée
// pendant l'appel, ce que le SERVEUR dit avoir reçu (il le renvoie comme
// résultat de son outil, dans le transcript persisté), le statut du job.
//
//   1. serveur demande → ligne → réponse (formulaire validé) → le serveur reçoit
//      exactement ce qui a été rempli, le job continue et se termine ;
//   2. même chose en refus : le serveur lit `decline` ;
//   3. une élicitation tranchée n'est JAMAIS relue comme un appel approuvé à la
//      reprise d'un job (étape 11.7) : sinon l'outil MCP qui l'a posée serait
//      réexécuté.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  approvalRequests,
  approvalRules,
  mcpServers,
  agentMcpServers,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import type { JobId } from '@nodal-agents/orchestration';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../../packages/adapters/mcp/src/tests/fixtures/mcp-elicit-server.mjs',
    import.meta.url,
  ),
);

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
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('mcp-elicitation-flow.test: no active LLM client');
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

const testEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  EMBEDDING_PROVIDER: 'keyword',
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
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
  // Court : un run qui attendrait une question que personne ne pose finit vite.
  NODALAI_ELICITATION_TIMEOUT_MS: 20_000,
} as unknown as RunnerEnv;

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: false })
    .where(eq(agents.id, seed.agentId));
  const [server] = await db
    .insert(mcpServers)
    .values({
      entityId: seed.entityId,
      name: 'Printer',
      slug: 'printer',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envVars: {},
      active: true,
    })
    .returning();
  await db.insert(agentMcpServers).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    mcpServerId: server!.id,
    enabledTools: null,
  });
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

async function createJob(task: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  return job!.id;
}

async function setRule(action: 'auto_approve' | 'require_approval'): Promise<void> {
  await db.delete(approvalRules).where(eq(approvalRules.toolName, 'printer__order'));
  await db.insert(approvalRules).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    toolName: 'printer__order',
    action,
  });
}

/** Tous les textes de résultats d'outils du transcript persisté. */
async function toolResultTexts(jobId: string): Promise<string[]> {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  const out: string[] = [];
  for (const msg of (row?.messages ?? []) as Array<{ role: string; content: unknown }>) {
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

async function elicitationsOf(jobId: string) {
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.kind, 'elicitation')));
}

/** Attendre que le serveur ait posé sa question pendant l'appel en cours. */
async function waitForQuestion(jobId: string): Promise<string> {
  for (let i = 0; i < 1500; i++) {
    const [row] = (await elicitationsOf(jobId)).filter((r) => r.status === 'pending');
    if (row) return row.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the MCP server never asked its question');
}

const ORDER_CALL = {
  toolCallId: 'tc-print-1',
  toolName: 'printer__order',
  args: { purpose: 'Print the report' },
};
const FINISH: MockResponse = {
  text: 'Done.',
  toolCalls: [{ toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } }],
};

describe('une question de serveur MCP, de bout en bout @cap:approuver-une-action/moteur', () => {
  it('serveur demande → ligne → réponse → le serveur reçoit le formulaire rempli', async () => {
    await setRule('auto_approve');
    const jobId = await createJob('print the report');
    const run = executeJob(
      jobId as JobId,
      makeDeps(makeMockLlmClient([{ toolCalls: [ORDER_CALL] }, FINISH])),
      testEnv,
    );

    const questionId = await waitForQuestion(jobId);
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, questionId));
    expect(row!.toolName).toBe('printer__order');
    expect(row!.toolCallId).toBe('tc-print-1');
    expect(row!.toolInput).toMatchObject({
      server: 'printer',
      message: 'How should "report.pdf" be printed?',
    });
    // Le job travaille, il n'est pas suspendu.
    const [during] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(during!.status).toBe('processing');

    const resolved = await resolveApprovalDecision(makeDeps(makeMockLlmClient([FINISH])), testEnv, {
      approvalRequestId: questionId,
      decision: 'approve',
      resolvedBy: 'api',
      content: { color: 'grayscale', copies: 2, duplex: true },
    });
    expect(resolved).toMatchObject({ ok: true, resumed: 'in_process' });

    const result = await run;
    expect(result.status).toBe('completed');
    // Ce que le SERVEUR a reçu, renvoyé par son outil : exactement le formulaire.
    const texts = await toolResultTexts(jobId);
    expect(
      texts.some((t) =>
        t.includes('{"action":"accept","content":{"color":"grayscale","copies":2,"duplex":true}}'),
      ),
    ).toBe(true);
    const [answered] = await elicitationsOf(jobId);
    expect(answered!.status).toBe('approved');
    expect(answered!.response).toEqual({ color: 'grayscale', copies: 2, duplex: true });
  }, 60_000);

  it('Refuser : le serveur lit decline, et le job continue', async () => {
    await setRule('auto_approve');
    const jobId = await createJob('print the report');
    const run = executeJob(
      jobId as JobId,
      makeDeps(makeMockLlmClient([{ toolCalls: [ORDER_CALL] }, FINISH])),
      testEnv,
    );
    const questionId = await waitForQuestion(jobId);
    await resolveApprovalDecision(makeDeps(makeMockLlmClient([FINISH])), testEnv, {
      approvalRequestId: questionId,
      decision: 'reject',
      resolvedBy: 'api',
    });
    expect((await run).status).toBe('completed');
    const texts = await toolResultTexts(jobId);
    expect(texts.some((t) => t.includes('{"action":"decline","content":null}'))).toBe(true);
  }, 60_000);

  it('à la reprise d’un job, une élicitation tranchée n’est jamais relue comme un appel à exécuter', async () => {
    await setRule('require_approval');
    const jobId = await createJob('print the report');
    const llm = makeMockLlmClient([{ toolCalls: [ORDER_CALL] }, FINISH]);

    // L'appel MCP est gaté : le job se suspend, rien n'a encore tourné.
    expect((await executeJob(jobId as JobId, makeDeps(llm), testEnv)).status).toBe(
      'awaiting_approval',
    );
    const [gate] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.kind, 'approval')));
    expect(gate!.toolCallId).toBe('tc-print-1');

    // Une élicitation ACCEPTÉE du même appel, sans `executed_at` : le pire cas
    // (une ligne héritée, ou une régression de sa marque de naissance). Seul
    // le filtre sur `kind` doit la tenir hors de la reprise.
    const [answered] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId,
        agentId: seed.agentId,
        toolName: 'printer__order',
        toolCallId: 'tc-print-1',
        toolInput: {
          server: 'printer',
          message: 'How should "report.pdf" be printed?',
          requestedSchema: { type: 'object', properties: {} },
        },
        kind: 'elicitation',
        status: 'approved',
        response: {},
      })
      .returning();

    // La personne refuse l'appel : le job reprend.
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, jobId));
    await resolveApprovalDecision(makeDeps(llm), testEnv, {
      approvalRequestId: gate!.id,
      decision: 'reject',
      resolvedBy: 'api',
    });
    expect((await executeJob(jobId as JobId, makeDeps(llm), testEnv)).status).toBe('completed');

    // L'élicitation n'a été ni réservée ni consignée comme un appel exécuté.
    const [after] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, answered!.id));
    expect(after!.executionClaim).toBeNull();
    expect(after!.executionOutput).toBeNull();
    expect(after!.executedAt).toBeNull();
    // Le serveur n'a jamais été appelé : aucune de ses réponses au transcript,
    // aucune nouvelle question posée.
    const texts = await toolResultTexts(jobId);
    expect(texts.some((t) => t.includes('"action"'))).toBe(false);
    expect(await elicitationsOf(jobId)).toHaveLength(1);
  }, 60_000);
});
