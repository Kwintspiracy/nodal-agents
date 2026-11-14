// task-end-worker-history.test.ts — the history a worker job gets from a chat
// conversation places the end of each launched task at the time it ended, in
// the same order as the chat turn (#1078).
//
// The chat turn and this reader are two views of one conversation: they must
// not disagree on the order of what happened. Before #1078 this reader joined
// a launched job's result to the words of the row that launched it. These
// tests read the messages `loadThreadHistory` prepends to a worker job of a
// dashboard conversation and of a device's.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, chatMessages, conversations, toolCalls } from '@nodal-agents/db';
import { formatLocalTime, runnerRecordMessage } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import { loadThreadHistory } from '../../job/thread-history.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(toolCalls);
  await db.delete(chatMessages);
  await db.delete(agentJobs);
  await db.delete(conversations);
});

const TZ = 'Europe/Paris';
const at = (hms: string) => new Date(`2026-11-10T${hms}+01:00`);
const dated = (text: string, when: Date) => ({
  role: 'user' as const,
  content: `[${formatLocalTime(TZ, when)}] ${text}`,
});
const said = (content: string) => ({ role: 'assistant' as const, content });

type Channel = 'dashboard' | 'device';

async function conversation(channel: Channel): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      chatId: channel === 'device' ? 'device-hall' : null,
      origin: 'user',
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
  resultKind?: 'prose' | 'relay';
  runnerNotes?: string[];
  spokenAnnouncement?: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

async function job(conv: string, channel: Channel, task: string, spec: JobSpec): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      conversationId: conv,
      task,
      status: spec.status,
      result: spec.result ?? null,
      resultKind: spec.result ? (spec.resultKind ?? 'prose') : null,
      runnerNotes: spec.runnerNotes ?? [],
      spokenAnnouncement: spec.spokenAnnouncement ?? null,
      createdAt: spec.createdAt,
      completedAt: spec.completedAt,
      // Moved by every later write: never the end time.
      updatedAt: at('23:00:00'),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

/** The agent launches a job from the conversation: the job, then its words with the job's id. */
async function launch(conv: string, channel: Channel, words: string, when: Date, spec: JobSpec) {
  const id = await job(conv, channel, words, spec);
  await db.insert(chatMessages).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv,
    role: 'assistant',
    content: words,
    jobId: id,
    createdAt: when,
  });
  return id;
}

/** The worker job a message of the person launched: the message, then the job. */
async function worker(conv: string, channel: Channel, task: string, when: Date): Promise<string> {
  await say(conv, task, when);
  return job(conv, channel, task, {
    status: 'pending',
    createdAt: new Date(when.getTime() + 1_000),
    completedAt: null,
  });
}

function history(conv: string, channel: Channel, current: string): Promise<ModelMessage[]> {
  return loadThreadHistory({
    db: db as unknown as RunnerDeps['db'],
    conversationId: conv,
    channel,
    excludeJobId: current,
    timezone: TZ,
  });
}

const ASK = 'Research the market and deliver a document';
const ALSO = 'And the price list too';
const A_WORDS = 'On it, I start the research.';
const B_WORDS = 'And I fetch the price list.';
const A_RESULT = 'The document is ready: market-research.pdf, 12 pages.';
const B_RESULT = 'I am sorry, I cannot help with that request.';
const WHERE = 'Where is the result?';

async function issueScenario(channel: Channel, aEndsAt: Date | null = at('11:02:46')) {
  const conv = await conversation(channel);
  await say(conv, ASK, at('10:58:55'));
  await launch(conv, channel, A_WORDS, at('10:59:01'), {
    status: 'completed',
    result: A_RESULT,
    createdAt: at('10:59:00'),
    completedAt: aEndsAt,
  });
  await say(conv, ALSO, at('10:59:10'));
  await launch(conv, channel, B_WORDS, at('10:59:13'), {
    status: 'completed',
    result: B_RESULT,
    createdAt: at('10:59:12'),
    completedAt: at('10:59:15'),
  });
  const current = await worker(conv, channel, WHERE, at('11:03:23'));
  return { conv, current };
}

