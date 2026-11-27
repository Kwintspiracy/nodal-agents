// open-work-and-gate-answers.test.ts — a run is not closed while work it
// started is open, and what the approval gate answers a delegation is what the
// model reads.
//
// Two mechanisms, one rule ("a guard stops a run only on a fact the runner
// holds, and a run cannot be closed as done while work it started is open"):
//
//   1. The completion gate (`finalizeJobSuccess`, job/finalize.ts) leaves a job
//      that has tasks on the board to the board, whatever way its turn ended
//      (plain text, `return_result`, any channel). The board then derives the
//      job's outcome from ALL its tasks (cron/deliver-results.ts).
//   2. The delegation branch of the job loop (job/execute.ts) hands what the
//      gate returns for an `assign_*` call to the same handling as any tool
//      result: a refusal says it was refused and why, a held call says it
//      waits for a person. A delegation over the resume cap of invariant #8 is
//      refused at the call.
//
// Driven on the real job loop with a scripted model; assertions on the job
// rows, the task rows and the transcript the model reads.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentAssignments,
  agentTasks,
  approvalRequests,
  approvalRules,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { executeReadyTasks } from '../../cron/execute-ready.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import { validateMessageStructure } from '@nodal-agents/llm';
import { deliverCompletedRoots } from '../../cron/deliver-results.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Interceptions ────────────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient, sendTextMock } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
    sendTextMock: vi.fn().mockResolvedValue({ messageId: '777' }),
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const c = getActiveLlmClient();
      if (!c) throw new Error('open-work test: no active LLM client');
      return c;
    },
  };
});

// A channel send reaches no network: the adapter records what it was given.
vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  const adapter = {
    channel: 'telegram' as const,
    capabilities: { buttons: true, threads: false, media: true, editMessage: true },
    sendText: (_creds: unknown, chatId: string, text: string) => sendTextMock({ chatId, text }),
    sendMedia: async () => ({ messageId: '778' }),
    sendApprovalCard: async () => ({ messageId: '779' }),
  };
  return { ...actual, getAdapter: () => adapter };
});

// ─── Scripted model ───────────────────────────────────────────────────────────

interface Reply {
  /** Played before this reply is returned, while the job waits on the model. */
  beforeRespond?: () => Promise<void>;
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

/** The text of the first user message of a request: the job's own request. */
function firstUserText(prompt: unknown): string {
  const msgs = prompt as Array<{ role: string; content: unknown }>;
  const first = msgs.find((m) => m.role === 'user');
  return JSON.stringify(first?.content ?? '');
}

/**
 * A model whose reply is chosen by the job that asks: `byRequest` maps a word of
 * the job's request to the replies that job receives, in order. Board tasks run
 * concurrently, so a single ordered script could not say who gets what.
 */
function scriptedModel(byRequest: Record<string, Reply[]>, prompts: unknown[] = []) {
  const cursor = new Map<string, number>();
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const request = firstUserText(options.prompt);
      const key = Object.keys(byRequest).find((k) => request.includes(k));
      if (!key) throw new Error(`scriptedModel: no script for request ${request.slice(0, 120)}`);
      const replies = byRequest[key]!;
      const i = cursor.get(key) ?? 0;
      cursor.set(key, i + 1);
      const reply = replies[i] ?? replies[replies.length - 1]!;
      if (reply.beforeRespond) await reply.beforeRespond();
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (reply.text) content.push({ type: 'text', text: reply.text });
      for (const tc of reply.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const calls = (reply.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: calls
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
  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
  return client;
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

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
let childSlug: string;
let assignTool: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  // The seed agent leads a team of one.
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
  childSlug = `w01-worker-${Date.now()}`;
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'W01 Worker',
      slug: childSlug,
      personality: 'I do the work I am given.',
      llmKeyId: seed.llmKeyId,
      role: 'agent',
      systemAgent: true,
    })
    .returning();
  await db.insert(agentAssignments).values({
    orchestratorId: seed.agentId,
    subAgentId: child!.id,
    entityId: seed.entityId,
  });
  assignTool = `assign_${childSlug.replace(/-/g, '_')}`;
});

