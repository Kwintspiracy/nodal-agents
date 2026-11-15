// task-end-said.test.ts — in a chat turn, the end of a task is what the runner
// states, then what the agent told the person (#1088).
//
// The defect, measured on the real turns of 2026-11-14 with the model in
// service: the end of a task reached the chat front as ONE runner record in the
// user role, its report quoted inside it. When the end was the last thing
// before a neutral message ("Tu es là ?"), 5 replies out of 5 said the report
// again: the model read it as input nobody had answered. The job's own result
// IS what the agent told the person when the task ended; the conversation shows
// it as the agent's message, and the history of a job launched from the
// conversation already replays it so (`loadDashboardHistory`).
//
// Second mechanism: the result of a running job said "Do NOT dispatch it again;
// wait for it to finish.", the opposite of `run_task`'s own description (a call
// while a job runs starts a reply turn that sees it).
//
// These tests read what the provider is handed (`doGenerate`'s prompt, the body
// of the request) and the messages the turn passed the client, for a dashboard
// conversation and a device's, spoken and written.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, chatMessages, conversations, entities, toolCalls } from '@nodal-agents/db';
import {
  formatLocalTime,
  isRequestNote,
  runnerRecordEntries,
  runnerRecordMessage,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import {
  LAUNCHED_OUTPUT,
  chatTurnMessages,
  runChatTurn,
  type HistoryRow,
} from '../../chat/run-chat-turn.ts';
import { stoppedReplyNote } from '../../chat/turn-stop.ts';
import {
  dashboardHistoryMessages,
  dashboardHistoryRecordsRequest,
  loadThreadHistory,
  truncate,
  type DashboardHistoryRow,
} from '../../job/thread-history.ts';

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
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('task-end-said.test: no active LLM client');
      return active;
    },
  };
});

interface Seen {
  /** What the provider is handed: the request body, as the mock provider reads it. */
  prompts: unknown[];
  /** The messages the turn passed the client. */
  messages: ModelMessage[][];
}

function recordingClient(seen: Seen): RunnerDeps['llmClient'] {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      seen.prompts.push(options.prompt);
      return {
        content: [{ type: 'text', text: 'Yes, I am here.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      seen.messages.push((args.messages ?? []) as ModelMessage[]);
      return generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

const TZ = 'Europe/Paris';
/** A wall-clock time on 14 Nov 2026, in Paris (UTC+1). */
const at = (hms: string) => new Date(`2026-11-14T${hms}+01:00`);
const dated = (text: string, when: Date) => `[${formatLocalTime(TZ, when)}] ${text}`;
const header = (endedAt: Date, launchedAt: Date, status: string) =>
  dated(`The task launched at ${formatLocalTime(TZ, launchedAt)} ended. ${status}`, endedAt);
const FAILED = 'FAILED — report this to the user with the reason; do not silently retry.';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
  await db.update(entities).set({ timezone: TZ }).where(eq(entities.id, seed.entityId));
});

afterAll(async () => {
  await db.update(entities).set({ timezone: null }).where(eq(entities.id, seed.entityId));
});

beforeEach(async () => {
  await db.delete(toolCalls);
  await db.delete(chatMessages);
  await db.delete(conversations);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, seed.agentId));
});

type Channel = 'dashboard' | 'device';
type Rendering = 'spoken' | 'written';
const CASES: Array<[Channel, Rendering]> = [
  ['dashboard', 'written'],
  ['dashboard', 'spoken'],
  ['device', 'written'],
  ['device', 'spoken'],
];

async function conversation(channel: Channel): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      chatId: channel === 'device' ? 'device-hall' : null,
      title: 'The magazine',
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function say(conv: string, content: string, when: Date, role: 'user' | 'assistant' = 'user') {
  await db.insert(chatMessages).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv,
    role,
    content,
    createdAt: when,
  });
}

interface JobSpec {
  status: string;
  result?: string | null;
  resultKind?: 'prose' | 'relay' | null;
  notes?: string[];
  error?: string | null;
  createdAt: Date;
  completedAt: Date | null;
  stopped?: boolean;
}

