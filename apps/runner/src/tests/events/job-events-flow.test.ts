// job-events-flow.test.ts — le flux poussé des événements de job (#944), sur le
// VRAI runner : la vraie route `GET /api/events`, les vraies portes (exécution
// d'un job, `ask_user`, `/api/approve`, `failJob`, `finalizeJob*`,
// l'expiration), la vraie base. Seul le modèle est simulé.
//
// Ce qui se prouve, en lisant les événements reçus sur le fil ET les lignes en
// base :
//   1. un job fini pousse UN `job.finished`, avec la réponse que sa ligne porte ;
//      un job en échec, UN `job.failed` ; une porte rejouée ne pousse rien de plus ;
//   2. une question, une approbation, et leur résolution, UN événement chacune ;
//   3. un client qui revient avec son dernier identifiant reçoit ce qu'il a
//      manqué, ou un `resync` — jamais rien ;
//   4. un client d'un autre espace ne reçoit RIEN ;
//   5. sans authentification, la route est refusée hors local-trust.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, cancelJobs, eq, inTransaction } from '@nodal-agents/db';
import { agentJobs, agents, approvalRequests, conversations } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins, stopConversationRunTool } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { createApp } from '../../server.ts';
import { executeJob, maybeResumeParent } from '../../job/execute.ts';
import { takeChannelTurn } from '../../channels/turn.ts';
import { failJob } from '../../job/state.ts';
import { finalizeJobFailure, finalizeJobSuccess } from '../../job/finalize.ts';
import { notifyApprovalCreated } from '../../approvals/notify.ts';
import { expireStaleApprovals } from '../../cron/reset-orphans.ts';
import { closeElicitationsOfLostJobs } from '../../approvals/elicitation.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { readSse, type SseEvent } from '../chat/_sse-reader.ts';

vi.setConfig({ testTimeout: 30_000 });

// ─── LLM client interception (harnais de ask-user-flow.test.ts) ──────────────

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
      if (!active) throw new Error('job-events-flow.test: no active LLM client');
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
  // Un port où rien n'écoute : le `triggerWorker` de /api/approve échoue tout
  // de suite, et la reprise est jouée par le test lui-même.
  PORT: 1,
  BIND: '127.0.0.1',
  APP_URL: 'http://127.0.0.1:1',
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
/** Un second espace, sur la même base : il ne doit rien entendre du premier. */
let other: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  other = await seedMinimal(db);
  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));
});

function makeDeps(
  llmClient: RunnerDeps['llmClient'] = makeMockLlmClient([{ text: 'unused' }]),
  authProvider: RunnerDeps['authProvider'] = new LocalTrustProvider(),
): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider,
    close: async () => {},
  };
}

async function newConversation(entityId = seed.entityId, agentId = seed.agentId): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId, agentId, title: 'Events' })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function newJob(opts: {
  status: string;
  conversationId?: string;
  entityId?: string;
  agentId?: string;
}): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: opts.entityId ?? seed.entityId,
      agentId: opts.agentId ?? seed.agentId,
      channel: 'api',
      task: 'push stream test',
      status: opts.status,
      messages: [],
      chainCount: 0,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

// ─── Le fil ──────────────────────────────────────────────────────────────────

const opened: AbortController[] = [];
afterEach(() => {
  for (const ctl of opened.splice(0)) ctl.abort();
});

interface Listener {
  res: Response;
  events: SseEvent[];
  /** Les événements de job (sans `ready` ni `resync`). */
  jobEvents: () => SseEvent[];
  close: () => void;
}

