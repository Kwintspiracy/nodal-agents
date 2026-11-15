// reply-form-note.test.ts — the form of a reply is said with the message it answers (#1088).
//
// The defect: on a spoken conversation, the agent answered a neutral message
// ("Are you there?", "Thank you") and then restated where earlier tasks stood,
// on every sentence. The rule that forbids it sits in the system prompt
// (`- rendering: spoken`), 30 000 characters of replayed history before the
// reply, and was not followed: 15 restatings out of 15 measured. Said again
// right after the message being answered, it was: 0 out of 15.
//
// The rule: what governs the form of THIS reply is read last. The chat front
// gives the model, right after the person's message, the note of the rendering
// (`REPLY_FORM_NOTES`). The note belongs to the request: it is never stored,
// never replayed with a later turn, never shown. A rendering with no note
// (a written chat) leaves the request exactly as it was.
//
// These tests read the messages the model is actually given (every
// `generateText` call of `runChatTurn`), and the rows the turn stores. The
// wording is read from the constant, never copied: it is settled by measure.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, chatMessages, conversations, entities, toolCalls } from '@nodal-agents/db';
import { REPLY_FORM_NOTES } from '@nodal-agents/orchestration';
import {
  formatLocalTime,
  isRequestNote,
  requestNoteMessage,
  runnerRecordMessage,
} from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import {
  LAUNCHED_OUTPUT,
  chatTurnMessages,
  keptHistoryRows,
  runChatTurn,
  type HistoryRow,
} from '../../chat/run-chat-turn.ts';
import { cutReplyNote, stoppedReplyNote } from '../../chat/turn-stop.ts';

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
      if (!active) throw new Error('reply-form-note.test: no active LLM client');
      return active;
    },
  };
});

const SPOKEN_NOTE = REPLY_FORM_NOTES.spoken;
if (SPOKEN_NOTE === null) throw new Error('reply-form-note.test: the spoken rendering has no note');
const NOTE_MESSAGE = requestNoteMessage(SPOKEN_NOTE) as ModelMessage;

type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'run_task'; text: string; instruction: string }
  | { kind: 'nothing' };

interface Call {
  system: string;
  messages: ModelMessage[];
}

/** A model that answers what `replies` says, call after call, and keeps every request it gets. */
function capturingClient(calls: Call[], replies: Reply[]): RunnerDeps['llmClient'] {
  let n = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const reply = replies[Math.min(n, replies.length - 1)]!;
      n += 1;
      const content =
        reply.kind === 'text'
          ? [{ type: 'text' as const, text: reply.text }]
          : reply.kind === 'run_task'
            ? [
                { type: 'text' as const, text: reply.text },
                {
                  type: 'tool-call' as const,
                  toolCallId: 'call-run-task-1',
                  toolName: 'run_task',
                  input: JSON.stringify({ instruction: reply.instruction }),
                },
              ]
            : [];
      return {
        content,
        finishReason:
          reply.kind === 'run_task'
            ? { unified: 'tool-calls' as const, raw: 'tool_use' }
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
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      calls.push({
        system: typeof args.system === 'string' ? args.system : '',
        messages: (args.messages ?? []) as ModelMessage[],
      });
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
const at = (hms: string) => new Date(`2026-11-14T${hms}+01:00`);
const dated = (text: string, when: Date) => `[${formatLocalTime(TZ, when)}] ${text}`;

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

/** The two origins whose turns are spoken: the dashboard's microphone, and a device. */
type Channel = 'dashboard' | 'device';
const CHANNELS: Channel[] = ['dashboard', 'device'];

async function conversation(channel: Channel): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      chatId: channel === 'device' ? 'device-hall' : null,
      title: 'A talk',
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function say(
  conv: string,
  content: string,
  when: Date,
  role: 'user' | 'assistant' = 'user',
  extra: { stopped?: boolean; cutReason?: string } = {},
) {
  await db.insert(chatMessages).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv,
    role,
    content,
    createdAt: when,
    ...extra,
  });
}

