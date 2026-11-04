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
  summarize,
  SPOKEN_REASONING_REQUESTS,
  type MeasureRequest,
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

  it('the default requests are 6 that need a task and 6 that do not', () => {
    expect(SPOKEN_REASONING_REQUESTS).toHaveLength(12);
    expect(SPOKEN_REASONING_REQUESTS.filter((r) => r.needsTask)).toHaveLength(6);
    expect(new Set(SPOKEN_REASONING_REQUESTS.map((r) => r.id)).size).toBe(12);
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