async function listen(
  app: ReturnType<typeof createApp>,
  query: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Listener> {
  const ctl = new AbortController();
  opened.push(ctl);
  const res = await app.fetch(
    new Request(`http://localhost/api/events?${new URLSearchParams(query).toString()}`, {
      headers,
      signal: ctl.signal,
    }),
  );
  if (res.status !== 200) {
    return { res, events: [], jobEvents: () => [], close: () => ctl.abort() };
  }
  const reader = readSse(res);
  await waitFor(() => reader.events.length > 0);
  return {
    res,
    events: reader.events,
    jobEvents: () => reader.events.filter((e) => e.event !== 'ready' && e.event !== 'resync'),
    close: () => ctl.abort(),
  };
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor: condition never met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Laisse le temps à un événement de trop d'arriver, s'il devait arriver. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

const ofJob = (events: SseEvent[], jobId: string): SseEvent[] =>
  events.filter((e) => (e.data as { jobId?: string } | null)?.jobId === jobId);

const QUESTION = 'Where should I write the summary?';
const OPTIONS = ['The repo README', 'A new file in notes'];

describe('le flux poussé des événements de job (#944) @cap:suivre-execution/moteur', () => {
  it('un job lancé depuis une conversation : sa question, sa réponse et sa fin, un événement chacune, à la conversation', async () => {
    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-ask-1',
              toolName: 'ask_user',
              args: { question: QUESTION, options: OPTIONS },
            },
          ],
        },
        {
          text: 'Written to a new file in notes.',
          toolCalls: [
            { toolCallId: 'tc-rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );
    const app = createApp(deps, testEnv);
    const conv = await newConversation();
    const elsewhere = await newConversation();
    const job = await newJob({ status: 'pending', conversationId: conv });

    const thisConversation = await listen(app, { entityId: seed.entityId, conversationId: conv });
    const anotherConversation = await listen(app, {
      entityId: seed.entityId,
      conversationId: elsewhere,
    });
    const anotherWorkspace = await listen(app, { entityId: other.entityId });
    expect(thisConversation.events[0]?.event).toBe('ready');

    // ── La question ──────────────────────────────────────────────────────────
    const suspended = await executeJob(job as JobId, deps, testEnv);
    expect(suspended.status).toBe('awaiting_approval');
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, job), eq(approvalRequests.kind, 'question')));
    await waitFor(() => thisConversation.jobEvents().length >= 1);
    await settle();
    expect(thisConversation.jobEvents()).toHaveLength(1);
    expect(thisConversation.jobEvents()[0]).toMatchObject({
      event: 'question.asked',
      data: {
        type: 'question.asked',
        approvalId: row!.id,
        jobId: job,
        conversationId: conv,
        kind: 'question',
        text: QUESTION,
        options: OPTIONS,
      },
    });

    // ── La réponse, par la vraie route ───────────────────────────────────────
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, job));
    const answered = await app.fetch(
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalRequestId: row!.id,
          decision: 'approve',
          answer: OPTIONS[1],
          responderUserId: seed.userId,
        }),
      }),
    );
    expect(answered.status).toBe(200);
    await waitFor(() => thisConversation.jobEvents().length >= 2);
    expect(thisConversation.jobEvents()[1]).toMatchObject({
      event: 'approval.resolved',
      data: { approvalId: row!.id, jobId: job, kind: 'question', status: 'approved' },
    });

    // ── La fin, avec la réponse que la ligne porte ───────────────────────────
    const resumed = await executeJob(job as JobId, deps, testEnv);
    expect(resumed.status).toBe('completed');
    const [done] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, job));
    expect(done!.status).toBe('completed');
    expect(done!.result).toContain('Written to a new file in notes.');
    await waitFor(() => thisConversation.jobEvents().length >= 3);
    await settle();
    expect(thisConversation.jobEvents().map((e) => e.event)).toEqual([
      'question.asked',
      'approval.resolved',
      'job.finished',
    ]);
    expect(thisConversation.jobEvents()[2]!.data).toEqual({
      type: 'job.finished',
      jobId: job,
      conversationId: conv,
      parentJobId: null,
      status: 'completed',
      reply: done!.result,
    });

    // Une autre conversation du même espace, et un autre espace : rien.
    expect(anotherConversation.jobEvents()).toEqual([]);
    expect(anotherWorkspace.jobEvents()).toEqual([]);
  });

  it('un job fini par la porte de succès pousse UN job.finished ; la porte rejouée ne pousse rien', async () => {
    const app = createApp(makeDeps(), testEnv);
    const all = await listen(app, { entityId: seed.entityId });
    const job = await newJob({ status: 'processing' });

    const first = await finalizeJobSuccess(db as never, {
      jobId: job,
      result: 'Le rapport est prêt.',
      resultKind: 'prose',
      repairTurn: 'unsupported',
    });
    expect(first.kind).not.toBe('already_terminal');
    const again = await finalizeJobSuccess(db as never, {
      jobId: job,
      result: 'Une seconde fois.',
      resultKind: 'prose',
      repairTurn: 'unsupported',
    });
    expect(again.kind).toBe('already_terminal');

    await waitFor(() => ofJob(all.events, job).length >= 1);
    await settle();
    expect(ofJob(all.events, job)).toEqual([
      expect.objectContaining({
        event: 'job.finished',
        data: expect.objectContaining({ status: 'completed', reply: 'Le rapport est prêt.' }),
      }),
    ]);
  });

  it('la réponse poussée est masquée de ses secrets, pour tout client (SECRET-001)', async () => {
    const app = createApp(makeDeps(), testEnv);
    const all = await listen(app, { entityId: seed.entityId });
    const secret = 'sk-ant-api03-QRSTUVWXYZ0123456789ABCDEFGHIJ'; // secrets:allow (fixture : clé factice)
    const job = await newJob({ status: 'processing' });
    await finalizeJobSuccess(db as never, {
      jobId: job,
      result: `La clé est ${secret}.`,
      resultKind: 'prose',
      repairTurn: 'unsupported',
    });
    await waitFor(() => ofJob(all.events, job).length >= 1);
    const reply = (ofJob(all.events, job)[0]!.data as { reply: string }).reply;
    expect(reply).not.toContain(secret);
    expect(reply).toContain('La clé est');
  });

  it('un job en échec pousse UN job.failed, avec son code et la première ligne de son explication', async () => {
    const app = createApp(makeDeps(), testEnv);
    const all = await listen(app, { entityId: seed.entityId });

    // Par `failJob` (la porte des quarante chemins d'échec de la boucle)…
    const viaFailJob = await newJob({ status: 'processing' });
    expect(
      await failJob(
        db as never,
        viaFailJob,
        'quota_exhausted',
        undefined,
        undefined,
        'Le fournisseur a refusé.\nDétail technique.',
      ),
    ).toBe(true);
    // …rejouée sur un job déjà fini : rien n'atterrit, rien n'est poussé.
    expect(await failJob(db as never, viaFailJob, 'again')).toBe(false);

    // …et par `finalizeJobFailure`, qui échoue le job DANS sa transaction.
    const viaFinalize = await newJob({ status: 'processing' });
    expect(
      await finalizeJobFailure(db as never, {
        jobId: viaFinalize,
        errorCode: 'shell_policy_invalid',
      }),
    ).toBe(true);

    await waitFor(
      () => ofJob(all.events, viaFailJob).length >= 1 && ofJob(all.events, viaFinalize).length >= 1,
    );
    await settle();
    expect(ofJob(all.events, viaFailJob)).toEqual([
      expect.objectContaining({
        event: 'job.failed',
        data: expect.objectContaining({
          error: 'quota_exhausted',
          reason: 'Le fournisseur a refusé.',
        }),
      }),
    ]);
    const [finalized] = await db
      .select({ result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, viaFinalize));
    expect(ofJob(all.events, viaFinalize)).toEqual([
      expect.objectContaining({
        event: 'job.failed',
        data: expect.objectContaining({
          error: 'shell_policy_invalid',
          // L'explication que la porte d'échec garantit, relue sur la ligne.
          reason: finalized!.result!.split('\n')[0]!.trim(),
        }),
      }),
    ]);
    expect(finalized!.result!.trim()).not.toBe('');
  });

  it("une approbation demandée puis expirée : un approval.requested avec la raison de l'agent, puis un approval.resolved", async () => {
    const deps = makeDeps();
    const app = createApp(deps, testEnv);
    const conv = await newConversation();
    const job = await newJob({ status: 'awaiting_approval', conversationId: conv });
    const stream = await listen(app, { entityId: seed.entityId, conversationId: conv });
    const toolInput = { command: 'rm -rf out', purpose: 'Clear the stale build output.' };
    const [req] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job,
        agentId: seed.agentId,
        toolName: 'run_command',
        toolInput,
        kind: 'approval',
        status: 'pending',
      })
      .returning({ id: approvalRequests.id });

    await notifyApprovalCreated(deps, {
      approvalRequestId: req!.id,
      toolName: 'run_command',
      toolInput,
      jobId: job,
      agentId: seed.agentId,
      entityId: seed.entityId,
      kind: 'approval',
    });
    await waitFor(() => stream.jobEvents().length >= 1);
    expect(stream.jobEvents()[0]!.data).toEqual({
      type: 'approval.requested',
      approvalId: req!.id,
      jobId: job,
      conversationId: conv,
      kind: 'approval',
      toolName: 'run_command',
      text: 'Clear the stale build output.',
    });

    await db
      .update(approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvalRequests.id, req!.id));
    expect(await expireStaleApprovals(db as never)).toBe(1);
    await waitFor(() => stream.jobEvents().length >= 2);
    await settle();
    expect(stream.jobEvents()).toHaveLength(2);
    expect(stream.jobEvents()[1]!.data).toMatchObject({
      type: 'approval.resolved',
      approvalId: req!.id,
      status: 'expired',
    });
  });

  it("la question d'un serveur MCP : un question.asked avec son message, puis un approval.resolved quand son job n'a plus de runner", async () => {
    const deps = makeDeps();
    const app = createApp(deps, testEnv);
    const conv = await newConversation();
    const job = await newJob({ status: 'processing', conversationId: conv });
    const stream = await listen(app, { entityId: seed.entityId, conversationId: conv });
    const toolInput = {
      server: 'calendar',
      message: 'Which calendar should I use?',
      requestedSchema: { type: 'object', properties: {} },
      actions: {},
    };
    const [req] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job,
        agentId: seed.agentId,
        toolName: 'mcp_calendar__create_event',
        toolInput,
        kind: 'elicitation',
        status: 'pending',
        executedAt: new Date(),
      })
      .returning({ id: approvalRequests.id });

    await notifyApprovalCreated(deps, {
      approvalRequestId: req!.id,
      toolName: 'mcp_calendar__create_event',
      toolInput,
      jobId: job,
      agentId: seed.agentId,
      entityId: seed.entityId,
      kind: 'elicitation',
    });
    await waitFor(() => stream.jobEvents().length >= 1);
    expect(stream.jobEvents()[0]!.data).toEqual({
      type: 'question.asked',
      approvalId: req!.id,
      jobId: job,
      conversationId: conv,
      kind: 'elicitation',
      text: 'Which calendar should I use?',
      options: [],
    });

    expect(await closeElicitationsOfLostJobs(db as never, [job])).toBe(1);
    await waitFor(() => stream.jobEvents().length >= 2);
    await settle();
    expect(stream.jobEvents()).toHaveLength(2);
    expect(stream.jobEvents()[1]!.data).toMatchObject({
      type: 'approval.resolved',
      approvalId: req!.id,
      kind: 'elicitation',
      status: 'expired',
    });
  });

  it("revenir avec son dernier identifiant rejoue ce qui a été manqué ; un identifiant d'un autre runner rend un resync", async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await newConversation();
    const first = await listen(app, { entityId: seed.entityId, conversationId: conv });
    const lastSeen = first.events.at(-1)!.id!;
    first.close();

    // Pendant l'absence : un job de la conversation finit, un autre ailleurs.
    const missed = await newJob({ status: 'processing', conversationId: conv });
    await failJob(db as never, missed, 'no_progress_detected');
    const notMine = await newJob({ status: 'processing' });
    await failJob(db as never, notMine, 'no_progress_detected');

    // Par l'en-tête standard…
    const back = await listen(
      app,
      { entityId: seed.entityId, conversationId: conv },
      { 'Last-Event-ID': lastSeen },
    );
    await waitFor(() => back.events.some((e) => e.event === 'ready'));
    expect(back.events.map((e) => e.event)).toEqual(['job.failed', 'ready']);
    expect((back.events[0]!.data as { jobId: string }).jobId).toBe(missed);
    // …ou par le paramètre, pour un client qui ne pose pas d'en-tête.
    const byQuery = await listen(app, {
      entityId: seed.entityId,
      conversationId: conv,
      lastEventId: lastSeen,
    });
    await waitFor(() => byQuery.events.some((e) => e.event === 'ready'));
    expect(byQuery.events.map((e) => e.event)).toEqual(['job.failed', 'ready']);

    // Un identifiant d'un runner qui n'est plus là : relire la base.
    const stale = await listen(
      app,
      { entityId: seed.entityId, conversationId: conv },
      { 'Last-Event-ID': 'deadbeef0000:3' },
    );
    expect(stale.events).toEqual([
      expect.objectContaining({
        event: 'resync',
        data: { type: 'resync', reason: 'runner_restarted' },
      }),
    ]);
    // Le resync porte un point de reprise : le client ne repart pas de rien.
    expect(stale.events[0]!.id).toMatch(/:\d+$/);
  });

  it("un client d'un autre espace ne reçoit rien, ni en direct ni en reprise", async () => {
    const app = createApp(makeDeps(), testEnv);
    const intruder = await listen(app, { entityId: other.entityId });
    const cursor = intruder.events.at(-1)!.id!;
    const job = await newJob({ status: 'processing' });
    await failJob(db as never, job, 'no_progress_detected');
    await settle();
    expect(intruder.jobEvents()).toEqual([]);
    const back = await listen(app, { entityId: other.entityId }, { 'Last-Event-ID': cursor });
    await waitFor(() => back.events.some((e) => e.event === 'ready'));
    expect(back.events.map((e) => e.event)).toEqual(['ready']);
    // Et une conversation d'un autre espace ne s'écoute pas.
    const theirConv = await newConversation(other.entityId, other.agentId);
    const refused = await listen(app, { entityId: seed.entityId, conversationId: theirConv });
    expect(refused.res.status).toBe(404);
  });
});