function deps(client: RunnerDeps['llmClient']): RunnerDeps {
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

async function rootJob(
  task: string,
  extra: Partial<typeof agentJobs.$inferInsert> = {},
): Promise<string> {
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
      ...extra,
    })
    .returning();
  return job!.id;
}

async function jobRow(id: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      completedAt: agentJobs.completedAt,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, id));
  return row!;
}

async function tasksOf(rootId: string) {
  return db
    .select({ title: agentTasks.title, status: agentTasks.status, result: agentTasks.result })
    .from(agentTasks)
    .where(eq(agentTasks.rootJobId, rootId));
}

/** The output the model reads for one call, from the persisted transcript. */
function outputOf(messages: unknown, callId: string): string {
  const parts = ((messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === 'tool' && Array.isArray(m.content))
    .flatMap((m) => m.content as Array<{ toolCallId?: string; output?: unknown }>);
  return JSON.stringify(parts.find((p) => p.toolCallId === callId)?.output ?? null);
}

/** Three `create_task` calls to the worker, in one turn. */
function threeTasks(tag: string): Reply {
  return {
    toolCalls: ['A', 'B', 'C'].map((letter) => ({
      toolCallId: `ct-${tag}-${letter}`,
      toolName: 'create_task',
      args: { title: `${tag} part ${letter}`, assigned_to: childSlug },
    })),
  };
}

/** What each task's job answers: A and B deliver, C (when `cFails`) stops blocked. */
function workerScripts(tag: string, cFails: boolean): Record<string, Reply[]> {
  return {
    [`${tag} part A`]: [{ text: `Findings for ${tag} A.` }],
    [`${tag} part B`]: [{ text: `Findings for ${tag} B.` }],
    [`${tag} part C`]: cFails
      ? [
          {
            toolCalls: [
              {
                toolCallId: `rr-${tag}-C`,
                toolName: 'return_result',
                args: { status: 'blocked', reason: 'The source for C was unreachable.' },
              },
            ],
          },
        ]
      : [{ text: `Findings for ${tag} C.` }],
  };
}

// ─── 1. A job does not end while its tasks are open ───────────────────────────

describe('a job with open tasks is not closed, whatever way its turn ends @cap:organiser-equipe/moteur', () => {
  it('ends on TEXT after three create_task: stays open, its tasks run, and one blocked task of three is not a success', async () => {
    const tag = 'TXT1';
    const id = await rootJob(`Compare three suppliers ${tag}`);
    const client = scriptedModel({
      [`suppliers ${tag}`]: [threeTasks(tag), { text: 'I handed this to the team.' }],
      ...workerScripts(tag, true),
    });

    const result = await executeJob(id as JobId, deps(client), testEnv);

    // Not completed: the gate left it to the board.
    expect(result.status).toBe('awaiting_tasks');
    let row = await jobRow(id);
    expect(row.status).toBe('processing');
    expect(row.completedAt).toBeNull();
    expect((await tasksOf(id)).map((t) => t.status).sort()).toEqual(['todo', 'todo', 'todo']);

    // The board runs the tasks: none is refused as "root job cancelled".
    await executeReadyTasks(db, deps(client));
    const tasks = await tasksOf(id);
    expect(tasks.map((t) => t.status).sort()).toEqual(['blocked', 'done', 'done']);
    for (const t of tasks) expect(t.result ?? '').not.toContain('root job cancelled');

    // The last task ended: the root ends with an outcome that counts all three.
    await deliverCompletedRoots(db);
    row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('tasks_not_done (2 of 3 done)');
    expect(row.result).toContain(`Findings for ${tag} A.`);
    expect(row.result).toContain(`Findings for ${tag} B.`);
    expect(row.result).toContain(`## ${tag} part C [blocked]`);
  });

  it('ends on return_result after three create_task: same hand-over, and three done tasks complete it with all three results', async () => {
    const tag = 'RR1';
    const id = await rootJob(`Compare three suppliers ${tag}`);
    const client = scriptedModel({
      [`suppliers ${tag}`]: [
        threeTasks(tag),
        {
          text: 'Handed over.',
          toolCalls: [
            { toolCallId: `rr-${tag}`, toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ],
      ...workerScripts(tag, false),
    });

    const result = await executeJob(id as JobId, deps(client), testEnv);
    expect(result.status).toBe('awaiting_tasks');
    expect((await jobRow(id)).status).toBe('processing');

    await executeReadyTasks(db, deps(client));
    await deliverCompletedRoots(db);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.error).toBeNull();
    for (const letter of ['A', 'B', 'C']) {
      expect(row.result).toContain(`Findings for ${tag} ${letter}.`);
    }
  });

  it('a job whose tasks all ended before its own closing turn still ends through the board, with their results', async () => {
    const tag = 'LATE1';
    const id = await rootJob(`Compare three suppliers ${tag}`);
    // The board runs the three tasks to their end while the root waits on the
    // model for its closing turn: by the time that turn ends, no task is open.
    const client: RunnerDeps['llmClient'] = scriptedModel({
      [`suppliers ${tag}`]: [
        threeTasks(tag),
        {
          beforeRespond: async () => {
            await executeReadyTasks(db, deps(client));
          },
          text: 'All handed over.',
        },
      ],
      ...workerScripts(tag, false),
    });

    const result = await executeJob(id as JobId, deps(client), testEnv);

    expect((await tasksOf(id)).map((t) => t.status)).toEqual(['done', 'done', 'done']);
    expect(result.status).toBe('awaiting_tasks');
    expect((await jobRow(id)).status).toBe('processing');
    await deliverCompletedRoots(db);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    for (const letter of ['A', 'B', 'C']) {
      expect(row.result).toContain(`Findings for ${tag} ${letter}.`);
    }
  });

  it('a job with no task is unchanged: its text ends it, completed, with that text', async () => {
    const id = await rootJob('Say hello NOTASK1');
    const client = scriptedModel({ NOTASK1: [{ text: 'Hello there.' }] });
    const result = await executeJob(id as JobId, deps(client), testEnv);
    expect(result.status).toBe('completed');
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.result).toBe('Hello there.');
  });

  it('through a channel job (Telegram): the acknowledgement is sent, the job stays open, its tasks run', async () => {
    const tag = 'TG1';
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));
    try {
      const id = await rootJob(`Compare three suppliers ${tag}`, {
        channel: 'telegram',
        chatId: '4242',
        chatChannel: 'telegram',
      });
      const client = scriptedModel({
        [`suppliers ${tag}`]: [
          {
            toolCalls: [
              ...threeTasks(tag).toolCalls!,
              {
                toolCallId: `tg-${tag}`,
                toolName: 'telegram_send_message',
                args: { text: 'On it, the team is working.' },
              },
            ],
          },
          { text: 'Handed to the team.' },
        ],
        ...workerScripts(tag, false),
      });
      sendTextMock.mockClear();

      const result = await executeJob(id as JobId, deps(client), testEnv);

      expect(result.status).toBe('awaiting_tasks');
      expect(sendTextMock).toHaveBeenCalledWith({
        chatId: '4242',
        text: 'On it, the team is working.',
      });
      expect((await jobRow(id)).status).toBe('processing');
      await executeReadyTasks(db, deps(client));
      expect((await tasksOf(id)).map((t) => t.status)).toEqual(['done', 'done', 'done']);
    } finally {
      await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
    }
  });

  it('through a dashboard chat job: the same hand-over, and the board completes it', async () => {
    const tag = 'DASH1';
    const id = await rootJob(`Compare three suppliers ${tag}`, { channel: 'dashboard' });
    const client = scriptedModel({
      [`suppliers ${tag}`]: [threeTasks(tag), { text: 'The team has it.' }],
      ...workerScripts(tag, false),
    });
    const result = await executeJob(id as JobId, deps(client), testEnv);
    expect(result.status).toBe('awaiting_tasks');
    await executeReadyTasks(db, deps(client));
    await deliverCompletedRoots(db);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.result).toContain(`Findings for ${tag} B.`);
  });
});

