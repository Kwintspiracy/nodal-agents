// client-streamed-turn.test.ts — `generateText(args, { streamed: true })` (#440)
//
// The job loop asks for a streamed turn through the same client method it has
// always called. These tests prove the wiring on a REAL client: which of the
// model's two entry points (doStream / doGenerate) the call reaches, and that
// the observation the llm_calls sink records still carries the usage.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

import { mockTextResult } from './_mock-helpers';
import type { LlmCallObservation } from '../observe';
import { LLMCallCancelledError } from '../errors';

let currentModel: MockLanguageModelV3;

vi.mock('../providers/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/openrouter')>();
  return { ...actual, buildOpenRouterModel: () => currentModel };
});

const { createLlmClient } = await import('../client');

const streamed: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'from ' },
  { type: 'text-delta', id: 't', delta: 'the stream' },
  { type: 'text-end', id: 't' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 42, noCache: 42, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    },
  },
];

beforeEach(() => {
  currentModel = new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'm',
    doStream: async () => ({ stream: simulateReadableStream({ chunks: streamed }) }),
    doGenerate: async () => mockTextResult('from generate'),
  });
});

const ARGS = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('generateText streamed option @cap:organiser-equipe/moteur', () => {
  it('streams a turn when asked, and records its usage', async () => {
    const seen: LlmCallObservation[] = [];
    const client = createLlmClient(
      { provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' },
      { onCall: (o) => seen.push(o) },
    );

    const res = await client.generateText(ARGS, { streamed: true });

    expect(res.text).toBe('from the stream');
    // The generateText contract holds on the streamed path too.
    expect(res.output).toBe('from the stream');
    expect(res.experimental_output).toBe('from the stream');
    expect(currentModel.doStreamCalls).toHaveLength(1);
    expect(currentModel.doGenerateCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage?.inputTokens).toBe(42);
    expect(seen[0]?.usage?.outputTokens).toBe(7);
    expect(seen[0]?.error).toBeNull();
  });

  it('hands each piece of text to onTextDelta as it arrives, in order (#458)', async () => {
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' });
    const pieces: string[] = [];

    const res = await client.generateText(ARGS, {
      streamed: true,
      onTextDelta: (t) => pieces.push(t),
    });

    expect(pieces).toEqual(['from ', 'the stream']);
    expect(res.text).toBe(pieces.join(''));
  });

  it('sizes the first-token clock with the tool schemas it sends', async () => {
    // 200 large tool definitions ≈ 55K tokens: the first token may take 130 s
    // (over the 120 s base clock) without the call being cut.
    const { z } = await import('zod');
    const tools: Record<string, { description: string; inputSchema: unknown }> = {};
    for (let i = 0; i < 200; i++) {
      tools[`mcp__server__tool_${i}`] = {
        description: 'd'.repeat(600),
        inputSchema: z.object({ query: z.string().describe('q'.repeat(400)) }),
      };
    }
    currentModel = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'm',
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: streamed, initialDelayInMs: 130_000 }),
      }),
    });
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' });
    vi.useFakeTimers();
    try {
      const call = client
        .generateText({ ...ARGS, tools } as Parameters<typeof client.generateText>[0], {
          streamed: true,
        })
        .then(
          (r) => ({ ok: r.text }),
          (e: unknown) => ({ err: e }),
        );
      // The schemas are sized before the request leaves: wait for the stream
      // to start (and its 130 s delay to be armed) before moving the clock.
      for (let i = 0; i < 1_000 && currentModel.doStreamCalls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(currentModel.doStreamCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(130_001);
      // The chunks after the first come on zero-delay timers: let them run
      // (still well under the 150 s clock of a 50K+ prompt).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await call).toEqual({ ok: 'from the stream' });
    } finally {
      vi.useRealTimers();
    }
  });

  // #442 : la valeur de l'agent arrive jusqu'à l'horloge du premier jeton.
  it('an agent’s first-token wait lets a slow thinker through; without it the call is cut', async () => {
    const slow = () =>
      new MockLanguageModelV3({
        provider: 'openrouter',
        modelId: 'm',
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: streamed, initialDelayInMs: 400_000 }),
        }),
      });
    const run = async (opts: { firstTokenTimeoutMs?: number }) => {
      currentModel = slow();
      const client = createLlmClient({
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        apiKey: 'k',
      });
      vi.useFakeTimers();
      try {
        const call = client.generateText(ARGS, { streamed: true, ...opts }).then(
          (r) => ({ ok: r.text }),
          (e: unknown) => ({ err: (e as Error).name }),
        );
        for (let i = 0; i < 1_000 && currentModel.doStreamCalls.length === 0; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(401_000);
        return await call;
      } finally {
        vi.useRealTimers();
      }
    };

    expect(await run({})).toEqual({ err: 'LLMTimeoutError' });
    expect(await run({ firstTokenTimeoutMs: 600_000 })).toEqual({ ok: 'from the stream' });
  });

  it('keeps the one-shot call when the option is absent', async () => {
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' });

    const res = await client.generateText(ARGS);

    expect(res.text).toBe('from generate');
    expect(currentModel.doStreamCalls).toHaveLength(0);
  });

  it('a Stop on a one-shot call leaves at once as a cancellation, never re-sent', async () => {
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-4.7', apiKey: 'k' });
    const stop = new AbortController();
    stop.abort();

    const err = await client
      .generateText(ARGS, { streamed: true, abortSignal: stop.signal })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMCallCancelledError);
    expect(currentModel.doGenerateCalls).toHaveLength(0);
  });

  it('keeps the one-shot call for a model whose tool calls are parsed from its text', async () => {
    // z-ai/glm-4.7 goes through the text-parsing middleware, which cannot stream.
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-4.7', apiKey: 'k' });

    const res = await client.generateText(ARGS, { streamed: true });

    expect(res.text).toBe('from generate');
    expect(currentModel.doStreamCalls).toHaveLength(0);
  });
});