describe('GET /api/events — la garde (#944) @cap:se-connecter/moteur', () => {
  it('local-auth : sans le secret, 401 ; avec, le flux', async () => {
    const app = createApp(makeDeps(undefined, { getSession: async () => null }), {
      ...testEnv,
      AUTH_MODE: 'local-auth',
    });
    const anonymous = await listen(app, { entityId: seed.entityId });
    expect(anonymous.res.status).toBe(401);
    expect(await anonymous.res.json()).toEqual({ error: 'AUTH_REQUIRED' });
    const trusted = await listen(
      app,
      { entityId: seed.entityId },
      { Authorization: 'Bearer test-secret' },
    );
    expect(trusted.res.status).toBe(200);
    expect(trusted.events[0]?.event).toBe('ready');
  });

  it('bearer-token : une session ne lit que SON espace ; sans session, 401', async () => {
    const app = createApp(
      makeDeps(undefined, {
        getSession: async (req: Request) =>
          req.headers.get('authorization') === 'Bearer session-of-other'
            ? { userId: other.userId, entityId: other.entityId }
            : null,
      }),
      { ...testEnv, AUTH_MODE: 'bearer-token', BEARER_TOKEN: 'token' },
    );
    expect((await listen(app, { entityId: seed.entityId })).res.status).toBe(401);
    const foreign = await listen(
      app,
      { entityId: seed.entityId },
      { Authorization: 'Bearer session-of-other' },
    );
    expect(foreign.res.status).toBe(403);
    const own = await listen(
      app,
      { entityId: other.entityId },
      { Authorization: 'Bearer session-of-other' },
    );
    expect(own.res.status).toBe(200);
  });
});

