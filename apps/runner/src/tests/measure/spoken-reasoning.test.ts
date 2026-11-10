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
  agentAssignments,
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
  launchNarratesRouting,
  readDelegableTeammates,
  rescoreRecords,
  teammateMatchNames,
  opensWithRoutingNarration,
  sentenceCount,
  summarize,
  summaryTable,
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

// Narrates only because it NAMES a teammate: no verb of hand-over in it.
const LAUNCH_LINE = 'Je lance la recherche avec Researcher.';

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
      const escalate = isTurn && (asked.includes('notes.txt') || asked.includes('magazine'));
      const launchLine = asked.includes('magazine') ? LAUNCH_LINE : null;
      const text = !isTurn
        ? 'No action.'
        : asked.includes('capital')
          ? NARRATED
          : 'I am well, thank you.';
      const delta = escalate
        ? {
            role: 'assistant',
            content: launchLine ?? undefined,
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
        ? { role: 'assistant', content: launchLine, tool_calls: [call] }
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

  it('the default requests are 9 that need a task and 11 that do not, with the five English ones of #987 and the three robot ones of #995', () => {
    expect(SPOKEN_REASONING_REQUESTS).toHaveLength(20);
    expect(SPOKEN_REASONING_REQUESTS.filter((r) => r.needsTask)).toHaveLength(9);
    expect(new Set(SPOKEN_REASONING_REQUESTS.map((r) => r.id)).size).toBe(20);
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
    reply: '',
    routingNarration: false,
    launchNarration: false,
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

  // #995, round 2: the three requests the owner spoke, verbatim.
  it('the robot requests of #995 are in the default list, verbatim', () => {
    expect(
      SPOKEN_REASONING_REQUESTS.filter((r) => r.id.endsWith('-robot')).map((r) => [
        r.id,
        r.text,
        r.needsTask,
      ]),
    ).toEqual([
      [
        'weather-beijing-robot',
        'Quelle est la météo à Pékin euh au mois de décembre en général ?',
        false,
      ],
      [
        'magazine-robot',
        "Est-ce que tu peux me préparer une page format magazine euh au sujet euh de l'espionne en relation avec le PDG de Nvidia ?",
        true,
      ],
      ['print-robot', "Du coup, est-ce que tu peux me l'imprimer maintenant ?", true],
    ]);
  });

  // Conjugated forms of "I answer directly", every person and tense, FR and EN.
  // Mutation verified: the conjugated-forms patterns removed -> the first rows red.
  it.each([
    ['Je réponds directement : à Pékin, décembre est généralement froid.', true],
    ['Je te réponds directement : il fait froid.', true],
    ['Je répondrai moi-même, pas besoin de tâche.', true],
    ['Creative writing is something I can do directly. Once upon a time.', true],
    ["I'll answer directly. Boil it six minutes.", true],
    ['I can handle this myself: nine minutes.', true],
    ["I'm answering directly: Canberra.", true],
    ['Je peux le faire directement : voici une histoire.', true],
    ['À Pékin, décembre est généralement froid, autour de -3 °C.', false],
    ['Bien sûr. Un œuf mollet cuit en six minutes.', false],
    ['Directement au sud de Pékin, la plaine est plate.', false],
    ['I can do that for you: nine minutes in boiling water.', false],
  ])('opensWithRoutingNarration(%j) = %s (conjugated forms)', (reply, expected) => {
    expect(opensWithRoutingNarration(reply)).toBe(expected);
  });

  // The line that goes with run_task. Positives: the owner's openings, the
  // measured ones, every verb of the family. Teammate names come from the DB.
  // Mutation verified: the LAUNCH_NARRATION checks and the names check removed ->
  // every positive red.
  const MATES = ['Researcher', 'Lead-Dev'];
  it.each([
    [
      'Je lance la préparation de la page magazine via Researcher, qui fera la recherche sur ce sujet avant la mise en page.',
      true,
    ],
    ["Je lance l'impression de la page via Researcher, qui a la compétence d'impression.", true],
    ['Je délègue cette recherche à Researcher, qui gère la recherche web approfondie.', true],
    ['Je transmets la demande à Lead-Dev, qui orchestre le codage.', true],
    [
      'This is a single news lookup, but the team routing says substantive web research goes to Researcher, which has premium search access.',
      true,
    ],
    ["Je confie ça à l'équipe.", true],
    ["Je passe la demande à l'équipe.", true],
    ["I'll hand this off to the team.", true],
    ["I'm passing it to the research agent.", true],
    ['Je lance la recherche avec Researcher.', true],
    ['Delegating the search now.', true],
    ["Je prépare la page sur l'espionne qui a renseigné les services chinois.", false],
    ['Je lance la recherche.', false],
    ['Je prépare la page.', false],
    ["Je lance l'impression de la page.", false],
    ['On y va, je cherche ça.', false],
    ["I'm starting the search now.", false],
    ['Je m’en occupe.', false],
    ['Writing the file now.', false],
    ['', false],
  ])('launchNarratesRouting(%j) = %s', (line, expected) => {
    expect(launchNarratesRouting(line, MATES)).toBe(expected);
  });

  it('a teammate name matches whole words only, and only names given by the caller', () => {
    expect(launchNarratesRouting('Je lance la recherche pour Bob.', ['Bob'])).toBe(true);
    expect(launchNarratesRouting('Je lance la recherche pour Bobby.', ['Bob'])).toBe(false);
    expect(launchNarratesRouting('Je lance la recherche pour Bob.', [])).toBe(false);
    expect(launchNarratesRouting('Je lance (a+b) maintenant.', ['(a+b)'])).toBe(true);
  });

  it('the two narration counts are separate, per turn kind (#995)', () => {
    const rows = summarize([
      turn({ routingNarration: true }),
      turn({ routingNarration: false }),
      turn({ needsTask: true, calledRunTask: true, launchNarration: true }),
      turn({ needsTask: true, calledRunTask: true, launchNarration: true }),
      turn({ needsTask: true, calledRunTask: true, launchNarration: false }),
    ]);
    expect([rows[0]?.routingNarrations, rows[0]?.launchNarrations]).toEqual([1, 2]);
  });

  it('records the launch line narration on a real turn, naming the teammates read from the workspace', async () => {
    const { entityId, agentId } = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    scriptedProvider();
    const records = await measureSpokenReasoning(db as unknown as AnyDrizzleDb, {
      entityId,
      agentId,
      efforts: ['off'],
      runs: 1,
      requests: [
        { id: 'magazine', text: 'Prépare une page magazine.', needsTask: true },
        { id: 'file', text: 'Write a file called notes.txt with three lines.', needsTask: true },
      ],
      teammateNames: ['Researcher'],
    });
    vi.unstubAllGlobals();
    expect(
      records.map((r) => [r.requestId, r.calledRunTask, r.launchNarration, r.routingNarration]),
    ).toEqual([
      ['magazine', true, true, false],
      ['file', true, false, false],
    ]);
    const [off] = summarize(records);
    expect([off?.launchNarrations, off?.routingNarrations]).toEqual([1, 0]);
    // The full reply is stored, so a later detector can re-score it for free.
    expect(records[0]?.reply).toBe(LAUNCH_LINE);

    // Without the names the same line is plain: the names plumbing is what flags it.
    scriptedProvider();
    const bare = await measureSpokenReasoning(db as unknown as AnyDrizzleDb, {
      entityId,
      agentId,
      efforts: ['off'],
      runs: 1,
      requests: [{ id: 'magazine', text: 'Prépare une page magazine.', needsTask: true }],
    });
    vi.unstubAllGlobals();
    expect(bare[0]?.launchNarration).toBe(false);
  });

  // Review of #1000, P1 1-5: the detector over-counted. First-person routing
  // constructions only; the same words in someone else's sentence are content.
  // Mutation verified: the first-person subject removed from the patterns -> red.
  it.each([
    'La loi répond directement à cette préoccupation.',
    'The minister responded directly to reporters.',
    "No action was taken at Tuesday's council.",
    'Write it directly on the dotted line.',
    'Il répond directement à la question du juge.',
  ])('opensWithRoutingNarration(%j) = false (someone else is answering)', (reply) => {
    expect(opensWithRoutingNarration(reply)).toBe(false);
  });

  it.each([
    "Je prépare la page sur l'espionne qui a renseigné les services chinois.",
    'Je lance le script via Google Apps Script.',
    "I'll check the weather through January.",
    'Je lance la transmission des fichiers.',
    'The page delegates its layout to CSS.',
    'Je passe au format A4.',
    "I'll route to the museum.",
    'Je prépare le script Java.',
    'Je lance le montage photo.',
    'Je cherche des infos sur Alfred Hitchcock, qui a tourné Psychose.',
    'Je lance la recherche, qui prendra une minute.',
  ])('launchNarratesRouting(%j) = false (content, not routing)', (line) => {
    expect(launchNarratesRouting(line, ['Researcher', 'Lead-Dev'])).toBe(false);
  });

  it('first-person hand-over forms are narration, imperative-to-self included', () => {
    for (const line of [
      'Je délègue la recherche.',
      'Je vais déléguer ça.',
      'Je transmets la demande à mon équipe.',
      "Je confie la rédaction à l'équipe.",
      'Je passe la demande à un collègue.',
      "I'll hand this over to the team.",
      'Let me pass this to a colleague.',
      "I'm delegating this.",
    ]) {
      expect({ line, hit: launchNarratesRouting(line, []) }).toEqual({ line, hit: true });
    }
  });

  it('a teammate name matches as written (case-sensitive), whole word only', () => {
    expect(launchNarratesRouting('Je lance la recherche pour Bob.', ['Bob'])).toBe(true);
    expect(launchNarratesRouting('Je lance la recherche pour bob.', ['Bob'])).toBe(false);
    expect(launchNarratesRouting('Je lance la recherche pour Bobby.', ['Bob'])).toBe(false);
    expect(launchNarratesRouting('Je cherche un researcher.', ['Researcher'])).toBe(false);
  });

  it('only display names and slugs that cannot be common words are matched', () => {
    expect(
      teammateMatchNames([
        { name: 'Researcher', slug: 'researcher' },
        { name: 'Lead Dev', slug: 'lead-dev' },
        { name: 'Java', slug: 'java' },
        { name: 'Montage', slug: 'montage' },
        { name: 'Agent 2', slug: 'agent_2' },
      ]),
    ).toEqual(['Researcher', 'Lead Dev', 'lead-dev', 'Java', 'Montage', 'Agent 2', 'agent_2']);
  });

  it('reads as teammates only the ACTIVE agents the measured agent can delegate to', async () => {
    const { entityId, agentId } = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    const mk = async (name: string, slug: string, active: boolean) =>
      (
        await db
          .insert(agents)
          .values({ entityId, name, slug, personality: 'x', role: 'agent', active })
          .returning({ id: agents.id })
      )[0]!.id;
    const child = await mk('Mate One', 'mate-one', true);
    const inactive = await mk('Mate Off', 'mate-off', false);
    await mk('Stranger', 'stranger-x', true);
    for (const subAgentId of [child, inactive]) {
      await db.insert(agentAssignments).values({ orchestratorId: agentId, subAgentId, entityId });
    }
    const [self] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId));
    const names = await readDelegableTeammates(db as unknown as AnyDrizzleDb, agentId);
    expect(names).toEqual(['Mate One', 'mate-one']);
    expect(names).not.toContain(self!.name);
  });

  // Review of #1000, P2-8: each column is counted over the turns it is measured
  // on, what the model DID, with its own denominator.
  it('counts each narration over the turns where the model did that thing', () => {
    const answered = (over: Partial<TurnRecord>) => turn({ calledRunTask: false, ...over });
    const launched = (over: Partial<TurnRecord>) => turn({ calledRunTask: true, ...over });
    const [row] = summarize([
      // 10 no-task requests, answered, none narrating
      ...Array.from({ length: 10 }, () => answered({})),
      // 3 TASK requests that answered instead of launching, all narrating
      ...Array.from({ length: 3 }, () => answered({ needsTask: true, routingNarration: true })),
      // 2 no-task requests escalated by mistake, one narrating its launch
      launched({ rightDecision: false, launchNarration: true }),
      launched({ rightDecision: false }),
      // an error turn counts in neither
      turn({ error: 'llm_error' }),
    ]);
    expect({
      reply: [row?.routingNarrations, row?.answeredTurns],
      launch: [row?.launchNarrations, row?.launchedTurns],
    }).toEqual({ reply: [3, 13], launch: [1, 2] });
    expect(summaryTable([row!])).toContain('| 3/13 | 1/2 |');
  });

  // Stored replies let a later detector re-score old runs with no model call.
  it('re-scores stored records from their full reply, and refuses records without one', () => {
    const rows = [
      turn({
        reply: 'Je réponds directement : il fait froid. Très froid, vraiment.',
        routingNarration: false,
      }),
      turn({
        calledRunTask: true,
        needsTask: true,
        reply: 'Je lance la recherche avec Researcher.',
        launchNarration: false,
      }),
      turn({ calledRunTask: true, needsTask: true, reply: 'Je lance la recherche.' }),
    ];
    const rescored = rescoreRecords(rows, ['Researcher']);
    expect(
      rescored.map((r) => [r.routingNarration, r.launchNarration, r.opening, r.replyWords]),
    ).toEqual([
      [true, false, 'Je réponds directement : il fait froid.', 9],
      [false, true, 'Je lance la recherche avec Researcher.', 6],
      [false, false, 'Je lance la recherche.', 4],
    ]);
    const { reply: _r, ...noReply } = rows[0]!;
    expect(() => rescoreRecords([noReply as TurnRecord], [])).toThrow(/full reply/);
  });
});