/** The agent launches a job: the job, then its words with the job's id, as `runChatTurn` writes them. */
async function launch(
  conv: string,
  channel: Channel,
  words: string,
  when: Date,
  job: JobSpec,
): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      conversationId: conv,
      task: words,
      status: job.status,
      result: job.result ?? null,
      resultKind: job.resultKind ?? null,
      runnerNotes: job.notes ?? [],
      error: job.error ?? null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    })
    .returning({ id: agentJobs.id });
  await db.insert(chatMessages).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv,
    role: 'assistant',
    content: words,
    jobId: row!.id,
    createdAt: when,
    ...(job.stopped ? { stopped: true } : {}),
  });
  return row!.id;
}

async function turn(conv: string, message: string, how: Rendering = 'written') {
  const seen: Seen = { prompts: [], messages: [] };
  setActiveLlmClient(recordingClient(seen));
  const result = await runChatTurn({
    deps,
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv,
    message,
    ...(how === 'spoken' ? { spoken: { durationMs: 1_200 } } : {}),
  });
  expect(result.ok).toBe(true);
  const rows = await db
    .select({ content: chatMessages.content, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conv));
  const sentAt = rows.filter((r) => r.content === message).at(-1)!.createdAt!;
  return {
    /** The messages of the main call, without the trailing note of a spoken reply (#1097). */
    seen: seen.messages[0]!.filter((m) => !isRequestNote(m)),
    prompt: seen.prompts[0] as Array<{ role: string; content: unknown }>,
    sentAt,
  };
}

/** The two messages of a launching turn, as replayed: its words + `run_task`, then its result. */
function launched(jobId: string, words: string, output: string): ModelMessage[] {
  const toolCallId = `hist-${jobId}`;
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: words },
        { type: 'tool-call', toolCallId, toolName: 'run_task', input: { instruction: '' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'run_task',
          output: { type: 'text', value: output },
        },
      ],
    },
  ];
}

/** The text of every part of a provider-prompt message. */
function promptText(m: { content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<{ type: string; text?: string }>)
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('');
}

const records = (seen: ModelMessage[]) =>
  seen.map((m) => runnerRecordEntries(m)).filter((e): e is string[] => e !== null);

const ASK = 'Print the magazine, one copy';
const WORDS = 'On it, I prepare the magazine.';
const REPORT = 'The magazine is printed.\nThree pages, one copy, on the hall printer.';
const ARE_YOU_THERE = 'Are you there?';

// ─── The issue's shape: the end of a task is the last thing before the message ──

