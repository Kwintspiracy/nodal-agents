// client-output-limit.test.ts — a turn cut on the output-token cap is refused (#554)
//
// Run 04229144 (z-ai/glm-5.3 via OpenRouter): turn 6 stopped at exactly the
// output cap, 131 072 tokens, and the runner executed ~25 tool calls parsed out
// of it. The client now refuses any call that OFFERED tools and whose response
// stopped with `finishReason === 'length'`, on both entry points (streamed and
// one-shot), under failover or not, and never retries it. These tests drive a
// REAL client over a mock model and read what comes back: the thrown error and
// its billed usage, the llm_calls observation, which links were asked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';

import { mockUsage } from './_mock-helpers';
import type { LlmCallObservation } from '../observe';
import { LLMOutputLimitError } from '../errors';

let currentModel: MockLanguageModelV3;

vi.mock('../providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/openrouter')>();
  return { ...actual, buildOpenRouterModel: () => currentModel };
});

const { createLlmClient } = await import('../client');
const { createFailoverFromClients } = await import('../failover');

type Unified = 'length' | 'tool-calls' | 'stop';

const TOOLS = {
  save_memory: {
    description: 'Save a fact',
    inputSchema: z.object({ content: z.string() }),
  },
  file_write: {
    description: 'Write a file',
    inputSchema: z.object({ path: z.string(), content: z.string().optional() }),
  },
};

const ARGS = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'draw' }],
  tools: TOOLS,
};

function generated(reason: Unified, withCalls = true): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: 'text', text: 'working' },
      ...(withCalls
        ? [
            {
              type: 'tool-call' as const,
              toolCallId: 'c1',
              toolName: 'save_memory',
              input: '{"content":"x"}',
            },
            {
              type: 'tool-call' as const,
              toolCallId: 'c2',
              toolName: 'file_write',
              input: '{"path":"a.txt"}',
            },
          ]
        : []),
    ],
    finishReason: { unified: reason, raw: reason },
    usage: mockUsage(900, 131_072),
    warnings: [],
  };
}

function streamedParts(reason: Unified): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'working' },
    { type: 'text-end', id: 't' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'save_memory', input: '{"content":"x"}' },
    {
      type: 'finish',
      finishReason: { unified: reason, raw: reason },
      usage: mockUsage(900, 131_072),
    },
  ];
}

function useModel(reason: Unified, withCalls = true): void {
  currentModel = new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3',
    doGenerate: async () => generated(reason, withCalls),
    doStream: async () => ({ stream: simulateReadableStream({ chunks: streamedParts(reason) }) }),
  });
}

function client(seen?: LlmCallObservation[]) {
  return createLlmClient(
    { provider: 'openrouter', model: 'z-ai/glm-5.3', apiKey: 'k' },
    seen ? { onCall: (o) => seen.push(o) } : {},
  );
}

beforeEach(() => useModel('tool-calls'));

describe('a turn cut on the output-token cap is refused @cap:suivre-execution/moteur', () => {
  it('one-shot: refuses the cut turn, with its billed usage and the calls it held', async () => {
    useModel('length');
    const seen: LlmCallObservation[] = [];

    const err = await client(seen)
      .generateText(ARGS)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LLMOutputLimitError);
    const refusal = err as LLMOutputLimitError;
    expect(refusal.code).toBe('output_limit_reached');
    expect(refusal.provider).toBe('openrouter');
    expect(refusal.model).toBe('z-ai/glm-5.3');
    expect(refusal.usage).toEqual({ inputTokens: 900, outputTokens: 131_072 });
    expect(refusal.toolCallCount).toBe(2);
    // Asked once: the refusal is not retried by the layers under it.
    expect(currentModel.doGenerateCalls).toHaveLength(1);
    // The llm_calls row keeps what was billed, and says why nothing came back.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage?.outputTokens).toBe(131_072);
    expect(seen[0]?.error).toMatch(/^LLMOutputLimitError: .*output-token cap/);
  });

  it('streamed: refuses the cut turn the same way', async () => {
    useModel('length');

    const err = await client()
      .generateText(ARGS, { streamed: true })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LLMOutputLimitError);
    expect((err as LLMOutputLimitError).usage.outputTokens).toBe(131_072);
    expect((err as LLMOutputLimitError).toolCallCount).toBe(1);
    expect(currentModel.doStreamCalls).toHaveLength(1);
  });

  it('a cut turn with no parsed tool call is refused too: its text is not a finished answer', async () => {
    useModel('length', false);

    await expect(client().generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
  });

  it('the same calls with a normal finish are returned as before', async () => {
    const seen: LlmCallObservation[] = [];

    const oneShot = await client(seen).generateText(ARGS);
    expect(oneShot.finishReason).toBe('tool-calls');
    expect(oneShot.toolCalls.map((c) => [c.toolName, c.input])).toEqual([
      ['save_memory', { content: 'x' }],
      ['file_write', { path: 'a.txt' }],
    ]);
    expect(seen[0]?.error).toBeNull();

    const streamedTurn = await client().generateText(ARGS, { streamed: true });
    expect(streamedTurn.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);
  });

  it('a call that offers no tools is not a turn: a capped completion is returned', async () => {
    // The conformance probes ask for 8 output tokens on purpose; being cut
    // there is the expected answer, not a failure.
    useModel('length', false);
    const { tools: _tools, ...plain } = ARGS;

    const res = await client().generateText(plain);

    expect(res.finishReason).toBe('length');
    expect(res.text).toBe('working');
  });

  it('under failover the refusal propagates: the next link is never asked', async () => {
    useModel('length');
    const first = currentModel;
    const backup = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'backup',
      doGenerate: async () => generated('tool-calls'),
    });
    const primary = client();
    currentModel = backup;
    const secondary = createLlmClient({ provider: 'openrouter', model: 'backup', apiKey: 'k' });
    currentModel = first;
    const chain = createFailoverFromClients([primary, secondary]);

    await expect(chain.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
    expect(backup.doGenerateCalls).toHaveLength(0);
  });
});
