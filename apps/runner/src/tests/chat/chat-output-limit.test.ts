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