// ─── 2. What the gate answers a delegation is what the model reads ────────────

/**
 * Runs `run` with the lead's autonomy row for the delegation tool set to
 * `action`. A job writes the rows of the tools it holds (#917), so the row may
 * already exist: it is set, then put back as it was.
 */
async function withRule<T>(
  action: 'block' | 'require_approval',
  run: () => Promise<T>,
): Promise<T> {
  const ofTheLead = and(
    eq(approvalRules.entityId, seed.entityId),
    eq(approvalRules.agentId, seed.agentId),
    eq(approvalRules.toolName, assignTool),
  );
  const [before] = await db
    .select({ id: approvalRules.id, action: approvalRules.action })
    .from(approvalRules)
    .where(ofTheLead);
  if (before) {
    await db.update(approvalRules).set({ action }).where(eq(approvalRules.id, before.id));
  } else {
    await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: seed.agentId, toolName: assignTool, action });
  }
  try {
    return await run();
  } finally {
    if (before) {
      await db
        .update(approvalRules)
        .set({ action: before.action })
        .where(eq(approvalRules.id, before.id));
    } else {
      await db.delete(approvalRules).where(ofTheLead);
    }
  }
}

async function childrenOf(id: string) {
  return db.select({ id: agentJobs.id }).from(agentJobs).where(eq(agentJobs.parentJobId, id));
}

