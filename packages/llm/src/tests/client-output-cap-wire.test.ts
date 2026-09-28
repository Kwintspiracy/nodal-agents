// client-output-cap-wire.test.ts — the output cap on the wire (#563)
//
// Job da91bdbb (xiaomi/mimo-v2.6-pro, served by DeepInfra through OpenRouter)
// stopped at exactly 65 536 output tokens with 307 tool calls: DeepInfra's own
// default, since the runner stated no cap, and OpenRouter did not report
// `finish_reason: "length"`. Every call ran.
//
// Here the REAL provider builders run and only `fetch` is replaced: what is
// read back is the request body each provider sends (`max_tokens`), and what
// the client does with a reply that reaches it. Native Anthropic and MiniMax
// are the two paths whose shims raise `max_tokens` above a thinking budget:
// the cap must reach the wire untouched by them.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';

import { createLlmClient } from '../client';
import { LLMOutputLimitError } from '../errors';

const TOOLS = {
  save_memory: {
    description: 'Save a fact',
    inputSchema: z.object({ content: z.string() }),
  },
};
const ARGS = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'go' }],
  tools: TOOLS,
};

let bodies: Array<Record<string, unknown>> = [];

function stubFetch(reply: () => unknown): void {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify(reply()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An OpenAI-shaped chat completion carrying one tool call. */
function chatCompletion(finishReason: string, completionTokens: number) {
  return {
    id: 'gen-1',
    model: 'xiaomi/mimo-v2.6-pro',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Je relance la recherche',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'save_memory', arguments: '{"content":"x"}' },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 40_109,
      completion_tokens: completionTokens,
      total_tokens: 40_109 + completionTokens,
    },
  };
}

/** An Anthropic Messages reply carrying one tool_use block. */
function anthropicMessage(model: string, stopReason: string, outputTokens: number) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'save_memory', input: { content: 'x' } }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: outputTokens },
  };
}

describe('the output cap reaches the wire, and a reply that reaches it is refused @cap:suivre-execution/moteur', () => {
  describe('OpenRouter (the incident path)', () => {
    const mimo = () =>
      createLlmClient({ provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', apiKey: 'k' });

    for (const finish of ['tool_calls', 'stop', 'length']) {
      it(`65 536 output tokens under finish_reason '${finish}': refused, nothing returned to run`, async () => {
        stubFetch(() => chatCompletion(finish, 65_536));

        const err = await mimo()
          .generateText(ARGS)
          .then(
            () => null,
            (e: unknown) => e,
          );

        expect(bodies[0]?.['max_tokens']).toBe(65_536);
        expect(err).toBeInstanceOf(LLMOutputLimitError);
        expect((err as LLMOutputLimitError).toolCallCount).toBe(1);
      });
    }

    it('a normal reply under the cap is returned with its call', async () => {
      stubFetch(() => chatCompletion('tool_calls', 1_200));

      const res = await mimo().generateText(ARGS);

      expect(bodies[0]?.['max_tokens']).toBe(65_536);
      expect(res.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);
    });

    it('a model with a lower ceiling is asked for its own (gemma: 16 384)', async () => {
      stubFetch(() => chatCompletion('stop', 16_384));
      const gemma = createLlmClient({
        provider: 'openrouter',
        model: 'google/gemma-4-31b-it',
        apiKey: 'k',
      });

      await expect(gemma.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
      expect(bodies[0]?.['max_tokens']).toBe(16_384);
    });
  });

  describe('native Anthropic', () => {
    it('a model this SDK does not know gets the stated cap, not the SDK default of 4 096', async () => {
      stubFetch(() => anthropicMessage('claude-opus-5', 'tool_use', 1_200));
      const opus = createLlmClient({ provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' });

      await opus.generateText(ARGS);

      expect(bodies[0]?.['max_tokens']).toBe(65_536);
    });

    it('with a thinking budget, the cap is sent untouched and judged: 64 000 under tool_use is refused', async () => {
      stubFetch(() => anthropicMessage('claude-haiku-4-5-20251001', 'tool_use', 64_000));
      const haiku = createLlmClient({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: 'k',
        reasoningEffort: 'max',
      });

      await expect(haiku.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
      expect(bodies[0]?.['max_tokens']).toBe(64_000);
      expect(bodies[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 32_000 });
    });
  });

  describe('native MiniMax (Anthropic-compatible, thinking injected)', () => {
    it('the cap is sent untouched above the thinking budget, and a reply that reaches it is refused', async () => {
      stubFetch(() => anthropicMessage('MiniMax-M3', 'end_turn', 65_536));
      const m3 = createLlmClient({ provider: 'minimax', model: 'MiniMax-M3', apiKey: 'k' });

      await expect(m3.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
      expect(bodies[0]?.['max_tokens']).toBe(65_536);
      const thinking = bodies[0]?.['thinking'] as { budget_tokens: number } | undefined;
      expect(thinking?.budget_tokens).toBeLessThan(65_536);
    });
  });
});

// Revue Codex de #571, passe 2 : un tour dont les jetons de sortie ne sont pas
// rapportés est désormais REFUSÉ. `@ai-sdk/openai-compatible` (2.0.47) ne
// demande l'usage en flux (`stream_options.include_usage`) que si on le lui
// dit : sans ça, un serveur fidèle à la spec OpenAI ne l'envoie pas, et chaque
// tour streamé d'un endpoint compatible (LM Studio, vLLM, Moonshot…) serait
// refusé. Les deux builders qui passent par ce SDK le demandent.
describe('streamed turns ask for their usage on OpenAI-compatible endpoints @cap:suivre-execution/moteur', () => {
  function stubSse(): void {
    bodies = [];
    const sse =
      [
        {
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ]
        .map((c) => `data: ${JSON.stringify({ id: 'x', created: 0, model: 'm', ...c })}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );
  }

  for (const config of [
    { provider: 'openai-compatible', model: 'local-model', baseURL: 'http://127.0.0.1:1234/v1' },
    { provider: 'moonshot', model: 'kimi-k3', apiKey: 'k' },
  ] as const) {
    it(`${config.provider}: the request asks for usage, and the turn comes back judged`, async () => {
      stubSse();
      const client = createLlmClient(config);

      const res = await client.generateText(ARGS, { streamed: true });

      expect(bodies[0]?.['stream']).toBe(true);
      expect(bodies[0]?.['stream_options']).toEqual({ include_usage: true });
      expect(res.usage.outputTokens).toBe(2);
    });
  }
});
