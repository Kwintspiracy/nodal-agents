// chat-turn-tool-budget.test.ts — un tour de chat au-delà du budget d'appels
// n'agit pas (#564, revue Codex de #568, passe 4).
//
// Le tour de chat n'offre qu'un outil, `run_task`, et n'en exécute que le
// premier : il créait le job du premier appel même quand la réponse en portait
// 51. La règle de la boucle des jobs (`assertTurnToolCallBudget`) vaut ici
// aussi, sur chacun des trois appels du tour (la réponse, la relance
// d'escalade, la réponse après un `run_task` refusé) : un tour trop gros est
// refusé entier, aucun job n'est créé, aucune réponse n'est gardée. Le vrai
// client, seul le modèle du fournisseur est simulé.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, chatMessages, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

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
const BUDGET = DEFAULT_LIMITS.maxToolCallsPerTurn;

type Content =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string };

const runTasks = (n: number): Content[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'tool-call' as const,
    toolCallId: `rt-${String(i)}`,
    toolName: 'run_task',
    input: JSON.stringify({ instruction: `${INSTRUCTION} ${String(i)}` }),
  }));

/** Un modèle qui rend, appel après appel, les réponses données (streamé ou non). */
function modelAnswering(replies: Array<{ content: Content[]; finish: 'stop' | 'tool-calls' }>) {
  let calls = 0;
  const usage = {
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1_200, text: 1_200, reasoning: undefined },
  };
  const next = () => replies[Math.min(calls++, replies.length - 1)]!;
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
            { type: 'finish', finishReason: { unified: r.finish, raw: r.finish }, usage },
          ],
        }) as never,
      };
    },
    doGenerate: async () => {
      const r = next();
      return {
        content: r.content,
        finishReason: { unified: r.finish, raw: r.finish },
        usage,
        warnings: [],
      };
    },
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

describe('a chat turn over the per-turn tool-call budget does not act @cap:suivre-execution/moteur', () => {
  for (const streamed of [true, false]) {
    const path = streamed ? 'streamed' : 'one-shot';
    const turn = (conversationId: string) =>
      runChatTurn({
        deps,
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId,
        message: 'Draw the series',
        ...(streamed ? { onTextDelta: () => {} } : {}),
      });

    it(`${path}: a reply with 51 run_task calls launches no job and stores no reply`, async () => {
      mockModel.current = modelAnswering([
        {
          content: [{ type: 'text', text: 'On it.' }, ...runTasks(BUDGET + 1)],
          finish: 'tool-calls',
        },
      ]);
      const conversationId = await newConversation();

      const result = await turn(conversationId);

      expect(result).toEqual({ ok: false, error: 'tool_call_limit_exceeded' });
      const after = await effects(conversationId);
      expect(after.jobs).toEqual([]);
      expect(after.assistantRows).toEqual([]);
    });

    it(`${path}: the escalation recheck with 51 calls fails the turn the same way`, async () => {
      mockModel.current = modelAnswering([
        { content: [{ type: 'text', text: 'I will draw the series now.' }], finish: 'stop' },
        { content: runTasks(BUDGET + 1), finish: 'tool-calls' },
      ]);
      const conversationId = await newConversation();

      const result = await turn(conversationId);

      expect(result).toEqual({ ok: false, error: 'tool_call_limit_exceeded' });
      const after = await effects(conversationId);
      expect(after.jobs).toEqual([]);
      expect(after.assistantRows).toEqual([]);
    });

    it(`${path}: control, a reply with exactly 50 calls launches its first run_task as before`, async () => {
      mockModel.current = modelAnswering([
        { content: [{ type: 'text', text: 'On it.' }, ...runTasks(BUDGET)], finish: 'tool-calls' },
      ]);
      const conversationId = await newConversation();

      const result = await turn(conversationId);

      expect(result.ok).toBe(true);
      const after = await effects(conversationId);
      expect(after.jobs.map((j) => j.task)).toEqual([`${INSTRUCTION} 0`]);
    });
  }
});
