// failure-notice.test.ts — every job that fails tells the person, where the
// person asked (#1180, #1086).
//
// The rule: "failed" is written in one place (`failJob`, job/state.ts), and that
// place prepares the notice, in the transaction that writes `failed`. Whatever
// the reason, the runtime or the caller, a head job that fails leaves exactly
// one notice for the person, on the surface the request came from; a job with
// a parent tells its parent only.
//
// Asserted on rows: the job row (status, result), the prepared delivery row
// (channel, chat, payload, key), and what a device's stream received. The
// model is scripted, a channel send reaches no network: the adapter records
// the text it was given.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  agentTasks,
  cancelJobs,
  eq,
  jobDeliveries,
  listenToTransitions,
  telegramAllowedChats,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { failJob, setJobStatus } from '../../job/state.ts';
import { failureNoticeKey } from '../../job/failure-notice.ts';
import { resetOrphanedJobs, failStalePendingJobs } from '../../cron/reset-orphans.ts';
import { reclaimJobsOfDeadRunners } from '../../cron/reclaim-jobs.ts';
import { deliverCompletedRoots } from '../../cron/deliver-results.ts';
import { JobEventBus } from '../../events/job-events.ts';
import { transitionListener } from '../../events/publish.ts';

// ─── Interceptions ────────────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient, sent } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
    /** Every text a channel adapter was given, in order. */
    sent: [] as Array<{ chatId: string; text: string }>,
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const c = getActiveLlmClient();
      if (!c) throw new Error('failure-notice test: no active LLM client');
      return c;
    },
  };
});

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  const adapter = {
    channel: 'telegram' as const,
    capabilities: { buttons: true, threads: false, media: true, editMessage: true },
    sendText: async (_creds: unknown, chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: '901' };
    },
    sendMedia: async () => ({ messageId: '902' }),
    sendApprovalCard: async () => ({ messageId: '903' }),
  };
  return { ...actual, getAdapter: () => adapter };
});

// ─── Scripted model ───────────────────────────────────────────────────────────

interface Reply {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function scriptedModel(replies: Reply[]): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const reply = replies[i] ?? replies[replies.length - 1]!;
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (reply.text) content.push({ type: 'text', text: reply.text });
      for (const tc of reply.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: `${tc.toolCallId}-${i}`,
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
  return {
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

/** Everything the transitions of this file pushed to the stream, with the device it went to. */
class RecordingBus extends JobEventBus {
  readonly seen: Array<{
    type: string;
    deviceId: string | null;
    payload: Record<string, unknown>;
  }> = [];
  override publish(
    ...args: Parameters<JobEventBus['publish']>
  ): ReturnType<JobEventBus['publish']> {
    const [, , payload, deviceId] = args;
    this.seen.push({
      type: (payload as { type: string }).type,
      deviceId: deviceId ?? null,
      payload: payload as unknown as Record<string, unknown>,
    });
    return super.publish(...args);
  }
}

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
const bus = new RecordingBus();
let unlisten: () => void = () => {};

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  // The agent has a channel credential: a job asked on a chat can be answered there.
  await db
    .update(agents)
    .set({ telegramBotToken: 'fake-token' })
    .where(eq(agents.id, seed.agentId));
  unlisten = listenToTransitions(transitionListener(bus));
});

afterAll(() => unlisten());

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

type Surface = 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'device' | 'dashboard';

let chatSeq = 1000;

/** A head job asked on `surface`, as the channel handlers write it. */
async function headJob(
  surface: Surface,
  extra: Partial<typeof agentJobs.$inferInsert> = {},
): Promise<{ id: string; chatId: string | null }> {
  chatSeq += 1;
  const chatId = surface === 'dashboard' ? null : `chat-${surface}-${chatSeq}`;
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: surface,
      chatId,
      chatChannel: chatId === null ? null : surface,
      task: `request from ${surface}`,
      status: 'processing',
      messages: [],
      ...extra,
    })
    .returning({ id: agentJobs.id, chatId: agentJobs.chatId });
  return job!;
}

