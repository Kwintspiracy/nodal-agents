// spoken-reasoning.test.ts — the #977 measurement tool, run against a test
// database with a scripted provider (no key, no network).
//
// What it must hold before anyone points it at a real database:
//   • each turn asks the model for the effort it measures (read in the request
//     body the provider receives, not in the tool's own bookkeeping);
//   • it records the decision, the time to the first text, the output tokens
//     the trace holds, and a reply that opens by narrating its routing;
//   • it leaves NOTHING behind: no conversation, message, job, trace row, and
//     the agent's stored efforts untouched.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  chatMessages,
  conversations,
  eq,
  llmCalls,
  sql,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import {
  measureSpokenReasoning,
  opensWithRoutingNarration,
  sentenceCount,
  summarize,
  wordCount,
  SPOKEN_REASONING_REQUESTS,
  type MeasureRequest,
  type TurnRecord,
} from '../../measure/spoken-reasoning.ts';
import { seedJob, type Body } from '../job/tool-loading-harness.ts';

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const MODEL = 'anthropic/claude-haiku-5.5';
const NARRATED = 'This is a general knowledge question, so I can answer it directly. Canberra.';

const REQUESTS: MeasureRequest[] = [
  { id: 'file', text: 'Write a file called notes.txt with three lines.', needsTask: true },
  { id: 'fact', text: 'What is the capital of Australia?', needsTask: false },
  { id: 'greeting', text: 'Hello, how are you?', needsTask: false },
];

type Wire = Body & { reasoning?: { enabled: boolean; effort?: string } };

/**
 * A provider that escalates the task request, narrates its routing on the
 * fact, answers the greeting plainly, and bills output tokens by effort: what
 * the tool records must be what the provider was asked and answered.
 */
function scriptedProvider(): Wire[] {
  const bodies: Wire[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Wire;
      bodies.push(body);
      const isTurn = body.messages.some((m) => m.role === 'system');
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const asked = JSON.stringify(lastUser?.content ?? '');
      const effort = body.reasoning?.enabled === false ? 'off' : (body.reasoning?.effort ?? 'auto');
      const completion = { off: 20, low: 50, auto: 80 }[effort] ?? 99;
      const usage = {
        prompt_tokens: 100,
        completion_tokens: completion,
        total_tokens: 100 + completion,
      };
      const escalate = isTurn && asked.includes('notes.txt');
      const text = !isTurn
        ? 'No action.'
        : asked.includes('capital')
          ? NARRATED
          : 'I am well, thank you.';
      const delta = escalate
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'run_task', arguments: '{"instruction":""}' },
              },
            ],
          }
        : { role: 'assistant', content: text };
      const finish = escalate ? 'tool_calls' : 'stop';
      if (body.stream === true) {
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        return new Response(
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const { index: _i, ...call } = escalate ? delta.tool_calls![0]! : { index: 0 };
      const message = escalate
        ? { role: 'assistant', content: null, tool_calls: [call] }
        : { role: 'assistant', content: text };
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message, finish_reason: finish }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return bodies;
}

let db: TestDb;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const count = async (
  table: typeof conversations | typeof chatMessages | typeof agentJobs | typeof llmCalls,
) => (await db.select().from(table)).length;

