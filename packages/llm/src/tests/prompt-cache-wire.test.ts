// prompt-cache-wire.test.ts — the prompt-cache breakpoints on the wire, by MODEL (#425)
//
// Anthropic does not cache by itself: a request must carry `cache_control`.
// The client sent it only on the native Anthropic route, so a Claude model
// reached through OpenRouter read nothing from the cache: 0 of 852 calls in
// 30 days. The decision is now the model's (`promptCachingFor`, the catalog's
// `cacheControl`), not the route's.
//
// The proof is the BODY of the HTTP request each REAL provider builder sends:
// only `fetch` is replaced. A test of the annotation function alone would not
// prove that the markers reach the wire, nor where.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '@nodal-agents/shared';

import { createLlmClient } from '../client';
import type { LlmCallObservation } from '../observe';

vi.mock('../transport', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const EPHEMERAL = { type: 'ephemeral' };

let bodies: Array<Record<string, unknown>> = [];

function stubFetch(reply: unknown): void {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const TOOLS = {
  save_memory: { description: 'Save a fact', inputSchema: z.object({ content: z.string() }) },
};

/** A tool loop: the last message is a tool turn carrying TWO results. */
const MESSAGES: ModelMessage[] = [
  { role: 'user', content: 'save two facts' },
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'save_memory', input: { content: 'a' } },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'save_memory', input: { content: 'b' } },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'save_memory',
        output: { type: 'text', value: 'saved a' },
      },
      {
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'save_memory',
        output: { type: 'text', value: 'saved b' },
      },
    ],
  },
];
const SYSTEM = `STABLE RULES${SYSTEM_PROMPT_CACHE_BOUNDARY}VOLATILE CLOCK 10:00`;
const ARGS = { system: SYSTEM, messages: MESSAGES, tools: TOOLS };

function chatCompletion(model: string, usage: Record<string, unknown> = {}) {
  return {
    id: 'gen-1',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30_000, completion_tokens: 20, total_tokens: 30_020, ...usage },
  };
}

type WireMessage = Record<string, unknown> & { role: string; content: unknown };
const wireMessages = (): WireMessage[] => bodies[0]!['messages'] as WireMessage[];
const count = (body: unknown): number =>
  (JSON.stringify(body).match(/cache_control/g) ?? []).length;

describe('prompt-cache breakpoints by model @cap:voir-le-cout/moteur', () => {
  describe('a Claude model through OpenRouter', () => {
    const claude = (extra: { cachingEnabled?: boolean } = {}) =>
      createLlmClient({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        apiKey: 'k',
        ...extra,
      });

    it('carries the system breakpoint on the stable prefix only; the volatile tail is not cached', async () => {
      stubFetch(chatCompletion('anthropic/claude-sonnet-5.5'));
      await claude().generateText(ARGS);

      const [stable, volatile] = wireMessages();
      expect(stable).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'STABLE RULES', cache_control: EPHEMERAL }],
      });
      expect(volatile).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'VOLATILE CLOCK 10:00' }],
      });
    });

    it('puts the sliding breakpoint INSIDE the last content part, once, never at the top level of a tool message', async () => {
      stubFetch(chatCompletion('anthropic/claude-sonnet-5.5'));
      await claude().generateText(ARGS);

      const msgs = wireMessages();
      const tools = msgs.filter((m) => m.role === 'tool');
      expect(tools).toHaveLength(2);
      // The first result of the turn carries nothing: Anthropic takes four
      // breakpoints in all, one marker per tool result would exceed them.
      expect(tools[0]).toEqual({
        role: 'tool',
        tool_call_id: 'c1',
        name: 'save_memory',
        content: 'saved a',
      });
      expect(tools[1]).toEqual({
        role: 'tool',
        tool_call_id: 'c2',
        name: 'save_memory',
        content: [{ type: 'text', text: 'saved b', cache_control: EPHEMERAL }],
      });
      // No message carries the marker at its top level (OpenRouter hangs on it).
      for (const m of msgs) expect(m, JSON.stringify(m)).not.toHaveProperty('cache_control');
      expect(count(bodies[0])).toBe(2);
    });

    it('a last message that is a plain user message carries the breakpoint on its text part', async () => {
      stubFetch(chatCompletion('anthropic/claude-sonnet-5.5'));
      await claude().generateText({
        system: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
      });

      const msgs = wireMessages();
      expect(msgs[1]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'hello', cache_control: EPHEMERAL }],
      });
      expect(count(bodies[0])).toBe(2);
    });

    it('cachingEnabled === false sends no breakpoint, and no boundary marker either', async () => {
      stubFetch(chatCompletion('anthropic/claude-sonnet-5.5'));
      await claude({ cachingEnabled: false }).generateText(ARGS);

      expect(count(bodies[0])).toBe(0);
      expect(JSON.stringify(bodies[0])).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      expect(wireMessages()[0]).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'STABLE RULES\n\nVOLATILE CLOCK 10:00' }],
      });
    });
  });

  describe('a model that does not take the marker', () => {
    // GLM, MiMo, DeepSeek cache by themselves; an uncatalogued id is unknown.
    for (const model of [
      'z-ai/glm-5.2',
      'xiaomi/mimo-v2.6-pro',
      'deepseek/deepseek-v3.2',
      'openai/gpt-5.6-luna',
      'anthropic/claude-not-in-the-catalog-9', // unknown model: no guess from its name
    ]) {
      it(`${model} through OpenRouter: no cache_control anywhere in the body`, async () => {
        stubFetch(chatCompletion(model));
        await createLlmClient({ provider: 'openrouter', model, apiKey: 'k' }).generateText(ARGS);

        expect(count(bodies[0])).toBe(0);
        expect(JSON.stringify(bodies[0])).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
      });
    }
  });

  describe('native Anthropic is unchanged', () => {
    const anthropicReply = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    };

    it('keeps its breakpoints for a catalogued model and for a model id the catalog does not know', async () => {
      for (const model of ['claude-sonnet-5', 'claude-a-future-model-9']) {
        stubFetch(anthropicReply);
        await createLlmClient({ provider: 'anthropic', model, apiKey: 'k' }).generateText(ARGS);

        const system = bodies[0]!['system'] as Array<Record<string, unknown>>;
        expect(system[0], model).toMatchObject({ text: 'STABLE RULES', cache_control: EPHEMERAL });
        expect(system[1], model).not.toHaveProperty('cache_control');
        expect(count(bodies[0]), model).toBe(2);
      }
    });

    it('cachingEnabled === false still opts out', async () => {
      stubFetch(anthropicReply);
      await createLlmClient({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'k',
        cachingEnabled: false,
      }).generateText(ARGS);

      expect(count(bodies[0])).toBe(0);
    });
  });

  describe('the cache read is read back from an OpenRouter reply', () => {
    it('prompt_tokens_details.cached_tokens becomes usage.cachedInputTokens, observed as cachedTokens', async () => {
      stubFetch(
        chatCompletion('anthropic/claude-sonnet-5.5', {
          prompt_tokens_details: { cached_tokens: 28_000, cache_write_tokens: 0 },
        }),
      );
      const seen: LlmCallObservation[] = [];
      const client = createLlmClient(
        { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', apiKey: 'k' },
        { onCall: (obs) => seen.push(obs) },
      );

      const res = await client.generateText(ARGS);

      expect(res.usage.cachedInputTokens).toBe(28_000);
      expect(res.usage.inputTokens).toBe(30_000);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.usage?.cachedTokens).toBe(28_000);
    });
  });
});