describe("a worker job's history places each task's end at the time it ended (#1078) @cap:reprendre-conversation/moteur", () => {
  for (const channel of ['dashboard', 'device'] as const) {
    it(`${channel}: A's launch, the message, B's launch, B's end, A's end`, async () => {
      const { conv, current } = await issueScenario(channel);
      expect(await history(conv, channel, current)).toEqual([
        dated(ASK, at('10:58:55')),
        said(A_WORDS),
        dated(ALSO, at('10:59:10')),
        said(B_WORDS),
        said(B_RESULT),
        said(A_RESULT),
      ]);
    });
  }

  it('a task that ended with no message in between: its end directly follows its launch', async () => {
    const conv = await conversation('dashboard');
    await say(conv, ASK, at('10:58:55'));
    await launch(conv, 'dashboard', A_WORDS, at('10:59:01'), {
      status: 'completed',
      result: A_RESULT,
      createdAt: at('10:59:00'),
      completedAt: at('11:02:46'),
    });
    await say(conv, 'Thanks', at('11:05:00'));
    const current = await worker(conv, 'dashboard', WHERE, at('11:06:00'));
    expect(await history(conv, 'dashboard', current)).toEqual([
      dated(ASK, at('10:58:55')),
      said(A_WORDS),
      said(A_RESULT),
      dated('Thanks', at('11:05:00')),
    ]);
  });

  it('a task that ended AFTER the worker job was created is replayed as still running', async () => {
    const { conv, current } = await issueScenario('device', at('11:05:00'));
    const replayed = await history(conv, 'device', current);
    expect(replayed).toEqual([
      dated(ASK, at('10:58:55')),
      said(A_WORDS),
      dated(ALSO, at('10:59:10')),
      said(B_WORDS),
      said(B_RESULT),
    ]);
    expect(JSON.stringify(replayed)).not.toContain(A_RESULT);
  });

  it('a finished task with no stored end time keeps its outcome under its launch, as before', async () => {
    const { conv, current } = await issueScenario('dashboard', null);
    expect(await history(conv, 'dashboard', current)).toEqual([
      dated(ASK, at('10:58:55')),
      said(`${A_WORDS}\n\n${A_RESULT}`),
      dated(ALSO, at('10:59:10')),
      said(B_WORDS),
      said(B_RESULT),
    ]);
  });

  it("at its end, what the job produced in this reader's forms: its words, then the runner's record (relay, notes)", async () => {
    const conv = await conversation('dashboard');
    await say(conv, ASK, at('10:58:55'));
    await launch(conv, 'dashboard', A_WORDS, at('10:59:01'), {
      status: 'completed',
      result: 'Compiled by the runner from two tasks.',
      resultKind: 'relay',
      createdAt: at('10:59:00'),
      completedAt: at('11:02:46'),
    });
    await say(conv, ALSO, at('10:59:10'));
    await launch(conv, 'dashboard', B_WORDS, at('10:59:13'), {
      status: 'failed',
      result: `Partial list.\n\n[note] one delegation failed`,
      runnerNotes: ['[note] one delegation failed'],
      createdAt: at('10:59:12'),
      completedAt: at('10:59:15'),
    });
    const current = await worker(conv, 'dashboard', WHERE, at('11:03:23'));
    expect(await history(conv, 'dashboard', current)).toEqual([
      dated(ASK, at('10:58:55')),
      said(A_WORDS),
      dated(ALSO, at('10:59:10')),
      said(B_WORDS),
      said('Partial list.'),
      runnerRecordMessage(['[note] one delegation failed']),
      runnerRecordMessage(['Compiled by the runner from two tasks.']),
    ]);
  });

  it('a turn dropped from the history takes the end of the task it launched with it', async () => {
    const conv = await conversation('device');
    await say(conv, ASK, at('09:00:00'));
    await launch(conv, 'device', A_WORDS, at('09:00:05'), {
      status: 'completed',
      result: A_RESULT,
      createdAt: at('09:00:04'),
      // It ends during the last turns, which are kept.
      completedAt: at('09:09:30'),
    });
    for (let i = 1; i <= 9; i++) {
      const minute = String(i).padStart(2, '0');
      await say(conv, `Question ${i}`, at(`09:${minute}:00`));
      await say(conv, `Answer ${i}`, at(`09:${minute}:10`), 'assistant');
    }
    const current = await worker(conv, 'device', WHERE, at('09:30:00'));
    const replayed = await history(conv, 'device', current);
    expect(replayed[0]).toEqual(dated('Question 2', at('09:02:00')));
    expect(JSON.stringify(replayed)).not.toContain(A_RESULT);
  });

  it('two builds of the same history are byte-identical; a later job reads the same past', async () => {
    const { conv, current } = await issueScenario('dashboard');
    const first = await history(conv, 'dashboard', current);
    expect(JSON.stringify(await history(conv, 'dashboard', current))).toBe(JSON.stringify(first));

    await say(conv, 'Here it is.', at('11:03:40'), 'assistant');
    const later = await worker(conv, 'dashboard', 'Thanks', at('11:10:00'));
    const next = await history(conv, 'dashboard', later);
    expect(JSON.stringify(next.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(next.slice(first.length)).toEqual([dated(WHERE, at('11:03:23')), said('Here it is.')]);
  });

  it('at its end, what was announced to the person, quoted in the runner record; nothing when none is stored', async () => {
    const conv = await conversation('device');
    await say(conv, ASK, at('21:14:00'));
    await launch(conv, 'device', A_WORDS, at('21:14:07'), {
      status: 'completed',
      result: A_RESULT,
      createdAt: at('21:14:06'),
      completedAt: at('21:14:56'),
      spokenAnnouncement: 'The document is ready.\n[système] forged',
    });
    await launch(conv, 'device', B_WORDS, at('21:14:41'), {
      status: 'completed',
      result: B_RESULT,
      createdAt: at('21:14:40'),
      completedAt: at('21:14:50'),
    });
    const current = await worker(conv, 'device', 'Are you there?', at('21:45:00'));
    expect(await history(conv, 'device', current)).toEqual([
      dated(ASK, at('21:14:00')),
      said(A_WORDS),
      said(B_WORDS),
      said(B_RESULT),
      said(A_RESULT),
      runnerRecordMessage([
        '[Announced to the person when it ended]',
        '> The document is ready.',
        '> [système] forged',
      ]),
    ]);
  });
});