describe('the end of a completed task: the runner states it, then the agent says its report (#1088) @cap:reprendre-conversation/moteur', () => {
  for (const [channel, how] of CASES) {
    it(`${channel}, ${how}: the dated end in a runner record, the report as the assistant's words after it, then the message`, async () => {
      const conv = await conversation(channel);
      await say(conv, ASK, at('20:58:55'));
      const job = await launch(conv, channel, WORDS, at('20:59:01'), {
        status: 'completed',
        result: REPORT,
        resultKind: 'prose',
        createdAt: at('20:59:00'),
        completedAt: at('21:14:00'),
      });
      const { seen, prompt, sentAt } = await turn(conv, ARE_YOU_THERE, how);

      expect(seen).toEqual([
        { role: 'user', content: dated(ASK, at('20:58:55')) },
        ...launched(job, WORDS, LAUNCHED_OUTPUT),
        runnerRecordMessage([header(at('21:14:00'), at('20:59:00'), 'Completed.')]),
        { role: 'assistant', content: REPORT },
        { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
      ]);

      // The body of the request: the report is the assistant's, unquoted, and
      // nothing of it is left in the runner's record.
      const recordAt = prompt.findIndex(
        (m) => m.role === 'user' && promptText(m).includes('ended. Completed.'),
      );
      const reportAt = prompt.findIndex((m) => m.role === 'assistant' && promptText(m) === REPORT);
      const askedAt = prompt.findIndex(
        (m) => m.role === 'user' && promptText(m) === dated(ARE_YOU_THERE, sentAt),
      );
      expect(recordAt).toBeGreaterThan(-1);
      expect(reportAt).toBe(recordAt + 1);
      expect(askedAt).toBe(reportAt + 1);
      expect(promptText(prompt[recordAt]!)).toBe(
        `[système]\n${header(at('21:14:00'), at('20:59:00'), 'Completed.')}`,
      );
      for (const m of prompt.filter((x) => x.role === 'user')) {
        expect(promptText(m)).not.toContain('The magazine is printed.');
      }
    });
  }
});

// ─── Every outcome ───────────────────────────────────────────────────────────

describe('every outcome: what the runner states and what the agent said (#1088) @cap:reprendre-conversation/moteur', () => {
  async function oneTask(job: Omit<JobSpec, 'createdAt'>) {
    const conv = await conversation('dashboard');
    await say(conv, ASK, at('20:58:55'));
    const id = await launch(conv, 'dashboard', WORDS, at('20:59:01'), {
      ...job,
      createdAt: at('20:59:00'),
    });
    const { seen } = await turn(conv, ARE_YOU_THERE);
    // What follows the launch: the end, then the message being answered.
    expect(seen.slice(1, 3)).toEqual(launched(id, WORDS, LAUNCHED_OUTPUT));
    return seen.slice(3, -1);
  }

  it('failed with the agent’s message and an error: the failure stays the runner’s, quoted; no assistant message', async () => {
    const end = await oneTask({
      status: 'failed',
      result: 'I could not reach the printer.',
      error: 'blocked',
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([
        header(at('21:00:00'), at('20:59:00'), FAILED),
        '> I could not reach the printer.',
      ]),
    ]);
  });

  it('failed with no result: the reason, quoted, in the record alone', async () => {
    const end = await oneTask({
      status: 'failed',
      error: 'provider_refused',
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([header(at('21:00:00'), at('20:59:00'), FAILED), '> provider_refused']),
    ]);
  });

  it('cancelled: the status words alone, the stop note with them', async () => {
    const end = await oneTask({ status: 'cancelled', completedAt: at('21:00:00'), stopped: true });
    expect(end).toEqual([
      runnerRecordMessage([
        header(at('21:00:00'), at('20:59:00'), 'Cancelled by the user.'),
        stoppedReplyNote(),
      ]),
    ]);
  });

  it('completed with no result, or one that is blank once trimmed: the runner says so; never an empty assistant message', async () => {
    for (const result of [null, '  \n\t ']) {
      await db.delete(chatMessages);
      const end = await oneTask({ status: 'completed', result, completedAt: at('21:00:00') });
      expect(end).toEqual([
        runnerRecordMessage([
          header(at('21:00:00'), at('20:59:00'), 'Completed.'),
          '> (no textual output was recorded)',
        ]),
      ]);
    }
  });

  it('a relayed result (the text of other jobs): quoted in the record, never the agent’s words', async () => {
    const relay = '## Researcher\nThe sources are verified.';
    const end = await oneTask({
      status: 'completed',
      result: relay,
      resultKind: 'relay',
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([
        header(at('21:00:00'), at('20:59:00'), 'Completed.'),
        '> ## Researcher',
        '> The sources are verified.',
      ]),
    ]);
  });

  it('a result carrying runner notes: the notes stay the runner’s, the rest is the agent’s', async () => {
    const note = '[The delegation to Researcher failed: timeout]';
    const end = await oneTask({
      status: 'completed',
      result: `The magazine is ready.\n\n${note}`,
      resultKind: 'prose',
      notes: [note],
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([header(at('21:00:00'), at('20:59:00'), 'Completed.'), note]),
      { role: 'assistant', content: 'The magazine is ready.' },
    ]);
  });

  it('a result that is nothing but runner notes: the runner’s, and no assistant message', async () => {
    const note = '[The delivered file could not be verified]';
    const end = await oneTask({
      status: 'completed',
      result: note,
      resultKind: 'prose',
      notes: [note],
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([header(at('21:00:00'), at('20:59:00'), 'Completed.'), note]),
    ]);
  });

  it('a result with no provenance (written before result_kind): the agent’s words, as the job’s history reads it', async () => {
    const end = await oneTask({
      status: 'completed',
      result: 'Done.',
      resultKind: null,
      completedAt: at('21:00:00'),
    });
    expect(end).toEqual([
      runnerRecordMessage([header(at('21:00:00'), at('20:59:00'), 'Completed.')]),
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

// ─── Shapes of a conversation ────────────────────────────────────────────────

describe('the end of a task in every place of a conversation (#1088) @cap:reprendre-conversation/moteur', () => {
  it('two tasks ending back to back: each end, its runner part then its report', async () => {
    const conv = await conversation('device');
    await say(conv, ASK, at('20:58:55'));
    const a = await launch(conv, 'device', WORDS, at('20:59:01'), {
      status: 'completed',
      result: 'A is done.',
      createdAt: at('20:59:00'),
      completedAt: at('21:10:00'),
    });
    await say(conv, 'And the cover', at('20:59:10'));
    const b = await launch(conv, 'device', 'I make the cover.', at('20:59:13'), {
      status: 'failed',
      error: 'provider_refused',
      createdAt: at('20:59:12'),
      completedAt: at('21:10:01'),
    });
    const { seen, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken');
    expect(seen).toEqual([
      { role: 'user', content: dated(ASK, at('20:58:55')) },
      ...launched(a, WORDS, LAUNCHED_OUTPUT),
      { role: 'user', content: dated('And the cover', at('20:59:10')) },
      ...launched(b, 'I make the cover.', LAUNCHED_OUTPUT),
      runnerRecordMessage([header(at('21:10:00'), at('20:59:00'), 'Completed.')]),
      { role: 'assistant', content: 'A is done.' },
      runnerRecordMessage([header(at('21:10:01'), at('20:59:12'), FAILED), '> provider_refused']),
      { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
    ]);
  });

  it('an end between two messages of the person, answered later: the report sits before the later message', async () => {
    const conv = await conversation('dashboard');
    await say(conv, ASK, at('20:58:55'));
    const a = await launch(conv, 'dashboard', WORDS, at('20:59:01'), {
      status: 'completed',
      result: REPORT,
      createdAt: at('20:59:00'),
      completedAt: at('21:14:00'),
    });
    await say(conv, 'Thanks', at('21:20:00'));
    await say(conv, 'You are welcome.', at('21:20:02'), 'assistant');
    const { seen, sentAt } = await turn(conv, ARE_YOU_THERE);
    expect(seen).toEqual([
      { role: 'user', content: dated(ASK, at('20:58:55')) },
      ...launched(a, WORDS, LAUNCHED_OUTPUT),
      runnerRecordMessage([header(at('21:14:00'), at('20:59:00'), 'Completed.')]),
      { role: 'assistant', content: REPORT },
      { role: 'user', content: dated('Thanks', at('21:20:00')) },
      { role: 'assistant', content: 'You are welcome.' },
      { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
    ]);
  });

  it('the launch as the first kept row (the pure builder): launch, result, record, report, message', () => {
    const rows: HistoryRow[] = [
      historyRow({
        role: 'assistant',
        content: WORDS,
        createdAt: at('20:59:01'),
        jobId: 'job-1',
        jobStatus: 'completed',
        jobResult: REPORT,
        jobCreatedAt: at('20:59:00'),
        jobCompletedAt: at('21:14:00'),
      }),
      historyRow({ role: 'user', content: ARE_YOU_THERE, createdAt: at('21:44:00') }),
    ];
    const messages = chatTurnMessages({
      rows,
      records: new Map(),
      timezone: TZ,
      replyRendering: 'text',
    });
    expect(messages).toEqual([
      ...launched('job-1', WORDS, LAUNCHED_OUTPUT),
      runnerRecordMessage([header(at('21:14:00'), at('20:59:00'), 'Completed.')]),
      { role: 'assistant', content: REPORT },
      { role: 'user', content: dated(ARE_YOU_THERE, at('21:44:00')) },
    ]);
  });

  it('a row without the provenance of its job’s result fails loud: a row read without the columns cannot be told', () => {
    const row = historyRow({
      role: 'assistant',
      content: WORDS,
      createdAt: at('20:59:01'),
      jobId: 'job-1',
      jobStatus: 'completed',
      jobResult: REPORT,
      jobCreatedAt: at('20:59:00'),
      jobCompletedAt: at('21:14:00'),
    });
    const { jobResultKind: _kind, ...withoutKind } = row;
    expect(() =>
      chatTurnMessages({
        rows: [
          withoutKind as HistoryRow,
          historyRow({ role: 'user', content: ARE_YOU_THERE, createdAt: at('21:44:00') }),
        ],
        records: new Map(),
        timezone: TZ,
        replyRendering: 'text',
      }),
    ).toThrow(/result_kind/);
  });
});

function historyRow(over: Partial<HistoryRow> & Pick<HistoryRow, 'role' | 'content'>): HistoryRow {
  return {
    createdAt: null,
    jobId: null,
    jobHandoffNote: null,
    jobStatus: null,
    jobResult: null,
    jobError: null,
    jobCreatedAt: null,
    jobCompletedAt: null,
    jobResultKind: null,
    jobRunnerNotes: [],
    ...over,
  };
}

// ─── A running job ───────────────────────────────────────────────────────────

describe('a running job: its result does not contradict run_task (#1088) @cap:reprendre-conversation/moteur', () => {
  for (const [channel, how] of CASES) {
    it(`${channel}, ${how}: still running, and what the person says still goes through run_task`, async () => {
      const conv = await conversation(channel);
      await say(conv, ASK, at('20:58:55'));
      const job = await launch(conv, channel, WORDS, at('20:59:01'), {
        status: 'processing',
        createdAt: at('20:59:00'),
        completedAt: null,
      });
      const { seen, prompt } = await turn(conv, 'Why are you sending it there? Show it here.', how);
      expect(seen.slice(1, 3)).toEqual(
        launched(
          job,
          WORDS,
          'Still running — no result yet. What the person says about it, or asks beside it, still goes through run_task.',
        ),
      );
      expect(JSON.stringify(prompt)).not.toContain('wait for it to finish');
      expect(records(seen)).toEqual([]);
    });
  }
});

// ─── The two readers of one conversation ────────────────────────────────────

describe('the chat turn and the history of a job launched from the conversation: one definition of the agent’s words (#1088) @cap:reprendre-conversation/moteur', () => {
  const NOTE = '[The delegation to Researcher failed: timeout]';

  for (const channel of ['dashboard', 'device'] as const) {
    it(`${channel}: the report is the same assistant text in both; the runner’s note is in neither’s assistant part`, async () => {
      const conv = await conversation(channel);
      await say(conv, ASK, at('20:58:55'));
      await launch(conv, channel, WORDS, at('20:59:01'), {
        status: 'completed',
        result: `${REPORT}\n\n${NOTE}`,
        resultKind: 'prose',
        notes: [NOTE],
        createdAt: at('20:59:00'),
        completedAt: at('21:14:00'),
      });
      // A later worker job, launched from the same conversation.
      await say(conv, 'Print it again', at('21:30:00'));
      const [worker] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel,
          conversationId: conv,
          task: 'Print it again',
          status: 'pending',
          createdAt: at('21:30:01'),
        })
        .returning({ id: agentJobs.id });
      const jobRead = await loadThreadHistory({
        db: db as unknown as RunnerDeps['db'],
        conversationId: conv,
        channel,
        excludeJobId: worker!.id,
        timezone: TZ,
      });
      const { seen } = await turn(conv, ARE_YOU_THERE);

      const said = (ms: ModelMessage[]) =>
        ms
          .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
          .map((m) => m.content);
      expect(said(seen)).toEqual([REPORT]);
      expect(said(jobRead)).toEqual([WORDS, REPORT]);
      expect(JSON.stringify(said(seen))).not.toContain(NOTE);
      // The note is the runner's in both.
      expect(records(seen).flat()).toContain(NOTE);
      expect(records(jobRead).flat()).toContain(NOTE);
    });
  }
});

// ─── The job's start, replayable ────────────────────────────────────────────

describe('the history of a job launched from a conversation is rebuilt by pure builders (#1088) @cap:reprendre-conversation/moteur', () => {
  it('rows and records in, messages out: the agent’s words, then the record, as loadThreadHistory gives them', async () => {
    const conv = await conversation('dashboard');
    await say(conv, ASK, at('20:58:55'));
    const launchedJob = await launch(conv, 'dashboard', WORDS, at('20:59:01'), {
      status: 'completed',
      result: REPORT,
      resultKind: 'prose',
      createdAt: at('20:59:00'),
      completedAt: at('21:14:00'),
    });
    await say(conv, 'Print it again', at('21:30:00'));
    const [worker] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        conversationId: conv,
        task: 'Print it again',
        status: 'pending',
        createdAt: at('21:30:01'),
      })
      .returning({ id: agentJobs.id });

    const row = (
      over: Partial<DashboardHistoryRow> & Pick<DashboardHistoryRow, 'role' | 'content'>,
    ) =>
      ({
        createdAt: null,
        jobId: null,
        jobStatus: null,
        jobCompletedAt: null,
        result: null,
        resultKind: null,
        runnerNotes: null,
        ...over,
      }) as DashboardHistoryRow;
    const rows: DashboardHistoryRow[] = [
      row({ role: 'user', content: ASK, createdAt: at('20:58:55') }),
      row({
        role: 'assistant',
        content: WORDS,
        createdAt: at('20:59:01'),
        jobId: launchedJob,
        jobStatus: 'completed',
        jobCompletedAt: at('21:14:00'),
        result: REPORT,
        resultKind: 'prose',
        runnerNotes: [],
      }),
      row({ role: 'user', content: 'Print it again', createdAt: at('21:30:00') }),
    ];
    const current = { task: 'Print it again', createdAt: at('21:30:01') };
    const request = dashboardHistoryRecordsRequest(rows, current);
    expect(request.jobIds).toEqual([null, launchedJob]);
    const RECORD = ['[Actions performed in this exchange: print_document]'];
    const built = dashboardHistoryMessages({
      rows,
      current,
      records: new Map([[launchedJob, RECORD]]),
      timezone: TZ,
    });
    expect(built).toEqual([
      { role: 'user', content: dated(ASK, at('20:58:55')) },
      { role: 'assistant', content: WORDS },
      { role: 'assistant', content: REPORT },
      runnerRecordMessage(RECORD),
    ]);

    // The loader gives the same messages from the database (no record stored here).
    const loaded = await loadThreadHistory({
      db: db as unknown as RunnerDeps['db'],
      conversationId: conv,
      channel: 'dashboard',
      excludeJobId: worker!.id,
      timezone: TZ,
    });
    expect(loaded).toEqual(
      dashboardHistoryMessages({ rows, current, records: new Map(), timezone: TZ }),
    );
  });
});

// ─── The bounds ─────────────────────────────────────────────────────────────

describe('the bounds apply to the report as they did inside the record (#1088) @cap:reprendre-conversation/moteur', () => {
  it('a conversation that fits keeps a large report whole, outside the budget as before', async () => {
    const conv = await conversation('dashboard');
    const first = 'x'.repeat(5_000);
    await say(conv, first, at('20:00:00'));
    const big = 'R'.repeat(20_000);
    await launch(conv, 'dashboard', 'On it.', at('20:00:05'), {
      status: 'completed',
      result: big,
      createdAt: at('20:00:04'),
      completedAt: at('20:30:00'),
    });
    await say(conv, 'y'.repeat(5_000), at('20:10:00'));
    await say(conv, 'z'.repeat(5_000), at('20:10:05'), 'assistant');
    const { seen } = await turn(conv, ARE_YOU_THERE);
    expect(seen[0]).toEqual({ role: 'user', content: dated(first, at('20:00:00')) });
    expect(seen.filter((m) => m.role === 'assistant' && m.content === big)).toHaveLength(1);
    expect(records(seen)).toEqual([[header(at('20:30:00'), at('20:00:04'), 'Completed.')]]);
  });

  it('rows over the budget: the last-resort truncation cuts the report too', () => {
    const report = 'P'.repeat(10_000);
    const rows: HistoryRow[] = [
      historyRow({ role: 'user', content: ASK, createdAt: at('20:58:55') }),
      historyRow({
        role: 'assistant',
        content: WORDS,
        createdAt: at('20:59:01'),
        jobId: 'job-1',
        jobStatus: 'completed',
        jobResult: report,
        jobCreatedAt: at('20:59:00'),
        jobCompletedAt: at('21:14:00'),
      }),
      historyRow({ role: 'user', content: 'q'.repeat(20_000), createdAt: at('21:44:00') }),
    ];
    const messages = chatTurnMessages({
      rows,
      records: new Map(),
      timezone: TZ,
      replyRendering: 'text',
    });
    const said = messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string');
    expect(said).toEqual([{ role: 'assistant', content: truncate(report) }]);
    expect(truncate(report)).not.toBe(report);
  });
});