describe("l'arrêt d'un run et la cascade passent par la porte des fins de job (#944, revue de #956) @cap:suivre-execution/moteur", () => {
  /** Un run vivant de `conv` : sa tête, un délégué suspendu sur une question. */
  async function liveRun(conv: string) {
    const head = await newJob({ status: 'awaiting_delegation', conversationId: conv });
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'delegated step',
        status: 'awaiting_approval',
        messages: [],
        chainCount: 0,
        parentJobId: head,
        conversationId: conv,
      })
      .returning({ id: agentJobs.id });
    const [question] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: child!.id,
        agentId: seed.agentId,
        toolName: 'ask_user',
        toolInput: { question: 'Which one?', options: ['A', 'B'] },
        kind: 'question',
        status: 'pending',
      })
      .returning({ id: approvalRequests.id });
    return { head, child: child!.id, question: question!.id };
  }

  const statusOf = async (jobId: string) =>
    (await db.select({ s: agentJobs.status }).from(agentJobs).where(eq(agentJobs.id, jobId)))[0]?.s;

  it("stop_conversation_run : un job.finished par job de l'arbre, un approval.resolved par question close", async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await newConversation();
    const caller = await newJob({ status: 'processing', conversationId: conv });
    const run = await liveRun(conv);
    const stream = await listen(app, { entityId: seed.entityId, conversationId: conv });

    const out = await stopConversationRunTool.execute({}, {
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: caller,
    } as never);
    expect(out.stopped).toEqual([
      expect.objectContaining({ run_id: run.head, closed_request_ids: [run.question] }),
    ]);
    expect(await statusOf(run.head)).toBe('cancelled');
    expect(await statusOf(run.child)).toBe('cancelled');

    await waitFor(() => stream.jobEvents().length >= 3);
    await settle();
    const events = stream.jobEvents();
    expect(events).toHaveLength(3);
    expect(ofJob(events, run.head).map((e) => e.data)).toEqual([
      expect.objectContaining({ type: 'job.finished', status: 'cancelled', parentJobId: null }),
    ]);
    expect(ofJob(events, run.child).map((e) => e.event)).toEqual([
      'job.finished',
      'approval.resolved',
    ]);
    expect(events.find((e) => e.event === 'approval.resolved')!.data).toMatchObject({
      approvalId: run.question,
      kind: 'question',
      status: 'expired',
    });
    // L'appelant n'est pas arrêté : rien sur lui.
    expect(ofJob(events, caller)).toEqual([]);
  });

  it("/stop d'un canal : poussé APRÈS le COMMIT de la transaction du message, et jamais sur un ROLLBACK", async () => {
    const app = createApp(makeDeps(), testEnv);
    const [conv] = await db
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        title: 'Telegram',
        channel: 'telegram',
        chatId: '4242',
      })
      .returning({ id: conversations.id });
    const stream = await listen(app, { entityId: seed.entityId, conversationId: conv!.id });
    const stop = (tx: never) =>
      takeChannelTurn({
        tx,
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '4242',
        text: '/stop',
        groupPrefix: null,
        botHandle: null,
      });

    // Le message est rejeté après l'arrêt : rien n'a eu lieu, rien n'est dit.
    const head = await newJob({ status: 'processing', conversationId: conv!.id });
    await expect(
      inTransaction(db as never, async (tx) => {
        await stop(tx as never);
        throw new Error('the inbound transaction fails');
      }),
    ).rejects.toThrow('the inbound transaction fails');
    expect(await statusOf(head)).toBe('processing');
    await settle();
    expect(stream.jobEvents()).toEqual([]);

    // Commis : la tête annulée est poussée, une fois, après le COMMIT.
    let seenInside = -1;
    await inTransaction(db as never, async (tx) => {
      await stop(tx as never);
      await settle();
      seenInside = stream.jobEvents().length;
    });
    expect(seenInside).toBe(0);
    expect(await statusOf(head)).toBe('cancelled');
    await waitFor(() => stream.jobEvents().length >= 1);
    await settle();
    expect(stream.jobEvents()).toEqual([
      expect.objectContaining({
        event: 'job.finished',
        data: expect.objectContaining({ jobId: head, status: 'cancelled' }),
      }),
    ]);
  });

  it("un enfant annulé fait annuler le parent qui l'attendait : UN job.finished pour le parent", async () => {
    const app = createApp(makeDeps(), testEnv);
    const conv = await newConversation();
    const stream = await listen(app, { entityId: seed.entityId, conversationId: conv });
    const parent = await newJob({ status: 'awaiting_delegation', conversationId: conv });
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'child',
        status: 'cancelled',
        messages: [],
        chainCount: 0,
        parentJobId: parent,
      })
      .returning({ id: agentJobs.id });

    await maybeResumeParent(child!.id as JobId, { status: 'cancelled' }, { db: db as never });
    // Rejouée : le parent n'attend plus, la garde ne laisse rien passer.
    await maybeResumeParent(child!.id as JobId, { status: 'cancelled' }, { db: db as never });

    expect(await statusOf(parent)).toBe('cancelled');
    await waitFor(() => ofJob(stream.jobEvents(), parent).length >= 1);
    await settle();
    expect(ofJob(stream.jobEvents(), parent)).toEqual([
      expect.objectContaining({
        event: 'job.finished',
        data: expect.objectContaining({ status: 'cancelled', parentJobId: null }),
      }),
    ]);
  });

  it('une porte passée dans une transaction que personne ne suit : aucun fait, un resync', async () => {
    const app = createApp(makeDeps(), testEnv);
    const all = await listen(app, { entityId: seed.entityId });
    const job = await newJob({ status: 'processing' });
    await db.transaction(async (tx) => {
      await cancelJobs(tx as never, { ids: [job] });
    });
    await waitFor(() => all.events.some((e) => e.event === 'resync'));
    expect(ofJob(all.events, job)).toEqual([]);
    expect(all.events.find((e) => e.event === 'resync')!.data).toEqual({
      type: 'resync',
      reason: 'event_lost',
    });
  });
});
