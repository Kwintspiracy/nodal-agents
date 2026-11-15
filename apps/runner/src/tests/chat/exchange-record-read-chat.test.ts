// exchange-record-read-chat.test.ts — the chat turn, third reader of the
// runner's record (#1101), proven on what the provider receives.
//
// The real exchange of 2026-11-14: a spoken front answered while a task it had
// launched was running. The record of that running task quoted a first send
// that had failed and that the task was already doing again; the front told
// the person "a problem with the image". The second send succeeded. A turn that
// answers while a job runs is told that the job runs and what it has called,
// never what an attempt returned. Once the job has ended, its acting calls are
// quoted as on main, every one, in order. Spoken and written turns
// go through the same history: both are proven here, on the prompt the mock
// provider is handed (`doGenerate`), the request body as the provider sees it.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, chatMessages, conversations, eq, toolCalls } from '@nodal-agents/db';
import { runnerRecordEntries } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import { runChatTurn } from '../../chat/run-chat-turn.ts';
import { RECORD_WORDS } from '../../job/record-words.ts';

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
      if (!active) throw new Error('no active LLM client');
      return active;
    },
  };
});

/**
 * A client whose provider records the prompt it is handed — the body of the
 * request — and the messages the turn passed it, then answers in words.
 */
function recordingClient(seen: { prompts: unknown[]; messages: ModelMessage[][] }) {
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      seen.prompts.push(options.prompt);
      return {
        content: [{ type: 'text', text: 'It is on its way.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const client: RunnerDeps['llmClient'] = {
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
  return client;
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };
let deps: RunnerDeps;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  deps = { db } as unknown as RunnerDeps;
});

beforeEach(async () => {
  await db.delete(toolCalls);
  await db.delete(chatMessages);
  await db.delete(conversations);
  await db.delete(agentJobs).where(eq(agentJobs.agentId, seed.agentId));
});

const SEND = 'msg_srv__send_image';
const json = (value: unknown) => ({ type: 'json', value });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** The task's transcript: an image made, a send refused at the gate, a send that went. */
function transcript(task: string): unknown[] {
  const calls: Array<[string, unknown]> = [
    ['generate_image', json({ path: 'out/cat.png' })],
    [SEND, json({ error: 'invalid_input: path: Required' })],
    [SEND, json({ sent: true })],
  ];
  return [
    { role: 'user', content: task },
    ...calls.flatMap(([name, output], i) => [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: name, input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: name, output }],
      },
    ]),
  ];
}

async function turnWhile(
  job: { status: string; completedAt: Date | null; result?: string },
  spoken: boolean,
) {
  const channel = spoken ? 'device' : 'dashboard';
  const [conv] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      chatId: spoken ? 'device-hall' : null,
      title: 'Cat',
    })
    .returning();
  const task = 'Draw a cat and send it to me';
  const [launched] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel,
      conversationId: conv!.id,
      task,
      status: job.status,
      result: job.result ?? null,
      createdAt: ago(3),
      completedAt: job.completedAt,
      messages: transcript(task) as never,
      toolsUsed: ['generate_image', SEND],
    })
    .returning({ id: agentJobs.id });
  await db.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv!.id,
      role: 'user',
      content: task,
      createdAt: ago(4),
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv!.id,
      role: 'assistant',
      content: 'On it.',
      jobId: launched!.id,
      createdAt: ago(3),
    },
  ]);
  const seen = { prompts: [] as unknown[], messages: [] as ModelMessage[][] };
  setActiveLlmClient(recordingClient(seen));
  const result = await runChatTurn({
    deps,
    entityId: seed.entityId,
    agentId: seed.agentId,
    conversationId: conv!.id,
    message: 'So, is it there?',
    ...(spoken ? { spoken: { durationMs: 1_400 } } : {}),
  });
  expect(result.ok).toBe(true);
  return { body: JSON.stringify(seen.prompts[0]), messages: seen.messages[0]! };
}

function runTaskResult(messages: ModelMessage[]): string {
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === 'tool-result' && p.toolName === 'run_task' && p.output.type === 'text') {
        return p.output.value;
      }
    }
  }
  throw new Error('no run_task result in the request');
}

const RUNNING_RECORD = RECORD_WORDS.running(`generate_image, ${SEND} ×2`);

describe('the chat turn reads the record of a launched job as settled facts only (#1101) @cap:reprendre-conversation/moteur', () => {
  for (const spoken of [true, false]) {
    const turn = spoken ? 'a spoken turn' : 'a written turn';

    it(`${turn}, while the task runs: it runs, and what it called; not the failed attempt`, async () => {
      const { body, messages } = await turnWhile(
        { status: 'processing', completedAt: null },
        spoken,
      );
      expect(runTaskResult(messages)).toBe(
        `Still running — no result yet. What the person says about it, or asks beside it, still goes through run_task.\n\n${RUNNING_RECORD}`,
      );
      // What the provider receives, the request body itself.
      expect(body).toContain(JSON.stringify(RUNNING_RECORD).slice(1, -1));
      expect(body).not.toContain('invalid_input');
      expect(body).not.toContain('{\\"sent\\":true}');
    });

    it(`${turn}, after the task ended: every acting call quoted in order, as on main`, async () => {
      const { body, messages } = await turnWhile(
        { status: 'completed', completedAt: ago(2), result: 'Sent you the cat.' },
        spoken,
      );
      const ends = messages
        .map((m) => runnerRecordEntries(m))
        .filter((e): e is string[] => e !== null)
        .filter((e) => e[0]!.includes('The task launched at'));
      expect(ends).toHaveLength(1);
      // The task's report is the agent's message after the record (#1088).
      expect(ends[0]!.slice(1)).toEqual([
        `[Actions performed in this exchange: generate_image, ${SEND} ×2]`,
        'generate_image → {"path":"out/cat.png"}',
        `${SEND} → {"error":"invalid_input: path: Required"}`,
        `${SEND} → {"sent":true}`,
      ]);
      // What the provider receives carries both answers, in order.
      const failed = body.indexOf('invalid_input: path: Required');
      expect(failed).toBeGreaterThan(-1);
      expect(body.indexOf('{\\"sent\\":true}', failed)).toBeGreaterThan(failed);
    });
  }
});