async function rowOf(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      runnerNotes: agentJobs.runnerNotes,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

async function deliveriesOf(jobId: string) {
  return db
    .select({
      channel: jobDeliveries.channel,
      chatId: jobDeliveries.chatId,
      payload: jobDeliveries.payload,
      idempotencyKey: jobDeliveries.idempotencyKey,
    })
    .from(jobDeliveries)
    .where(eq(jobDeliveries.jobId, jobId));
}

/** The one notice the failure of `jobId` must have left, on `chatId` of `channel`. */
async function expectOneNotice(jobId: string, channel: string, chatId: string) {
  const row = await rowOf(jobId);
  expect(row.status).toBe('failed');
  expect((row.result ?? '').trim()).not.toBe('');
  expect(await deliveriesOf(jobId)).toEqual([
    { channel, chatId, payload: row.result, idempotencyKey: failureNoticeKey(jobId) },
  ]);
  return row;
}

// ─── Every failure code: read from the code, not from memory ─────────────────

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The failure codes written as literals at the exits: the native loop, the CLI
 * runtime, the board and the sweepers. A new exit with a new literal code is a
 * new row of the table below, without anyone having to list it.
 */
function literalFailureCodes(): string[] {
  const files = [
    'job/execute.ts',
    'cli-runtime/run-job.ts',
    'cron/reset-orphans.ts',
    'cron/reclaim-jobs.ts',
    'cron/deliver-results.ts',
  ];
  const patterns = [
    // failJob(db, jobId as string, 'code', …) — the loop's and the sweepers' form.
    /\bfailJob\(\s*\w+,\s*[\w.]+(?:\s+as\s+string)?,\s*'([a-z][a-z0-9_]*)'/g,
    // failJobExplained('code', …) — the loop's exits that give their explanation.
    /\bfailJobExplained\(\s*'([a-z][a-z0-9_]*)'/g,
    // fail('code') — the CLI runtime's exits.
    /\bfail\(\s*'([a-z][a-z0-9_]*)'/g,
    // `rootError ?? 'tasks_not_done'` — the board's.
    /\?\?\s*'([a-z][a-z0-9_]*_not_done)'/g,
  ];
  const codes = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(SRC, f), 'utf-8');
    for (const re of patterns) for (const m of src.matchAll(re)) codes.add(m[1]!);
  }
  return [...codes].sort();
}

/**
 * The codes that reach `failJob` through a variable: each named with where it
 * comes from. The table runs them too.
 */
const COMPUTED_CODES = [
  'deliverable_not_verified', // DELIVERABLE_NOT_VERIFIED, the declared-deliverable gate
  'job_row_unreadable', // JOB_ROW_UNREADABLE, the loop and the CLI runtime
  'job_crashed', // failOnUncaughtError: an error raised before or outside the loop
  'token_budget_exceeded', // the loop's budget exits (`code`)
  'llm_timeout', // a typed LLM error (`err.code`)
  'message_structure_invalid:orphan_tool_result', // `message_structure_invalid:${err.code}`
  'runtime_not_supported:unknown-cli', // the CLI runtime, `runtime_not_supported:${…}`
  'runner_restarted', // RUNNER_RESTARTED_CODE, the reclaim
  'tasks_not_done (2 of 3 done)', // the board's `rootError`
  'Missing access to the calendar', // a blocked agent's short reason (`errorMessage`)
];

describe('one writer of failed, one notice per failure @cap:parler-par-canal-externe/moteur', () => {
  const literal = literalFailureCodes();

  it('the scan reads the exits: the codes the audit named are among them', () => {
    for (const named of [
      'unresolved_tool_failure',
      'quota_exhausted',
      'no_progress_detected',
      'telegram_not_delivered',
      'orphan_job_reset',
      'stale_pending_abandoned',
      'empty_deliverable',
      'chain_limit_exceeded',
      'agent_not_found',
      'no_tool_calls_no_text',
    ]) {
      expect(literal).toContain(named);
    }
    expect(literal.length).toBeGreaterThanOrEqual(15);
  });

  it.each([...literal, ...COMPUTED_CODES])(
    '%s: a Telegram head job that fails leaves exactly one notice, its result, on its chat',
    async (code) => {
      const job = await headJob('telegram');
      expect(await failJob(db as never, job.id, code)).toBe(true);
      const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
      // The generic explanation names the code: what the runner knows.
      expect(row.result).toContain(code);
    },
  );

  it('the notice is in the transaction that writes failed: when it cannot be prepared, failed is not written', async () => {
    const job = await headJob('telegram');
    // A row already holds this job's failure-notice key: the preparation fails.
    await db.insert(jobDeliveries).values({
      jobId: job.id,
      channel: 'telegram',
      chatId: job.chatId!,
      payload: 'already there',
      outcome: 'confirmed',
      idempotencyKey: failureNoticeKey(job.id),
      attempts: 1,
    });
    await expect(failJob(db as never, job.id, 'quota_exhausted')).rejects.toThrow();
    const row = await rowOf(job.id);
    expect(row.status).toBe('processing');
    expect(row.result).toBeNull();
  });
});

// ─── Every surface ────────────────────────────────────────────────────────────

describe('where the person asked @cap:parler-par-canal-externe/moteur', () => {
  it.each(['telegram', 'whatsapp', 'discord', 'slack'] as const)(
    'a job asked on %s: the notice goes to that chat, and nowhere else',
    async (channel) => {
      const job = await headJob(channel);
      await failJob(
        db as never,
        job.id,
        'quota_exhausted',
        undefined,
        undefined,
        'The provider refused.',
      );
      const row = await expectOneNotice(job.id, channel, job.chatId!);
      expect(row.result).toBe('The provider refused.');
    },
  );

  it('a designated chat (a routine that asked for its confirmation): the notice goes there', async () => {
    const job = await headJob('dashboard', {
      channel: 'cron',
      chatId: 'routine-chat-1',
      chatChannel: 'telegram',
    });
    await failJob(db as never, job.id, 'no_progress_detected');
    await expectOneNotice(job.id, 'telegram', 'routine-chat-1');
  });

  it('a device job: no outbox row; its stream receives the failure with the explanation', async () => {
    const job = await headJob('device');
    bus.seen.length = 0;
    await failJob(
      db as never,
      job.id,
      'unresolved_tool_failure',
      undefined,
      undefined,
      'The printer refused the file.',
    );
    expect(await deliveriesOf(job.id)).toEqual([]);
    const toDevice = bus.seen.filter(
      (e) => e.type === 'job.failed' && (e.payload['jobId'] as string) === job.id,
    );
    expect(toDevice).toEqual([
      expect.objectContaining({
        deviceId: job.chatId,
        payload: expect.objectContaining({
          error: 'unresolved_tool_failure',
          reason: 'The printer refused the file.',
        }),
      }),
    ]);
    const row = await rowOf(job.id);
    expect(row.result).toBe('The printer refused the file.');
  });

  it('a dashboard chat job: no outbox row; the conversation shows the explanation the row carries', async () => {
    const job = await headJob('dashboard');
    bus.seen.length = 0;
    await failJob(db as never, job.id, 'quota_exhausted');
    expect(await deliveriesOf(job.id)).toEqual([]);
    const row = await rowOf(job.id);
    expect(row.result).toBe(
      '⚠️ The task could not be completed (quota_exhausted) and no explanation was provided.',
    );
    expect(
      bus.seen.filter((e) => e.type === 'job.failed' && e.payload['jobId'] === job.id),
    ).toEqual([
      expect.objectContaining({
        deviceId: null,
        payload: expect.objectContaining({ reason: row.result }),
      }),
    ]);
  });

  it('a job with a chat that no channel can carry: the row says so, nothing is swallowed', async () => {
    // A designated chat whose platform nobody recorded.
    const job = await headJob('dashboard', {
      channel: 'cron',
      chatId: 'chat-x',
      chatChannel: null,
    });
    await failJob(db as never, job.id, 'quota_exhausted');
    expect(await deliveriesOf(job.id)).toEqual([]);
    const row = await rowOf(job.id);
    expect(row.status).toBe('failed');
    expect(row.result).toBe(
      '⚠️ The task could not be completed (quota_exhausted) and no explanation was provided.\n\n' +
        '[this failure could not be sent to the chat: channel_unknown]',
    );
    expect(row.runnerNotes).toContain(
      '[this failure could not be sent to the chat: channel_unknown]',
    );
  });

  it('the notice is sent after the commit, with the explanation, to the chat that asked', async () => {
    const job = await headJob('telegram');
    await db.insert(telegramAllowedChats).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      chatId: job.chatId!,
      status: 'active',
    });
    sent.length = 0;
    await failJob(
      db as never,
      job.id,
      'quota_exhausted',
      undefined,
      undefined,
      'The provider refused.',
    );
    expect(sent).toEqual([{ chatId: job.chatId, text: 'The provider refused.' }]);
    const [delivery] = await db
      .select({ outcome: jobDeliveries.outcome })
      .from(jobDeliveries)
      .where(eq(jobDeliveries.jobId, job.id));
    expect(delivery?.outcome).toBe('confirmed');
  });
});

