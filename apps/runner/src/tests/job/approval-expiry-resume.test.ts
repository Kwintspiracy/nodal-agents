// approval-expiry-resume.test.ts — issue #349 : une demande d'approbation échue
// expire, et le travail qui l'attendait REPREND.
//
// Le bogue : `expires_at` était écrit à la création, affiché sur la carte, et
// jamais appliqué. Une demande sans réponse restait `pending` pour toujours.
//
// Ce qui est relu ici, ce sont les LIGNES en base et le transcript PERSISTÉ du
// job après la reprise — jamais un compteur d'appels. Les deux genres passent :
// une approbation d'outil (`kind = 'approval'`, ici un `run_command` gaté) et
// une question posée à l'humain (`kind = 'question'`, un `ask_user`).
//
// Harnais (LLM factice, testEnv, deps, atelier + skill) repris de
// ask-user-flow.test.ts et approval-rules-fresh.test.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  approvalRequests,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { expireStaleApprovals } from '../../cron/reset-orphans.ts';
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
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('approval-expiry-resume.test: no active LLM client');
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

/**
 * La phrase EXACTE que le modèle lit à la place de son marqueur d'attente. Elle
 * est écrite ici en toutes lettres, pas importée : un test qui compare la
 * constante à elle-même resterait vert si quelqu'un la vidait.
 */
const EXPIRY_SENTENCE =
  '[EXPIRED] No answer arrived before this request deadline, so it expired. ' +
  'Nothing was done. Ask again if it is still needed.';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let workspaceDir: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));

  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-approval-expiry-')));
  await writeFile(join(workspaceDir, 'emit.js'), "process.stdout.write(process.argv[2] || '');\n");

  const ts = Date.now();
  const [skillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Command execution expiry ${ts}`,
      slug: `command-execution-expiry-${ts}`,
      content: 'run shell commands',
      requiredBuiltins: ['run_command'],
    })
    .returning();
  if (!skillRow) throw new Error('Failed to insert command-execution skill');

  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: skillRow.id,
  });

  await db.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'ws',
    path: workspaceDir,
    position: 0,
  });
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
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

async function createJob(task: string): Promise<{ id: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
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

/** Recule la date limite d'une demande dans le passé, comme le ferait le temps. */
async function backdateDeadline(approvalId: string): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
    .where(eq(approvalRequests.id, approvalId));
}

const RETURN_RESULT_TURN: MockResponse = {
  text: 'I could not get an answer in time.',
  toolCalls: [{ toolCallId: 'tc-rr', toolName: 'return_result', args: { status: 'success' } }],
};

describe('une demande sans réponse expire, et le travail reprend @cap:approuver-une-action/moteur', () => {
  it("un outil gaté : la demande passe en `expired`, le job repart, et le modèle lit l'expiration", async () => {
    const job = await createJob('run one gated command');
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-run-1',
            toolName: 'run_command',
            args: { purpose: 'gated command', command: 'node emit.js hello' },
          },
        ],
      },
      RETURN_RESULT_TURN,
    ]);

    // ── Le travail se suspend sur la demande ─────────────────────────────────
    const suspended = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspended.status).toBe('awaiting_approval');

    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    expect(request!.status).toBe('pending');
    expect((await toolResultTexts(job.id)).some((t) => t.includes('[AWAITING_APPROVAL]'))).toBe(
      true,
    );

    // ── Personne ne répond, la date limite passe, le balayage tranche ────────
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    await backdateDeadline(request!.id);
    const swept = await expireStaleApprovals(db);
    expect(swept).toBeGreaterThanOrEqual(1);

    const [closed] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request!.id));
    expect(closed!.status).toBe('expired');
    expect(closed!.resolvedBy).toBe('system:ttl_expired');
    expect(closed!.resolvedAt).toBeInstanceOf(Date);

    // Le job est reparti : `pending`, prêt pour le worker (le balayage du cron
    // n'a pas de RunnerEnv ici, donc aucun appel HTTP n'est tenté).
    const [flipped] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, job.id));
    expect(flipped!.status).toBe('pending');

    // ── La reprise : le marqueur d'attente cède la place à l'expiration ──────
    const resumed = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumed.status).toBe('completed');

    const texts = await toolResultTexts(job.id);
    expect(texts.some((t) => t.includes('[AWAITING_APPROVAL]'))).toBe(false);
    expect(texts.some((t) => t.includes(EXPIRY_SENTENCE))).toBe(true);
    // La commande gatée n'a JAMAIS tourné : son stdout n'est nulle part.
    expect(texts.some((t) => t.includes('hello'))).toBe(false);

    // Rejouée une fois, jamais deux : la ligne porte son `executed_at`.
    const [stamped] = await db
      .select({ executedAt: approvalRequests.executedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, request!.id));
    expect(stamped!.executedAt).toBeInstanceOf(Date);
  });

  it('une QUESTION suit la même règle : expirée, elle rend une erreur, pas une réponse inventée', async () => {
    const job = await createJob('ask where to write the summary');
    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-ask-1',
            toolName: 'ask_user',
            args: {
              question: 'Where should I write the summary?',
              options: ['The repo README', 'A new file in notes'],
            },
          },
        ],
      },
      RETURN_RESULT_TURN,
    ]);

    const suspended = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(suspended.status).toBe('awaiting_approval');

    const [question] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job.id), eq(approvalRequests.kind, 'question')));
    expect(question!.status).toBe('pending');

    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job.id));
    await backdateDeadline(question!.id);
    await expireStaleApprovals(db);

    const [closed] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, question!.id));
    expect(closed!.status).toBe('expired');
    expect(closed!.resolvedBy).toBe('system:ttl_expired');
    // Aucune réponse n'est inventée pour une question que personne n'a lue.
    expect(closed!.answer).toBeNull();

    const resumed = await executeJob(job.id as JobId, makeDeps(llmClient), testEnv);
    expect(resumed.status).toBe('completed');

    const texts = await toolResultTexts(job.id);
    expect(texts.some((t) => t.includes(EXPIRY_SENTENCE))).toBe(true);
    expect(texts.some((t) => t.includes('The repo README'))).toBe(false);
  });
});