async function launch(
  conv: string,
  words: string,
  when: Date,
  job: { status: string; result?: string; createdAt: Date; completedAt: Date | null },
): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      conversationId: conv,
      task: words,
      status: job.status,
      result: job.result ?? null,
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
  });
  return row!.id;
}

/** A chat turn, spoken or written: every request the model got, and when the message was written. */
async function turn(
  conv: string,
  message: string,
  how: 'spoken' | 'written',
  replies: Reply[] = [{ kind: 'text', text: 'Yes, I am here.' }],
) {
  const calls: Call[] = [];
  setActiveLlmClient(capturingClient(calls, replies));
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
  const sent = rows.filter((r) => r.content === message).at(-1);
  return { calls, result, sentAt: sent!.createdAt! };
}

/** Every text a request carries, in any message or part: where the note could hide. */
function texts(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((m) =>
    typeof m.content === 'string'
      ? [m.content]
      : m.content.flatMap((p) =>
          p.type === 'text'
            ? [p.text]
            : p.type === 'tool-result' && p.output.type === 'text'
              ? [p.output.value]
              : [],
        ),
  );
}

const occurrences = (messages: readonly ModelMessage[]) =>
  texts(messages).filter((t) => t.includes(SPOKEN_NOTE)).length;

const ARE_YOU_THERE = 'Are you there?';
const THANKS = 'Thank you.';

