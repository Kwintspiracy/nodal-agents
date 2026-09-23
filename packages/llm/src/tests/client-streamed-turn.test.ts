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
    expect(currentModel.doStreamCalls).toHaveLength(1);
    expect(currentModel.doGenerateCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage?.inputTokens).toBe(42);
    expect(seen[0]?.usage?.outputTokens).toBe(7);
    expect(seen[0]?.error).toBeNull();
  });

  it('keeps the one-shot call when the option is absent', async () => {
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-5.2', apiKey: 'k' });

    const res = await client.generateText(ARGS);

    expect(res.text).toBe('from generate');
    expect(currentModel.doStreamCalls).toHaveLength(0);
  });

  it('keeps the one-shot call for a model whose tool calls are parsed from its text', async () => {
    // z-ai/glm-4.7 goes through the text-parsing middleware, which cannot stream.
    const client = createLlmClient({ provider: 'openrouter', model: 'z-ai/glm-4.7', apiKey: 'k' });

    const res = await client.generateText(ARGS, { streamed: true });

    expect(res.text).toBe('from generate');
    expect(currentModel.doStreamCalls).toHaveLength(0);
  });
});