// ─── A tree: only the person's own job speaks to the person ──────────────────

describe('a child tells its parent, the parent tells the person @cap:parler-par-canal-externe/moteur', () => {
  it('a child fails, then its parent: one notice, from the parent', async () => {
    const parent = await headJob('telegram', { status: 'awaiting_delegation' });
    // A child inherits the chat of its parent: it still answers its parent.
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        chatId: parent.chatId,
        chatChannel: 'telegram',
        parentJobId: parent.id,
        task: 'a delegated step',
        status: 'processing',
        messages: [],
      })
      .returning({ id: agentJobs.id });
    await failJob(db as never, child!.id, 'unresolved_tool_failure');
    expect(await deliveriesOf(child!.id)).toEqual([]);

    await failJob(
      db as never,
      parent.id,
      'agent_blocked',
      undefined,
      undefined,
      'The step failed.',
    );
    await expectOneNotice(parent.id, 'telegram', parent.chatId!);
  });

  it('a delegated child reclaimed by the sweeper tells nobody but its parent', async () => {
    const parent = await headJob('telegram', { status: 'awaiting_delegation' });
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        chatId: parent.chatId,
        chatChannel: 'telegram',
        parentJobId: parent.id,
        task: 'a delegated step',
        status: 'processing',
        messages: [],
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning({ id: agentJobs.id });
    await db
      .update(agentJobs)
      .set({ pendingDelegation: { subJobId: child!.id, toolUseId: 'tu-1', agentSlug: 'x' } })
      .where(eq(agentJobs.id, parent.id));

    await reclaimJobsOfDeadRunners(db as never);

    expect((await rowOf(child!.id)).status).toBe('failed');
    expect(await deliveriesOf(child!.id)).toEqual([]);
    expect(await deliveriesOf(parent.id)).toEqual([]);
  });

  it('a board whose task failed: the person gets one notice that carries the board outcome', async () => {
    const root = await headJob('telegram');
    for (const [title, status, result] of [
      ['Task A', 'done', 'A is done'],
      ['Task B', 'done', 'B is done'],
      ['Task C', 'blocked', 'C could not reach the API'],
    ] as const) {
      await db.insert(agentTasks).values({
        entityId: seed.entityId,
        orchestratorId: seed.agentId,
        assignedAgentId: seed.agentId,
        rootJobId: root.id,
        title,
        status,
        result,
      });
    }
    await deliverCompletedRoots(db as never);
    const row = await expectOneNotice(root.id, 'telegram', root.chatId!);
    expect(row.error).toBe('tasks_not_done (2 of 3 done)');
    expect(row.result).toContain('A is done');
    expect(row.result).toContain('B is done');
    expect(row.result).toContain('C could not reach the API');
  });
});

