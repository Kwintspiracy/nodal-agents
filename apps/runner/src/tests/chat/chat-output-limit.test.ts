// chat-output-limit.test.ts — a chat reply cut on the output-token cap does not act (#554)
//
// The chat turn offers one tool, `run_task`, and acting on it creates a job
// whose instruction is the call's argument. A reply stopped on the output cap
// may carry a partial call, so the same refusal that protects the job loop
// holds here: the REAL client (`createLlmClient`) refuses the cut turn, no job
// is created, no reply is stored, and the turn answers with the code. The
// tool-free retry that follows other chat failures is NOT played: it would be a
// new attempt, which nothing here decides. Only the provider model is simulated.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, chatMessages, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';

const { mockModel } = vi.hoisted(() => ({ mockModel: { current: null as unknown } }));

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (
      _config: Parameters<typeof actual.createLlmClient>[0],
      opts: Parameters<typeof actual.createLlmClient>[1],
    ) =>
      actual.createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.3', apiKey: 'k' }, opts),
  };
});

vi.mock('../../../../../packages/llm/src/providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildOpenRouterModel: () => mockModel.current };
});

const INSTRUCTION = 'Draw the series and file it';

/**
 * A model whose reply carries a `run_task` call and stops for `finish`, on
 * both entry points (the streamed turn, and the one-shot calls that follow).
 */
function modelReplying(finish: 'length' | 'tool-calls'): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 131_072, text: 131_072, reasoning: undefined },
  };
  const call = {
    type: 'tool-call' as const,
    toolCallId: 'rt-1',
    toolName: 'run_task',
    input: JSON.stringify({ instruction: INSTRUCTION }),
  };
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'On it.' },
          { type: 'text-end', id: 't' },
          call,
          { type: 'finish', finishReason: { unified: finish, raw: finish }, usage },
        ],
      }) as never,
    }),
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'On it.' }, call],
      finishReason: { unified: finish, raw: finish },
      usage,
      warnings: [],
    }),
  });
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
});

beforeEach(async () => {
  await db.delete(chatMessages);
  await db.delete(agentJobs);
  await db.delete(conversations);
});

async function newConversation(): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'Cap' })
    .returning({ id: conversations.id });
  return conv!.id;
}

async function effects(conversationId: string) {
  const jobs = await db
    .select({ task: agentJobs.task })
    .from(agentJobs)
    .where(eq(agentJobs.conversationId, conversationId));
  const replies = await db
    .select({ role: chatMessages.role })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId));
  return { jobs, assistantRows: replies.filter((r) => r.role === 'assistant') };
}

describe('a chat reply cut on the output-token cap does not act @cap:suivre-execution/moteur', () => {
  for (const streamed of [true, false]) {
    const path = streamed ? 'streamed' : 'one-shot';

    it(`${path}: launches no job, stores no reply, answers output_limit_reached`, async () => {
      mockModel.current = modelReplying('length');
      const conversationId = await newConversation();

      const result = await runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId,
        message: 'Draw the series',
        ...(streamed ? { onTextDelta: () => {} } : {}),
      });

      expect(result).toEqual({ ok: false, error: 'output_limit_reached' });
      const after = await effects(conversationId);
      expect(after.jobs).toEqual([]);
      expect(after.assistantRows).toEqual([]);
    });

    it(`${path}: the same call with a normal finish launches the job, as before`, async () => {
      mockModel.current = modelReplying('tool-calls');
      const conversationId = await newConversation();

      const result = await runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId,
        message: 'Draw the series',
        ...(streamed ? { onTextDelta: () => {} } : {}),
      });

      expect(result.ok).toBe(true);
      const after = await effects(conversationId);
      expect(after.jobs.map((j) => j.task)).toEqual([INSTRUCTION]);
    });
  }
});

/**
 * The reply promises an action but calls no tool (`stop`); the escalation
 * recheck that follows then emits `run_task` and stops on the cap. Calls are
 * counted across both entry points: the first is the reply, the second the
 * recheck, whichever path each takes.
 */
function replyThenCutRecheck(): MockLanguageModelV3 {
  let calls = 0;
  const usage = (out: number) => ({
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: out, text: out, reasoning: undefined },
  });
  const promise = 'I will draw the series now.';
  const call = {
    type: 'tool-call' as const,
    toolCallId: 'rt-2',
    toolName: 'run_task',
    input: JSON.stringify({ instruction: INSTRUCTION }),
  };
  const next = () => {
    calls += 1;
    return calls === 1
      ? { content: [{ type: 'text' as const, text: promise }], finish: 'stop' as const, out: 12 }
      : { content: [call], finish: 'length' as const, out: 131_072 };
  };
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3',
    doStream: async () => {
      const r = next();
      const parts = r.content.flatMap((c): unknown[] =>
        c.type === 'text'
          ? [
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: c.text },
              { type: 'text-end' as const, id: 't' },
            ]
          : [c],
      );
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...parts,
            {
              type: 'finish',
              finishReason: { unified: r.finish, raw: r.finish },
              usage: usage(r.out),
            },
          ],
        }) as never,
      };
    },
    doGenerate: async () => {
      const r = next();
      return {
        content: r.content,
        finishReason: { unified: r.finish, raw: r.finish },
        usage: usage(r.out),
        warnings: [],
      };
    },
  });
}

