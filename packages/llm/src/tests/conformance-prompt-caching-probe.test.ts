// conformance-prompt-caching-probe.test.ts — the prompt-caching probe sends what the runner sends (#425)
//
// The probe measures whether a model reads its cache on a repeated prefix. It
// sent a bare `prompt`, which the caching layer cannot annotate (no message to
// hang a breakpoint on), so its requests carried no `cache_control`. Once the
// matrix declares `promptCaching: true` for a Claude model on OpenRouter, a
// probe that sends no marker reports "declared, nothing cached" on every run:
// a false contradiction. The probe must make the call the runner makes, a
// `messages` call. Proof: the BODY it sends, through the fetch seam.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { createLlmClient } from '../client';
import { capabilitiesFor } from '../providers/registry';
import { promptCaching } from '../conformance/probes';
import type { ProviderConfig } from '../types';

vi.mock('../transport', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let bodies: Array<Record<string, unknown>> = [];

/** Answers every call; the SECOND one reports cached input tokens. */
function stubFetch(reply: (n: number) => unknown): void {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify(reply(bodies.length)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const markers = (body: unknown): number =>
  (JSON.stringify(body).match(/cache_control/g) ?? []).length;

const openrouterReply = (n: number) => ({
  id: 'gen-1',
  model: 'anthropic/claude-sonnet-5.5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'A' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 2_000,
    completion_tokens: 1,
    total_tokens: 2_001,
    prompt_tokens_details: { cached_tokens: n > 1 ? 1_900 : 0 },
  },
});

const anthropicReply = (n: number) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'A' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: n > 1 ? 1_900 : 0 },
});

describe('the prompt-caching probe carries the cache markers @cap:voir-le-cout/moteur', () => {
  const cases: Array<{ name: string; config: ProviderConfig; reply: (n: number) => unknown }> = [
    {
      name: 'OpenRouter Claude',
      config: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', apiKey: 'k' },
      reply: openrouterReply,
    },
    {
      name: 'native Anthropic',
      config: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' },
      reply: anthropicReply,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: both requests of the probe carry cache_control, and the verdict is pass`, async () => {
      stubFetch(c.reply);
      const client = createLlmClient(c.config);

      const result = await promptCaching.run({
        client,
        declared: capabilitiesFor(c.config.provider, c.config.model),
      });

      expect(bodies).toHaveLength(2);
      for (const b of bodies)
        expect(markers(b), JSON.stringify(b).slice(0, 200)).toBeGreaterThan(0);
      expect(result.status).toBe('pass');
    });
  }

  it('a model that reports no cache read is still a fail when the matrix promises it: the verdict is not softened', async () => {
    stubFetch((n) => {
      const r = openrouterReply(n) as { usage: Record<string, unknown> };
      r.usage['prompt_tokens_details'] = { cached_tokens: 0 };
      return r;
    });
    const config: ProviderConfig = {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5.5',
      apiKey: 'k',
    };

    const result = await promptCaching.run({
      client: createLlmClient(config),
      declared: capabilitiesFor(config.provider, config.model),
    });

    expect(markers(bodies[0])).toBeGreaterThan(0);
    expect(result.status).toBe('fail');
  });
});