// ─── The sweepers ─────────────────────────────────────────────────────────────

describe('a job the sweepers fail tells its own surface what was observed @cap:parler-par-canal-externe/moteur', () => {
  const stale = () => new Date(Date.now() - 10 * 60_000);

  it.each(['telegram', 'whatsapp', 'discord'] as const)(
    'reset as orphan from %s: the notice goes to that chat, says the status and the idle time, and names no cause',
    async (channel) => {
      const job = await headJob(channel, { updatedAt: stale() });
      await resetOrphanedJobs(db as never, 5);
      const row = await expectOneNotice(job.id, channel, job.chatId!);
      expect(row.error).toBe('orphan_job_reset');
      expect(row.result).toMatch(/^\[stopped: status processing, not updated for 10m0\ds\]$/);
      expect(row.result).not.toMatch(/restart|redémarr|interrompue|service/i);
    },
  );

  it('reset as orphan from a device: its stream receives it, no outbox row, nothing on any chat', async () => {
    const job = await headJob('device', { updatedAt: stale() });
    bus.seen.length = 0;
    sent.length = 0;
    await resetOrphanedJobs(db as never, 5);
    expect(await deliveriesOf(job.id)).toEqual([]);
    expect(sent).toEqual([]);
    const row = await rowOf(job.id);
    expect(
      bus.seen.filter((e) => e.type === 'job.failed' && e.payload['jobId'] === job.id),
    ).toEqual([
      expect.objectContaining({
        deviceId: job.chatId,
        payload: expect.objectContaining({ error: 'orphan_job_reset', reason: row.result }),
      }),
    ]);
  });

  it('a parent whose awaited child was cancelled: the notice says how the child ended', async () => {
    const parent = await headJob('telegram', { status: 'awaiting_delegation', updatedAt: stale() });
    const [child] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        parentJobId: parent.id,
        task: 'a delegated step',
        status: 'cancelled',
        messages: [],
      })
      .returning({ id: agentJobs.id });
    await db
      .update(agentJobs)
      .set({ pendingDelegation: { subJobId: child!.id }, updatedAt: stale() })
      .where(eq(agentJobs.id, parent.id));
    await resetOrphanedJobs(db as never, 5);
    const row = await expectOneNotice(parent.id, 'telegram', parent.chatId!);
    expect(row.result).toMatch(
      /^\[stopped: status awaiting_delegation, not updated for 10m0\ds; the delegated job it waited on is cancelled\]$/,
    );
  });

  it('a pending job never started: the notice goes to its chat, with the status and the time', async () => {
    const job = await headJob('slack', { status: 'pending', updatedAt: stale() });
    await failStalePendingJobs(db as never, 5 * 60);
    const row = await expectOneNotice(job.id, 'slack', job.chatId!);
    expect(row.error).toBe('stale_pending_abandoned');
    expect(row.result).toMatch(/^\[stopped: status pending, not updated for 10m0\ds\]$/);
  });

  it('a head job reclaimed from a dead runner: one notice on its chat, the observed facts', async () => {
    const job = await headJob('telegram', { updatedAt: stale() });
    await reclaimJobsOfDeadRunners(db as never);
    const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
    expect(row.result).toContain('[stopped: status processing, not updated for ');
    expect(row.result).not.toMatch(/restarted/i);
  });
});