describe('a delegation the gate refuses or holds is told as such @cap:organiser-equipe/moteur', () => {
  it('refused by a Block rule: the model reads the refusal and its reason, never "call it again"', async () => {
    await withRule('block', async () => {
      const id = await rootJob('Delegate the survey BLOCK1');
      const client = scriptedModel({
        BLOCK1: [
          {
            toolCalls: [
              {
                toolCallId: 'as-block',
                toolName: assignTool,
                args: { task: 'Run the survey.' },
              },
            ],
          },
          { text: 'I could not delegate it; here is why.' },
        ],
      });
      const result = await executeJob(id as JobId, deps(client), testEnv);
      expect(result.status).toBe('completed');
      const row = await jobRow(id);
      const out = outputOf(row.messages, 'as-block');
      expect(out).toContain('blocked: an approval rule forbids');
      expect(out).not.toContain('call it again');
      expect(out).not.toContain('not executed');
      expect(await childrenOf(id)).toHaveLength(0);
    });
  });

  it('held by an Ask rule: the job waits for the person, the model reads that it waits, never "call it again"', async () => {
    await withRule('require_approval', async () => {
      const id = await rootJob('Delegate the survey ASK0');
      const client = scriptedModel({
        ASK0: [
          {
            toolCalls: [
              {
                toolCallId: 'as-ask0',
                toolName: assignTool,
                args: { task: 'Run the survey.', purpose: 'The survey needs the worker.' },
              },
            ],
          },
          { text: 'Should not be reached while the approval is pending.' },
        ],
      });
      const result = await executeJob(id as JobId, deps(client), testEnv);
      expect(result.status).toBe('awaiting_approval');
      const row = await jobRow(id);
      expect(row.status).toBe('awaiting_approval');
      const out = outputOf(row.messages, 'as-ask0');
      expect(out).toContain('[AWAITING_APPROVAL]');
      expect(out).not.toContain('call it again');
      const pending = await db
        .select({ toolName: approvalRequests.toolName, status: approvalRequests.status })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.jobId, id), eq(approvalRequests.toolName, assignTool)));
      expect(pending).toEqual([{ toolName: assignTool, status: 'pending' }]);
      // Nothing ran: no child exists before the person answers.
      expect(await childrenOf(id)).toHaveLength(0);
    });
  });

  it('past the resume cap of invariant #8: refused at the call with the cap, no child is born', async () => {
    const id = await rootJob('Delegate once more CAP1', { chainCount: 14 });
    const client = scriptedModel({
      CAP1: [
        {
          toolCalls: [
            { toolCallId: 'as-cap', toolName: assignTool, args: { task: 'One more step.' } },
          ],
        },
        { text: 'I did the last step myself.' },
      ],
    });
    const result = await executeJob(id as JobId, deps(client), testEnv);
    expect(result.status).toBe('completed');
    const row = await jobRow(id);
    const out = outputOf(row.messages, 'as-cap');
    expect(out).toContain('delegation_limit_reached');
    expect(out).toContain('at most 14 times');
    expect(await childrenOf(id)).toHaveLength(0);
  });
});