// Revue Codex de #555, P1, puis revue Nodal de la PR #604, passe 2. #555
// faisait échouer le tour quand la relance était coupée : la réponse, déjà
// partie en flux, disparaissait du fil, et la personne lisait une erreur à la
// place d'une réponse complète. Désormais une relance coupée est ABANDONNÉE
// comme toute autre panne de relance : sa sortie tronquée n'est jamais
// exécutée, et la réponse reste celle du tour, comme quand la relance décline.
describe('an escalation recheck cut on the output-token cap is abandoned @cap:suivre-execution/moteur', () => {
  for (const streamed of [true, false]) {
    const path = streamed ? 'streamed' : 'one-shot';

    it(`${path}: the reply stands, stored, and the cut call launches no job`, async () => {
      mockModel.current = replyThenCutRecheck();
      const conversationId = await newConversation();

      const result = await runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId,
        message: 'Draw the series',
        ...(streamed ? { onTextDelta: () => {} } : {}),
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.reply).toBe('I will draw the series now.');
      const after = await effects(conversationId);
      expect(after.jobs).toEqual([]);
      expect(after.assistantRows).toHaveLength(1);
    });
  }
});

/**
 * A job already runs in the conversation: the reply's `run_task` is refused
 * (#453), and the reply written after that refusal carries a new `run_task`
 * and stops on the cap. Only calls that offer tools consume the scenario; the
 * auto-title call (no tools) gets a plain title.
 */
function refusedThenCutFollowUp(): MockLanguageModelV3 {
  let toolCalls = 0;
  const usage = (out: number) => ({
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: out, text: out, reasoning: undefined },
  });
  const runTask = (id: string) => ({
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'run_task',
    input: JSON.stringify({ instruction: INSTRUCTION }),
  });
  const next = (offersTools: boolean) => {
    if (!offersTools) {
      return { content: [{ type: 'text' as const, text: 'Cap' }], finish: 'stop' as const, out: 2 };
    }
    toolCalls += 1;
    return toolCalls === 1
      ? { content: [runTask('rt-a')], finish: 'tool-calls' as const, out: 20 }
      : { content: [runTask('rt-b')], finish: 'length' as const, out: 131_072 };
  };
  return new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3',
    doStream: async (options) => {
      const r = next((options.tools ?? []).length > 0);
      const parts = r.content.flatMap((c): unknown[] =>
        c.type === 'text'
          ? [
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: c.text },
              { type: 'text-end' as const, id: 't' },
            ]
          : [c],
      );
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...parts,
            {
              type: 'finish',
              finishReason: { unified: r.finish, raw: r.finish },
              usage: usage(r.out),
            },
          ],
        }) as never,
      };
    },
    doGenerate: async (options) => {
      const r = next((options.tools ?? []).length > 0);
      return {
        content: r.content,
        finishReason: { unified: r.finish, raw: r.finish },
        usage: usage(r.out),
        warnings: [],
      };
    },
  });
}

// Revue Codex de #555, passe 2 : la réponse écrite après un `run_task` refusé
// avalait l'erreur, et la relance sans outils pouvait rendre le tour réussi.
describe('the reply after a refused run_task, cut on the cap, fails the turn @cap:suivre-execution/moteur', () => {
  for (const streamed of [true, false]) {
    const path = streamed ? 'streamed' : 'one-shot';

    it(`${path}: no second job, no stored reply, output_limit_reached`, async () => {
      mockModel.current = refusedThenCutFollowUp();
      const conversationId = await newConversation();
      await db.insert(agentJobs).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        status: 'processing',
        channel: 'dashboard',
        conversationId,
        task: 'The job already running',
      });

      const result = await runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId,
        message: 'Draw the series',
        ...(streamed ? { onTextDelta: () => {} } : {}),
      });

      expect(result).toEqual({ ok: false, error: 'output_limit_reached' });
      const after = await effects(conversationId);
      expect(after.jobs.map((j) => j.task)).toEqual(['The job already running']);
      expect(after.assistantRows).toEqual([]);
    });
  }
});