// ─── No failure, no failure notice ────────────────────────────────────────────

describe('a job that did not fail sends no failure notice @cap:parler-par-canal-externe/moteur', () => {
  it('a job the person cancelled: no notice', async () => {
    const job = await headJob('telegram');
    await cancelJobs(db as never, { ids: [job.id] });
    expect((await rowOf(job.id)).status).toBe('cancelled');
    expect(await deliveriesOf(job.id)).toEqual([]);
  });

  it('a job waiting for an approval: no notice', async () => {
    const job = await headJob('telegram');
    await setJobStatus(db as never, job.id, 'awaiting_approval');
    expect(await deliveriesOf(job.id)).toEqual([]);
  });

  it('a job already finished: a second failure writes nothing and prepares nothing', async () => {
    const job = await headJob('telegram');
    expect(await failJob(db as never, job.id, 'quota_exhausted')).toBe(true);
    expect(await failJob(db as never, job.id, 'no_progress_detected')).toBe(false);
    const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
    expect(row.error).toBe('quota_exhausted');
  });
});

// ─── Real exits of the loop: exactly once ─────────────────────────────────────

describe('the exits of the loop leave exactly one notice @cap:parler-par-canal-externe/moteur', () => {
  it('an exit that told nobody before (empty turns): one notice, the explanation', async () => {
    const job = await headJob('telegram', { status: 'pending' });
    const result = await executeJob(job.id as JobId, deps(scriptedModel([{ text: '' }])), testEnv);
    expect(result.status).toBe('failed');
    const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
    expect(row.error).toBe('no_tool_calls_no_text');
  });

  it('nothing delivered on the chat: one notice, the stop line (it had one before, still one)', async () => {
    const job = await headJob('telegram', { status: 'pending' });
    const result = await executeJob(
      job.id as JobId,
      deps(scriptedModel([{ text: 'plain text, never sent' }])),
      testEnv,
    );
    expect(result.status).toBe('failed');
    const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
    expect(row.error).toBe('telegram_not_delivered');
    expect(row.result).toBe('[stopped: nothing was delivered on this channel]');
  });

  it('a blocked agent that already wrote on the chat: one notice, its reason', async () => {
    const job = await headJob('telegram', { status: 'pending' });
    const result = await executeJob(
      job.id as JobId,
      deps(
        scriptedModel([
          {
            toolCalls: [
              {
                toolCallId: 'send',
                toolName: 'telegram_send_message',
                args: { text: 'I cannot reach your calendar.' },
              },
              {
                toolCallId: 'rr',
                toolName: 'return_result',
                args: { status: 'blocked', reason: 'Missing access to the calendar.' },
              },
            ],
          },
        ]),
      ),
      testEnv,
    );
    expect(result.status).toBe('failed');
    const row = await expectOneNotice(job.id, 'telegram', job.chatId!);
    expect(row.result).toBe('Missing access to the calendar.');
  });
});