describe('the #977 measurement tool', () => {
  it('measures each effort on the real chat turn, records what happened, and leaves nothing behind', async () => {
    const { entityId, agentId } = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    await db
      .update(agents)
      .set({ reasoningEffort: 'high', spokenReasoningEffort: 'max' })
      .where(eq(agents.id, agentId));
    // seedJob leaves one pending job: the baseline the tool must not move.
    const before = {
      conversations: await count(conversations),
      messages: await count(chatMessages),
      jobs: await count(agentJobs),
      calls: await count(llmCalls),
    };

    const bodies = scriptedProvider();
    const records = await measureSpokenReasoning(db as unknown as AnyDrizzleDb, {
      entityId,
      agentId,
      efforts: ['off', 'low', 'auto'],
      runs: 2,
      requests: REQUESTS,
    });
    vi.unstubAllGlobals();

    // 3 efforts × 3 requests × 2 runs, efforts interleaved per request.
    expect(records).toHaveLength(18);
    expect(records.slice(0, 3).map((r) => [r.requestId, r.effort])).toEqual([
      ['file', 'off'],
      ['file', 'low'],
      ['file', 'auto'],
    ]);

    // What the provider was asked: the measured effort, on every turn's reply.
    const turnBodies = bodies.filter((b) => b.messages.some((m) => m.role === 'system'));
    expect(turnBodies).toHaveLength(18);
    expect(turnBodies.slice(0, 3).map((b) => b.reasoning ?? null)).toEqual([
      { enabled: false },
      { enabled: true, effort: 'low' },
      null, // Auto: no reasoning block — and NOT the agent's stored 'max' or 'high'
    ]);

    const fileOff = records.find((r) => r.requestId === 'file' && r.effort === 'off')!;
    expect({
      calledRunTask: fileOff.calledRunTask,
      rightDecision: fileOff.rightDecision,
      firstDeltaMs: fileOff.firstDeltaMs,
      replyOutputTokens: fileOff.replyOutputTokens,
      asked: fileOff.calls[0]?.reasoningEffort,
    }).toEqual({
      calledRunTask: true,
      rightDecision: true,
      firstDeltaMs: null, // a bare tool call streams no text
      replyOutputTokens: 20,
      asked: 'off',
    });

    const factLow = records.find((r) => r.requestId === 'fact' && r.effort === 'low')!;
    expect(factLow.calledRunTask).toBe(false);
    expect(factLow.rightDecision).toBe(true);
    expect(factLow.firstDeltaMs).not.toBeNull();
    expect(factLow.replyOutputTokens).toBe(50);
    expect(factLow.routingNarration).toBe(true);
    expect(factLow.opening).toBe(
      'This is a general knowledge question, so I can answer it directly.',
    );
    // The reply, then the escalation recheck: both traced, both on the measured effort.
    expect(factLow.calls.map((c) => c.reasoningEffort)).toEqual(['low', 'low']);
    expect(factLow.turnOutputTokens).toBe(100);

    const greetingAuto = records.find((r) => r.requestId === 'greeting' && r.effort === 'auto')!;
    expect(greetingAuto.routingNarration).toBe(false);
    expect(greetingAuto.replyOutputTokens).toBe(80);
    expect(greetingAuto.calls[0]?.reasoningEffort).toBeNull();

    const off = summarize(records).find((s) => s.effort === 'off')!;
    expect({
      turns: off.turns,
      rightDecisions: off.rightDecisions,
      taskLaunched: off.taskLaunched,
      taskTurns: off.taskTurns,
      noTaskAnswered: off.noTaskAnswered,
      noTaskTurns: off.noTaskTurns,
      withText: off.withText,
      replyOutputTokensMedian: off.replyOutputTokensMedian,
      routingNarrations: off.routingNarrations,
      errors: off.errors,
    }).toEqual({
      turns: 6,
      rightDecisions: 6,
      taskLaunched: 2,
      taskTurns: 2,
      noTaskAnswered: 4,
      noTaskTurns: 4,
      withText: 4,
      replyOutputTokensMedian: 20,
      routingNarrations: 2,
      errors: 0,
    });

    // Nothing written: every turn rolled back, the agent's row as it was.
    expect({
      conversations: await count(conversations),
      messages: await count(chatMessages),
      jobs: await count(agentJobs),
      calls: await count(llmCalls),
    }).toEqual(before);
    const [row] = await db
      .select({ reasoning: agents.reasoningEffort, spoken: agents.spokenReasoningEffort })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(row).toEqual({ reasoning: 'high', spoken: 'max' });
  });

  // The orchestrator measures on the running stack's database, which does not
  // have migration 0159 before the merge. The column exists on the turn's copy
  // only, and the database is still left as it was.
  // Mutation verified: the ALTER on the copy removed → red (the turn fails).
  it('measures a database that does not have the column yet, and does not add it', async () => {
    const own = (await spinUpTestDb()).db;
    const { entityId, agentId } = await seedJob(own, { model: MODEL, role: 'orchestrator' });
    await own.execute(sql`ALTER TABLE agents DROP COLUMN spoken_reasoning_effort`);

    const bodies = scriptedProvider();
    const [record] = await measureSpokenReasoning(own as unknown as AnyDrizzleDb, {
      entityId,
      agentId,
      efforts: ['low'],
      runs: 1,
      requests: [REQUESTS[2]!],
    });
    vi.unstubAllGlobals();

    expect({ error: record?.error, asked: record?.calls[0]?.reasoningEffort }).toEqual({
      error: undefined,
      asked: 'low',
    });
    expect(bodies.find((b) => b.messages.some((m) => m.role === 'system'))?.reasoning).toEqual({
      enabled: true,
      effort: 'low',
    });
    const columns = await own.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'spoken_reasoning_effort'`,
    );
    expect((columns as unknown as { rows: unknown[] }).rows).toEqual([]);
  });

  it('the default requests are 7 that need a task and 10 that do not, with the five English ones of #987', () => {
    expect(SPOKEN_REASONING_REQUESTS).toHaveLength(17);
    expect(SPOKEN_REASONING_REQUESTS.filter((r) => r.needsTask)).toHaveLength(7);
    expect(new Set(SPOKEN_REASONING_REQUESTS.map((r) => r.id)).size).toBe(17);
    const english = SPOKEN_REASONING_REQUESTS.filter((r) => r.id.endsWith('-en')).map((r) => [
      r.text,
      r.needsTask,
    ]);
    expect(english).toEqual([
      ["What's the weather usually like in Tokyo in November?", false],
      ['How long does it take to boil an egg?', false],
      ["What's the difference between a virus and a bacterium?", false],
      ['Tell me a three-paragraph story about a robot learning to cook.', false],
      ['Search the web for the latest news about Microsoft layoffs.', true],
    ]);
  });

  // #987 — the length of a reply, counted on fixed replies. Mutation verified:
  // `wordCount` counting every whitespace token (the lone dash too) → red;
  // the abbreviation rule of `sentenceCount` removed → red.
  const TOKYO =
    'Tokyo in November is usually mild and dry: daytime highs around 16 to 18 °C, lows around 8 to 10 °C, with plenty of sunshine and little rain. Mornings and evenings are cool, so a light jacket is handy. Autumn foliage peaks in mid to late November, which makes it a popular month to visit. This is general climate knowledge, not a live forecast. If you want the forecast for specific dates, I can look it up.';

  it.each([
    [TOKYO, 77, 5],
    ['Tokyo in November is usually mild and dry, with highs around 16 to 18 °C.', 15, 1],
    ['Canberra. If you want, I can start a task that needs no tool.', 13, 2],
    ['It is mild in places, e.g. Tokyo and Osaka.', 9, 1],
    ['It is mild, i.e. not cold. Pack light.', 8, 2],
    ['Ask Dr. Martin about it. He knows.', 7, 2],
    ['It takes about 3.5 minutes.', 5, 1],
    ['Yes - it is. Really!', 4, 2],
    ['Wait... what? Fine', 3, 2],
    ['Il fait doux, vers 16 à 18 °C. Prends une veste légère.', 12, 2],
    ['No. It does not.', 4, 2],
    ['', 0, 0],
    ['   ', 0, 0],
  ])('counts the words and the sentences of %j', (reply, words, sentences) => {
    expect({ words: wordCount(reply), sentences: sentenceCount(reply) }).toEqual({
      words,
      sentences,
    });
  });

  it('records the length of each reply and summarizes the no-task turns per effort', async () => {
    const { entityId, agentId } = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    scriptedProvider();
    const records = await measureSpokenReasoning(db as unknown as AnyDrizzleDb, {
      entityId,
      agentId,
      efforts: ['off'],
      runs: 1,
      requests: REQUESTS,
    });
    vi.unstubAllGlobals();
    // The scripted reply to the greeting is "I am well, thank you." (5 words,
    // 1 sentence); to the fact it is NARRATED (13 words, 2 sentences); the
    // escalated request streams no text.
    expect(records.map((r) => [r.requestId, r.replyWords, r.replySentences])).toEqual([
      ['file', 0, 0],
      ['fact', 13, 2],
      ['greeting', 5, 1],
    ]);
    const [off] = summarize(records);
    expect({ median: off?.noTaskWordsMedian, max: off?.noTaskWordsMax }).toEqual({
      median: 5,
      max: 13,
    });
  });

  const turn = (over: Partial<TurnRecord>): TurnRecord => ({
    effort: 'off',
    run: 1,
    requestId: 'r',
    needsTask: false,
    calledRunTask: false,
    rightDecision: true,
    firstDeltaMs: 100,
    totalMs: 200,
    replyOutputTokens: 10,
    turnOutputTokens: 10,
    calls: [],
    opening: '',
    routingNarration: false,
    replyWords: 0,
    replySentences: 0,
    ...over,
  });

  it('the summary gives, per effort, the median and the maximum words of the turns that answered without a task', () => {
    const rows = summarize([
      ...[10, 20, 30, 80].map((replyWords) => turn({ effort: 'off', replyWords })),
      // Not answers to a no-task request: a task request, an escalation by
      // mistake, a failed turn. None of them counts toward the words.
      turn({ effort: 'off', needsTask: true, calledRunTask: true, replyWords: 400 }),
      turn({ effort: 'off', calledRunTask: true, rightDecision: false, replyWords: 0 }),
      turn({ effort: 'off', error: 'llm_error', replyWords: 0 }),
      ...[5, 7, 9].map((replyWords) => turn({ effort: 'low', replyWords })),
      turn({ effort: 'auto', needsTask: true, calledRunTask: true, replyWords: 3 }),
    ]);
    expect(rows.map((r) => [r.effort, r.noTaskWordsMedian, r.noTaskWordsMax])).toEqual([
      ['off', 20, 80],
      ['low', 7, 9],
      ['auto', null, null],
    ]);
  });

  it.each([
    ['This is a general knowledge question, so I can answer it directly. Canberra.', true],
    ["That's a simple question, I'll answer it directly.", true],
    ['No need to start a task for this: it is noon in Tokyo.', true],
    ["C'est une question de culture générale, je peux y répondre directement.", true],
    ['Pas besoin de lancer une tâche : il est midi à Tokyo.', true],
    // #995 — the two openings heard live and measured on 2026-11-04.
    [
      'This is a general knowledge question I can answer directly without any action. In Paris, November is cool.',
      true,
    ],
    ['This is a creative writing request I can answer directly, so no delegation is needed.', true],
    ['This is a creative request, so I will just write it. Once upon a time.', true],
    ['Without any action needed, here is the answer: nine minutes.', true],
    // Not narration: an answer, a story, a pleasantry, an email.
    ['In Paris, November is cool and damp, with highs around 10 degrees.', false],
    ['Once upon a time, a robot named Pim wanted to learn to cook.', false],
    ['Great question! Soft-boiled takes about six minutes.', false],
    ['Subject: The heating is broken. Dear Mr. Martin, I am writing to ask for a repair.', false],
    ['Canberra est la capitale de l’Australie.', false],
    ['Il est midi à Tokyo, et la nuit tombe vers dix-sept heures.', false],
    ['Je m’en occupe.', false],
    ['Bonne question ! Le thé, sans hésiter.', false],
    // Only the opening is read: a later sentence about tasks is not narration.
    ['Canberra. If you want, I can start a task that needs no tool.', false],
  ])('opensWithRoutingNarration(%j) = %s', (reply, expected) => {
    expect(opensWithRoutingNarration(reply)).toBe(expected);
  });
});