// ─── 3. A delegation a person approved runs, the way every delegation runs ────

describe('a delegation held for a person runs once approved, and says no when refused @cap:organiser-equipe/moteur', () => {
  /** Every block of the transcript that answers `callId`. */
  function answersOf(messages: unknown, callId: string): unknown[] {
    return ((messages ?? []) as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'tool' && Array.isArray(m.content))
      .flatMap((m) => m.content as Array<{ toolCallId?: string }>)
      .filter((p) => p.toolCallId === callId);
  }

  async function pendingRequestOf(id: string): Promise<string> {
    const rows = await db
      .select({ id: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, id), eq(approvalRequests.toolName, assignTool)));
    expect(rows.map((r) => r.status)).toEqual(['pending']);
    return rows[0]!.id;
  }

  async function decide(
    client: RunnerDeps['llmClient'],
    requestId: string,
    decision: 'approve' | 'reject',
    notes?: string,
  ) {
    const decided = await resolveApprovalDecision(deps(client), testEnv, {
      answeredBy: { userId: '00000000-0000-4000-8000-0000000000a1' },
      approvalRequestId: requestId,
      decision,
      resolvedBy: 'api',
      ...(notes !== undefined ? { notes } : {}),
    });
    expect(decided.ok).toBe(true);
  }

  /** The held call, approved: one child, one answer for the call, the child's record in it. */
  async function expectDelegatedOnce(id: string, callId: string, childText: string) {
    const children = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, id));
    expect(children).toEqual([{ status: 'completed', result: childText }]);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    const answers = answersOf(row.messages, callId);
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0])).toContain(childText);
    expect(JSON.stringify(answers[0])).not.toContain('[AWAITING_APPROVAL]');
    expect(() => validateMessageStructure(row.messages as never)).not.toThrow();
  }

  it('an API job: approved, the child runs and its record replaces the approval marker', async () => {
    await withRule('require_approval', async () => {
      const id = await rootJob('Delegate the survey ASK1');
      const client = scriptedModel({
        // The child's request names its own key first: it holds both words.
        'survey ASK1-child': [{ text: 'Survey results: 12 answers.' }],
        ASK1: [
          {
            toolCalls: [
              {
                toolCallId: 'as-ask1',
                toolName: assignTool,
                args: {
                  task: 'Run the survey ASK1-child.',
                  purpose: 'The survey needs the worker.',
                },
              },
            ],
          },
          { text: 'The survey is done: 12 answers.' },
        ],
      });
      expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe(
        'awaiting_approval',
      );
      expect(await childrenOf(id)).toHaveLength(0);
      const requestId = await pendingRequestOf(id);

      await decide(client, requestId, 'approve');
      const resumed = await executeJob(id as JobId, deps(client), testEnv);

      expect(resumed.status).toBe('completed');
      await expectDelegatedOnce(id, 'as-ask1', 'Survey results: 12 answers.');
      const [closed] = await db
        .select({ executedAt: approvalRequests.executedAt })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId));
      expect(closed?.executedAt).not.toBeNull();
    });
  });

  it('a channel job (Telegram): the person is told it waits, approves, and the call still has one answer', async () => {
    await db
      .update(agents)
      .set({ telegramBotToken: 'fake-token' })
      .where(eq(agents.id, seed.agentId));
    try {
      await withRule('require_approval', async () => {
        const id = await rootJob('Delegate the survey ASKTG', {
          channel: 'telegram',
          chatId: '5151',
          chatChannel: 'telegram',
        });
        const client = scriptedModel({
          'survey ASKTG-child': [{ text: 'Survey results: 7 answers.' }],
          ASKTG: [
            {
              toolCalls: [
                {
                  toolCallId: 'as-asktg',
                  toolName: assignTool,
                  args: {
                    task: 'Run the survey ASKTG-child.',
                    purpose: 'The survey needs the worker.',
                  },
                },
              ],
            },
            // The heads-up turn: the agent tells the person it waits.
            {
              toolCalls: [
                {
                  toolCallId: 'tg-wait',
                  toolName: 'telegram_send_message',
                  args: { text: 'Waiting for your approval to hand the survey over.' },
                },
              ],
            },
            {
              toolCalls: [
                {
                  toolCallId: 'tg-done',
                  toolName: 'telegram_send_message',
                  args: { text: 'Survey done: 7 answers.' },
                },
                { toolCallId: 'rr-asktg', toolName: 'return_result', args: { status: 'success' } },
              ],
            },
          ],
        });
        sendTextMock.mockClear();
        expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe(
          'awaiting_approval',
        );
        expect(await childrenOf(id)).toHaveLength(0);
        const requestId = await pendingRequestOf(id);

        await decide(client, requestId, 'approve');
        const resumed = await executeJob(id as JobId, deps(client), testEnv);

        expect(resumed.status).toBe('completed');
        await expectDelegatedOnce(id, 'as-asktg', 'Survey results: 7 answers.');
        expect(sendTextMock).toHaveBeenCalledWith({
          chatId: '5151',
          text: 'Survey done: 7 answers.',
        });
      });
    } finally {
      await db.update(agents).set({ telegramBotToken: null }).where(eq(agents.id, seed.agentId));
    }
  });

  it('a dashboard chat job: approved, the child runs and the call has one answer', async () => {
    await withRule('require_approval', async () => {
      const id = await rootJob('Delegate the survey ASKDASH', { channel: 'dashboard' });
      const client = scriptedModel({
        'survey ASKDASH-child': [{ text: 'Survey results: 3 answers.' }],
        ASKDASH: [
          {
            toolCalls: [
              {
                toolCallId: 'as-askdash',
                toolName: assignTool,
                args: {
                  task: 'Run the survey ASKDASH-child.',
                  purpose: 'The survey needs the worker.',
                },
              },
            ],
          },
          { text: 'The survey is done: 3 answers.' },
        ],
      });
      expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe(
        'awaiting_approval',
      );
      const requestId = await pendingRequestOf(id);
      await decide(client, requestId, 'approve');
      expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe('completed');
      await expectDelegatedOnce(id, 'as-askdash', 'Survey results: 3 answers.');
    });
  });

  it('refused by the person: no child runs, the model reads a refusal, nothing tells it to call again', async () => {
    await withRule('require_approval', async () => {
      const id = await rootJob('Delegate the survey ASKNO');
      const client = scriptedModel({
        ASKNO: [
          {
            toolCalls: [
              {
                toolCallId: 'as-askno',
                toolName: assignTool,
                args: { task: 'Run the survey.', purpose: 'The survey needs the worker.' },
              },
            ],
          },
          { text: 'Understood, I will not run the survey.' },
        ],
      });
      expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe(
        'awaiting_approval',
      );
      const requestId = await pendingRequestOf(id);
      await decide(client, requestId, 'reject', 'Not this week.');
      expect((await executeJob(id as JobId, deps(client), testEnv)).status).toBe('completed');

      expect(await childrenOf(id)).toHaveLength(0);
      const row = await jobRow(id);
      const answers = answersOf(row.messages, 'as-askno');
      expect(answers).toHaveLength(1);
      const out = JSON.stringify(answers[0]);
      expect(out).toContain('[REJECTED]');
      expect(out).toContain('Not this week.');
      expect(out).not.toContain('call it again');
    });
  });
});