describe('the form of a spoken reply is said with the message it answers (#1088) @cap:parler-a-un-agent/moteur', () => {
  for (const channel of CHANNELS) {
    it(`${channel}: the request ends with the person's message, then the note; the system prompt keeps the rendering`, async () => {
      const conv = await conversation(channel);
      await say(conv, 'Print the magazine', at('13:10:00'));
      await say(conv, 'It is ready, I am printing it.', at('13:10:05'), 'assistant');
      const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken');
      expect(calls[0]!.messages).toEqual([
        { role: 'user', content: dated('Print the magazine', at('13:10:00')) },
        { role: 'assistant', content: 'It is ready, I am printing it.' },
        { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
        NOTE_MESSAGE,
      ]);
      // The note is the runner's, structurally, and says it is not the person's.
      expect(isRequestNote(calls[0]!.messages.at(-1))).toBe(true);
      expect(SPOKEN_NOTE).toContain('not said by the person');
      // The rendering facts stay in the system prompt.
      expect(calls[0]!.system).toContain('- rendering: spoken');
    });
  }

  it('the first turn of a conversation: its message, then the note', async () => {
    const conv = await conversation('device');
    const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken');
    expect(calls[0]!.messages).toEqual([
      { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
      NOTE_MESSAGE,
    ]);
  });

  it('a written turn has no note: the request is the one of before, byte for byte', async () => {
    expect(REPLY_FORM_NOTES.text).toBeNull();
    const conv = await conversation('dashboard');
    await say(conv, 'Print the magazine', at('13:10:00'));
    await say(conv, 'It is ready, I am printing it.', at('13:10:05'), 'assistant');
    const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'written');
    expect(JSON.stringify(calls[0]!.messages)).toBe(
      JSON.stringify([
        { role: 'user', content: dated('Print the magazine', at('13:10:00')) },
        { role: 'assistant', content: 'It is ready, I am printing it.' },
        { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
      ]),
    );
    expect(calls[0]!.system).not.toContain('- rendering: spoken');
  });

  it('the note is never stored, and the next turn replays the words alone, with ONE note, for its own message', async () => {
    const conv = await conversation('device');
    const first = await turn(conv, ARE_YOU_THERE, 'spoken');
    const stored = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv))
      .orderBy(chatMessages.createdAt);
    expect(stored).toEqual([
      { role: 'user', content: ARE_YOU_THERE },
      { role: 'assistant', content: 'Yes, I am here.' },
    ]);

    const second = await turn(conv, THANKS, 'spoken', [{ kind: 'text', text: 'You are welcome.' }]);
    expect(second.calls[0]!.messages).toEqual([
      { role: 'user', content: dated(ARE_YOU_THERE, first.sentAt) },
      { role: 'assistant', content: 'Yes, I am here.' },
      { role: 'user', content: dated(THANKS, second.sentAt) },
      NOTE_MESSAGE,
    ]);
    expect(occurrences(second.calls[0]!.messages)).toBe(1);

    // A written turn after spoken ones: no note anywhere, the earlier ones included.
    const third = await turn(conv, 'And the weather?', 'written', [
      { kind: 'text', text: 'Sunny.' },
    ]);
    expect(occurrences(third.calls[0]!.messages)).toBe(0);
    expect(third.calls[0]!.messages.at(-1)).toEqual({
      role: 'user',
      content: dated('And the weather?', third.sentAt),
    });
  });

  it('a conversation with task ends in its history: the ends in their place, the message, then the note', async () => {
    const conv = await conversation('device');
    await say(conv, 'Make the magazine', at('13:40:00'));
    const job = await launch(conv, 'On it.', at('13:40:05'), {
      status: 'completed',
      result: 'The magazine is unfinished: no verified sources.',
      createdAt: at('13:40:04'),
      completedAt: at('13:58:00'),
    });
    await say(conv, 'Thanks', at('14:00:00'));
    await say(conv, 'You are welcome.', at('14:00:02'), 'assistant');
    const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken');
    const seen = calls[0]!.messages;
    expect(seen.slice(3)).toEqual([
      runnerRecordMessage([
        dated(
          `The task launched at ${formatLocalTime(TZ, at('13:40:04'))} ended. Completed.`,
          at('13:58:00'),
        ),
        '> The magazine is unfinished: no verified sources.',
      ]),
      { role: 'user', content: dated('Thanks', at('14:00:00')) },
      { role: 'assistant', content: 'You are welcome.' },
      { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
      NOTE_MESSAGE,
    ]);
    // The launch keeps its form: launched, its outcome is at its end.
    expect(texts(seen.slice(1, 3))).toContain(LAUNCHED_OUTPUT);
    expect(job).toBeTruthy();
  });

  it('a message that arrives while a job runs: the running job under its launch, the message, then the note', async () => {
    const conv = await conversation('dashboard');
    await say(conv, 'Make the magazine', at('13:40:00'));
    await launch(conv, 'On it.', at('13:40:05'), {
      status: 'processing',
      createdAt: at('13:40:04'),
      completedAt: null,
    });
    const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken');
    const seen = calls[0]!.messages;
    expect(texts(seen)).toContain(
      'Still running — no result yet. Do NOT dispatch it again; wait for it to finish.',
    );
    expect(seen.slice(-2)).toEqual([
      { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
      NOTE_MESSAGE,
    ]);
  });

  it('a stopped reply and a cut reply in the history keep their notes; the note of this reply comes last', async () => {
    const conv = await conversation('device');
    await say(conv, 'Tell me a story', at('13:00:00'));
    await say(conv, 'Once upon a', at('13:00:03'), 'assistant', { stopped: true });
    await say(conv, 'Tell me another', at('13:01:00'));
    await say(conv, 'There was', at('13:01:03'), 'assistant', { cutReason: 'stream_error' });
    const { calls, sentAt } = await turn(conv, THANKS, 'spoken');
    expect(calls[0]!.messages).toEqual([
      { role: 'user', content: dated('Tell me a story', at('13:00:00')) },
      { role: 'assistant', content: 'Once upon a' },
      { role: 'user', content: stoppedReplyNote() },
      { role: 'user', content: dated('Tell me another', at('13:01:00')) },
      { role: 'assistant', content: 'There was' },
      { role: 'user', content: cutReplyNote() },
      { role: 'user', content: dated(THANKS, sentAt) },
      NOTE_MESSAGE,
    ]);
  });

  it('a turn that starts a task: the job gets the words alone, nothing stores the note', async () => {
    const conv = await conversation('device');
    const { calls, result } = await turn(conv, 'Print the magazine', 'spoken', [
      { kind: 'run_task', text: 'I am printing it.', instruction: 'print it' },
    ]);
    expect(calls[0]!.messages.at(-1)).toEqual(NOTE_MESSAGE);
    expect(result.ok && result.spawnedJobId).toBeTruthy();
    const [job] = await db
      .select({
        task: agentJobs.task,
        handoffNote: agentJobs.handoffNote,
        messages: agentJobs.messages,
        replyRendering: agentJobs.replyRendering,
      })
      .from(agentJobs)
      .where(eq(agentJobs.conversationId, conv));
    expect(job!.task).toBe('Print the magazine');
    expect(job!.replyRendering).toBe('spoken');
    expect(JSON.stringify(job)).not.toContain(SPOKEN_NOTE);
    const stored = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv));
    expect(stored.map((r) => r.content).sort()).toEqual([
      'I am printing it.',
      'Print the magazine',
    ]);
  });

  it('the tool-free retry answers the same request: its message, then the note', async () => {
    const conv = await conversation('device');
    const { calls, sentAt } = await turn(conv, ARE_YOU_THERE, 'spoken', [
      { kind: 'nothing' },
      { kind: 'text', text: 'Yes.' },
    ]);
    // The reply, then the tool-free retry that rewrites it: both answer the message.
    for (const call of calls.slice(0, 2)) {
      expect(call.messages.slice(-2)).toEqual([
        { role: 'user', content: dated(ARE_YOU_THERE, sentAt) },
        NOTE_MESSAGE,
      ]);
    }
    // The escalation recheck that follows is not a reply: it reads the request and the reply alone.
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls.slice(2)) expect(occurrences(call.messages)).toBe(0);
  });
});

describe('chatTurnMessages, the pure builder a replay calls on real rows (#1088) @cap:parler-a-un-agent/moteur', () => {
  const row = (role: 'user' | 'assistant', content: string, hms: string): HistoryRow => ({
    role,
    content,
    createdAt: at(hms),
    jobId: null,
    jobHandoffNote: null,
    jobStatus: null,
    jobResult: null,
    jobError: null,
    jobCreatedAt: null,
    jobCompletedAt: null,
  });
  const rows = [
    row('user', 'Print the magazine', '13:10:00'),
    row('assistant', 'Printing it.', '13:10:05'),
    row('user', ARE_YOU_THERE, '13:40:00'),
  ];

  it('the two renderings differ by the trailing note alone', () => {
    const kept = keptHistoryRows(rows, TZ);
    const written = chatTurnMessages({
      rows: kept,
      records: new Map(),
      timezone: TZ,
      replyRendering: 'text',
    });
    const spoken = chatTurnMessages({
      rows: kept,
      records: new Map(),
      timezone: TZ,
      replyRendering: 'spoken',
    });
    expect(spoken).toEqual([...written, NOTE_MESSAGE]);
    expect(written.at(-1)).toEqual({ role: 'user', content: dated(ARE_YOU_THERE, at('13:40:00')) });
  });

  it('a history over budget: the oldest rows go, the note still follows the message being answered', () => {
    const big = 'x'.repeat(40_000);
    const long = [
      row('user', big, '12:00:00'),
      row('assistant', big, '12:00:05'),
      row('user', big, '12:30:00'),
      row('assistant', 'Done.', '12:30:05'),
      row('user', THANKS, '13:00:00'),
    ];
    const kept = keptHistoryRows(long, TZ);
    expect(kept.length).toBeLessThan(long.length);
    const spoken = chatTurnMessages({
      rows: kept,
      records: new Map(),
      timezone: TZ,
      replyRendering: 'spoken',
    });
    expect(spoken.slice(-2)).toEqual([
      { role: 'user', content: dated(THANKS, at('13:00:00')) },
      NOTE_MESSAGE,
    ]);
    expect(occurrences(spoken)).toBe(1);
  });
});
