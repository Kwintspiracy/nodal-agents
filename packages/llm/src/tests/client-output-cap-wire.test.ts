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
import { LLMOutputLimitError, isContextOverflowError } from '../errors';
import {
  ATTACHMENT_TOKEN_ESTIMATE,
  estimateContextTokens,
  estimateToolTokens,
} from '../turn-clocks';
import { TURN_OUTPUT_TOKEN_CAP } from '@nodal-agents/shared';

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

// Revue Nodal de #571, passe 5 : la borne énumérait les champs qu'elle
// comptait, et chaque passe trouvait un champ oublié (le schéma de sortie,
// l'enum, `toolChoice`, l'enveloppe du fil). Le corps envoyé est la vérité :
// pour CHAQUE requête de ce fichier, la borne que le client a calculée ne
// descend jamais sous les octets réellement envoyés. Un champ ou une
// enveloppe oublié fait rougir n'importe quel test.
const wire = vi.hoisted(() => ({
  lastBound: Number.NaN,
  sent: [] as Array<{ bound: number; bytes: number; body: string }>,
}));

vi.mock('../turn-clocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turn-clocks')>();
  return {
    ...actual,
    inputTokensUpperBound: (args: Parameters<typeof actual.inputTokensUpperBound>[0]) => {
      wire.lastBound = actual.inputTokensUpperBound(args);
      return wire.lastBound;
    },
  };
});

// Every provider call goes through `providerFetch` (#608). Routed to the global
// fetch here, so the stub below is the network boundary and nothing leaves the
// machine. Each request body is recorded with the bound computed for it.
vi.mock('../transport', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      wire.sent.push({
        bound: wire.lastBound,
        bytes: Buffer.byteLength(init.body, 'utf8'),
        body: init.body.slice(0, 200),
      });
    }
    return globalThis.fetch(input, init);
  },
}));

let bodies: Array<Record<string, unknown>> = [];

function stubFetch(reply: () => unknown): void {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // A GET is the SDK downloading an image given by URL, for a provider
      // that takes only bytes: it is not a request to the model.
      if (init?.body === undefined) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify(reply()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  const sent = wire.sent;
  wire.sent = [];
  wire.lastBound = Number.NaN;
  for (const r of sent) {
    expect(r.bound, `bound computed for ${r.body}`).not.toBeNaN();
    expect(r.bound, `bound under the bytes sent: ${r.body}`).toBeGreaterThanOrEqual(r.bytes);
  }
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

// Revue Nodal de #571, passe 2 (P1) : le plafond était TIRÉ de la fenêtre
// (fenêtre − entrée estimée). L'estimation compte chaque pièce jointe à un
// maximum : sur une fenêtre de 16 384 avec deux images, elle annonçait
// ~6 384 quand la vraie place était ~14 000, et un tour ordinaire de 7 000
// jetons, coupé par le serveur à ce plafond, était refusé. Sur main, aucun
// plafond n'est annoncé et ce tour passe. Une estimation ne fixe jamais la
// valeur du plafond : elle décide seulement, dans le sens prudent, si un
// plafond CONNU (celui du catalogue) tient dans la fenêtre. Sinon rien n'est
// annoncé, comme sur main. Le plafond de l'appelant est toujours annoncé.
describe('a known cap is stated only when the estimated input leaves room for it in the window @cap:suivre-execution/moteur', () => {
  const LOCAL = {
    provider: 'openai-compatible' as const,
    model: 'local-model',
    baseURL: 'http://127.0.0.1:1234/v1',
    contextWindow: 8_192,
  };
  // deepseek-chat: catalogued, window 128 000, turn cap 65 536.
  const DEEPSEEK = { provider: 'deepseek' as const, model: 'deepseek-chat', apiKey: 'k' };
  const estimate = async (args: { system?: unknown; messages?: unknown; tools?: unknown }) =>
    estimateContextTokens(args) + (await estimateToolTokens(args.tools));
  function stubSse(): void {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] },
          {
            id: 'c',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );
  }
  const withImages = (n: number) => ({
    ...ARGS,
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'what are these?' },
          ...Array.from({ length: n }, (_v, i) => ({
            type: 'image' as const,
            image: new Uint8Array([137, 80, 78, 71, i % 256]),
            mediaType: 'image/png',
          })),
        ],
      },
    ],
  });

  it('16 384 on the key and two images: no cap drawn from the window, the request goes as on main', async () => {
    stubFetch(() => chatCompletion('tool_calls', 7_000));
    const args = withImages(2);

    const res = await createLlmClient({ ...LOCAL, contextWindow: 16_384 }).generateText(
      args as unknown as typeof ARGS,
    );

    // An ordinary 7 000-token turn comes back with its call.
    expect(res.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('a window on the key alone states no cap: the output limit is not known (the 8 192 finding of 28/09)', async () => {
    stubFetch(() => chatCompletion('stop', 20));

    await createLlmClient(LOCAL).generateText(ARGS);

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('a catalogued model with room for its cap states it, and a turn that reaches it is refused (#563)', async () => {
    stubFetch(() => chatCompletion('tool_calls', 65_536));

    await expect(createLlmClient(DEEPSEEK).generateText(ARGS)).rejects.toBeInstanceOf(
      LLMOutputLimitError,
    );
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);
  });

  it('a catalogued model whose estimated input leaves less than its cap states none, never a lower one', async () => {
    stubFetch(() => chatCompletion('tool_calls', 7_000));
    const big = {
      ...ARGS,
      messages: [{ role: 'user' as const, content: 'x'.repeat(70_000 * 4) }],
    };
    expect(128_000 - (await estimate(big))).toBeLessThan(TURN_OUTPUT_TOKEN_CAP);

    const res = await createLlmClient(DEEPSEEK).generateText(big);

    expect(res.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  // Revue Nodal de #571, passe 3 (P2) : `fits` lisait une estimation MOYENNE
  // (caractères / 4). Le texte dense la dépasse : 100 000 caractères chinois
  // font ~25 000 jetons sur le papier et ~100 000 en vrai. `max_tokens: 65536`
  // partait, et entrée + plafond dépassaient la fenêtre : un serveur strict
  // refuse, là où main n'annonçait rien. La décision lit une BORNE SUPÉRIEURE :
  // les octets UTF-8 (un jeton fait au moins un octet).
  it('100 000 CJK characters on deepseek-chat: no cap, the bound counts their 300 000 bytes', async () => {
    stubFetch(() => chatCompletion('stop', 20));
    const cjk = { ...ARGS, messages: [{ role: 'user' as const, content: '中'.repeat(100_000) }] };
    // The average estimate would have let the cap through.
    expect(128_000 - estimateContextTokens(cjk)).toBeGreaterThan(TURN_OUTPUT_TOKEN_CAP);

    await createLlmClient(DEEPSEEK).generateText(cjk);

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('ASCII: 40 000 characters leave room for the cap, 100 000 do not (bytes = characters)', async () => {
    // 40 000 bytes + framing: 128 000 − ~40 100 ≥ 65 536, the cap is stated.
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({
      ...ARGS,
      messages: [{ role: 'user' as const, content: 'x'.repeat(40_000) }],
    });
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);

    // 100 000 bytes: 128 000 − ~100 100 < 65 536, no cap, as on main (the
    // average estimate, 25 000, would have stated it).
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({
      ...ARGS,
      messages: [{ role: 'user' as const, content: 'x'.repeat(100_000) }],
    });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('a PDF has no per-file ceiling: the bound is infinite and no cap is stated', async () => {
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({
      ...ARGS,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'summarise' },
            {
              type: 'file' as const,
              data: new Uint8Array([37, 80, 68, 70]),
              mediaType: 'application/pdf',
            },
          ],
        },
      ],
    });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('streamText counts its tools in the bound', async () => {
    // 300 tools of ~330 bytes each: ~100 000 bytes of definitions.
    const tools = Object.fromEntries(
      Array.from({ length: 300 }, (_v, i) => [
        `tool_${i}`,
        { description: 'd'.repeat(300), inputSchema: z.object({ q: z.string() }) },
      ]),
    );
    stubSse();

    await createLlmClient(DEEPSEEK).streamText({ prompt: 'go', tools }).text;

    expect(bodies[0]).not.toHaveProperty('max_tokens');
    // Without them, the same prompt states the cap.
    stubSse();
    await createLlmClient(DEEPSEEK).streamText({ prompt: 'go' }).text;
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);
  });

  // Revue Nodal de #571, passe 4 (P2) : 4 784 n'est pas un plafond par image.
  // OpenAI compte les images par blocs de 32×32 : ~7 372 jetons par image sur
  // gpt-5.2, ~12 000 sur gpt-5.4 en `original`. Douze images y étaient bornées
  // à 57 408 quand elles en font ~88 000. Le coût d'une image dépend du
  // fournisseur, du modèle, de la résolution et du détail : aucun plafond
  // universel n'existe, et une image rend la borne infinie, comme un PDF.
  const imageParts = [
    {
      label: 'an image as bytes',
      part: {
        type: 'image' as const,
        image: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png',
      },
    },
    {
      label: 'an image by URL',
      part: { type: 'image' as const, image: new URL('https://example.com/a.png') },
    },
    {
      label: 'an image sent as a file part',
      part: {
        type: 'file' as const,
        data: new Uint8Array([137, 80, 78, 71]),
        mediaType: 'image/png',
      },
    },
  ];
  for (const { label, part } of imageParts) {
    it(`${label}: no image has a universal ceiling, so no cap is stated`, async () => {
      stubFetch(() => chatCompletion('stop', 20));

      await createLlmClient(DEEPSEEK).generateText({
        ...ARGS,
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'what is this?' }, part],
          },
        ],
      } as unknown as typeof ARGS);

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('max_tokens');
    });
  }

  it('one image among text: no cap, while the clocks still count its allowance', async () => {
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText(withImages(1) as unknown as typeof ARGS);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    // The average for the clocks still counts its allowance.
    expect(await estimate(withImages(1))).toBeGreaterThan(ATTACHMENT_TOKEN_ESTIMATE);
  });

  it("the caller's own cap is always stated and judged, whatever the estimate says", async () => {
    const big = {
      ...ARGS,
      messages: [{ role: 'user' as const, content: 'x'.repeat(70_000 * 4) }],
      maxOutputTokens: 512,
    };
    stubFetch(() => chatCompletion('tool_calls', 512));

    await expect(createLlmClient(DEEPSEEK).generateText(big)).rejects.toBeInstanceOf(
      LLMOutputLimitError,
    );
    expect(bodies[0]?.['max_tokens']).toBe(512);

    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(LOCAL).generateText({ ...ARGS, maxOutputTokens: 512 });
    expect(bodies[0]?.['max_tokens']).toBe(512);
  });

  // Revue Nodal de #571, passe 1 (P1) : une ESTIMATION refusait le tour avant
  // tout envoi (`LLMContextWindowError`). Le forfait d'une pièce jointe est un
  // maximum : deux images sur 8 192, dix images rejouées ou sept captures
  // d'outil sur 32k dépassaient la fenêtre sur le papier, et partaient sur
  // main. Une estimation abaisse le plafond, elle ne refuse jamais un envoi :
  // le refus pour dépassement appartient au compte réel du serveur.
  const image = (n: number) => ({
    type: 'image' as const,
    image: new Uint8Array([137, 80, 78, 71, n % 256]),
    mediaType: 'image/png',
  });
  const screenshot = (n: number) => [
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool-call' as const, toolCallId: `c${n}`, toolName: 'save_memory', input: {} },
      ],
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: `c${n}`,
          toolName: 'save_memory',
          output: {
            type: 'content' as const,
            value: [{ type: 'image-data' as const, data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
          },
        },
      ],
    },
  ];
  const scenarios = [
    {
      label: 'two images on a key window of 8 192',
      window: 8_192,
      messages: [{ role: 'user' as const, content: [image(1), image(2)] }],
    },
    {
      label: 'a conversation replaying ten images on 32k',
      window: 32_768,
      messages: Array.from({ length: 10 }, (_v, i) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `photo ${i}` }, image(i)],
      })),
    },
    {
      label: 'seven tool screenshots on 32k',
      window: 32_768,
      messages: [
        { role: 'user' as const, content: 'browse' },
        ...Array.from({ length: 7 }, (_v, i) => screenshot(i)).flat(),
      ],
    },
  ];
  for (const sc of scenarios) {
    it(`${sc.label}: over the window on paper, the request still goes, with no cap drawn from the estimate`, async () => {
      stubFetch(() => chatCompletion('stop', 20));
      const args = { ...ARGS, messages: sc.messages };
      expect(await estimate(args)).toBeGreaterThan(sc.window);

      const res = await createLlmClient({ ...LOCAL, contextWindow: sc.window }).generateText(
        args as unknown as typeof ARGS,
      );

      expect(res.text).toBe('Je relance la recherche');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty('max_tokens');
    });
  }

  it("the server's own refusal of the window is still a context overflow", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message:
                  "This model's maximum context length is 8192 tokens. However, your messages resulted in 9500 tokens.",
                type: 'invalid_request_error',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const err = await createLlmClient(LOCAL)
      .generateText(ARGS)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).not.toBeNull();
    expect(isContextOverflowError(err)).toBe(true);
  });

  it('native Anthropic beyond its window on paper: the request goes with the SDK default cap', async () => {
    stubFetch(() => anthropicMessage('claude-opus-5', 'end_turn', 20));
    const many = {
      ...ARGS,
      messages: [
        { role: 'user' as const, content: Array.from({ length: 220 }, (_v, i) => image(i)) },
      ],
    };

    await createLlmClient({ provider: 'anthropic', model: 'claude-opus-5', apiKey: 'k' })
      .generateText(many as unknown as typeof ARGS)
      .catch(() => null);

    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]?.['max_tokens']).toBe('number');
    expect(bodies[0]?.['max_tokens']).not.toBe(TURN_OUTPUT_TOKEN_CAP);
  });
});

// Revue Nodal de #571 (28/09, P2) : un modèle dont rien ne dit les limites
// recevait `max_tokens: 65536`, une limite inventée. Un serveur local strict à
// petite fenêtre, ou un fournisseur qui valide `max_tokens` contre la vraie
// sortie maximale du modèle, refusait le tour. Sans limite connue, la requête
// n'énonce aucun plafond, comme avant #563.
describe('a model whose limits are unknown is asked for no invented cap @cap:suivre-execution/moteur', () => {
  const UNKNOWN = {
    provider: 'openai-compatible' as const,
    model: 'local-model',
    baseURL: 'http://127.0.0.1:1234/v1',
  };

  it('outside the catalog, no window on the key: no max_tokens on the wire', async () => {
    stubFetch(() => chatCompletion('stop', 20));

    await createLlmClient(UNKNOWN).generateText(ARGS);

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('native Anthropic outside the catalog: the SDK default, as before #563', async () => {
    stubFetch(() => anthropicMessage('claude-3-opus-20240229', 'tool_use', 1_200));

    await createLlmClient({
      provider: 'anthropic',
      model: 'claude-3-opus-20240229',
      apiKey: 'k',
    }).generateText(ARGS);

    expect(bodies[0]?.['max_tokens']).toBe(4_096);
  });

  it("without a stated cap, a long reply is a turn like any other; 'length' still refuses it", async () => {
    stubFetch(() => chatCompletion('tool_calls', 70_000));
    const res = await createLlmClient(UNKNOWN).generateText(ARGS);
    expect(res.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);

    stubFetch(() => chatCompletion('length', 900));
    await expect(createLlmClient(UNKNOWN).generateText(ARGS)).rejects.toBeInstanceOf(
      LLMOutputLimitError,
    );
  });

  it("a caller's own cap is stated, and judged", async () => {
    stubFetch(() => chatCompletion('tool_calls', 512));

    await expect(
      createLlmClient(UNKNOWN).generateText({ ...ARGS, maxOutputTokens: 512 }),
    ).rejects.toBeInstanceOf(LLMOutputLimitError);
    expect(bodies[0]?.['max_tokens']).toBe(512);
  });

  it('streamText and generateObject state none either', async () => {
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(UNKNOWN)
      .generateObject({
        output: 'object',
        schema: z.object({ content: z.string() }),
        prompt: 'go',
      } as Parameters<ReturnType<typeof createLlmClient>['generateObject']>[0])
      .catch(() => null);

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });
});

// Rebase de #571 sur main (13/10) : generateText énonçait le plafond, mais
// streamText et generateObject partaient sans, chacun sur le défaut du
// fournisseur. Le client énonce le même plafond sur ses trois chemins.
describe('every request of the client states its output cap @cap:suivre-execution/moteur', () => {
  const mimo = () =>
    createLlmClient({ provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', apiKey: 'k' });
  const DEEPSEEK = { provider: 'deepseek' as const, model: 'deepseek-chat', apiKey: 'k' };
  const CITY = z.object({ city: z.string(), celsius: z.number() });
  const objectReply = () => ({
    id: 'gen-1',
    model: 'xiaomi/mimo-v2.6-pro',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '{"city":"Lyon","celsius":21}' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
  });

  function stubStream(): void {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: '1 2 3' } }] },
          {
            id: 'c',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );
  }

  it('generateObject states the platform cap', async () => {
    stubFetch(objectReply);

    const res = await mimo().generateObject({
      output: 'object',
      schema: CITY,
      prompt: 'Lyon is at 21 degrees.',
    } as Parameters<ReturnType<typeof mimo>['generateObject']>[0]);

    expect(res.object).toEqual({ city: 'Lyon', celsius: 21 });
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);
  });

  // Revue Nodal de #571, passe 4 (P2) : le schéma de sortie de generateObject
  // part dans la requête (response_format, ou un outil forcé) et compte dans
  // l'entrée du serveur. La borne ne le lisait pas.
  it('generateObject counts its output schema in the bound', async () => {
    // ~55 000 bytes of prompt: room for 65 536 alone, not with a 10 000-byte schema.
    const prompt = 'x'.repeat(55_000);
    const BIG = z.object(
      Object.fromEntries(
        Array.from({ length: 50 }, (_v, i) => [`field_${i}`, z.string().describe('d'.repeat(200))]),
      ),
    );
    stubFetch(objectReply);
    await createLlmClient(DEEPSEEK)
      .generateObject({ output: 'object', schema: CITY, prompt } as Parameters<
        ReturnType<typeof createLlmClient>['generateObject']
      >[0])
      .catch(() => null);
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);

    stubFetch(objectReply);
    await createLlmClient(DEEPSEEK)
      .generateObject({ output: 'object', schema: BIG, prompt } as Parameters<
        ReturnType<typeof createLlmClient>['generateObject']
      >[0])
      .catch(() => null);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0]).length).toBeGreaterThan(55_000 + 10_000);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  // Revue Nodal de #571, passe 5 (P2) : `output: 'enum'` partait avec ses
  // valeurs, que la borne ne lisait pas (elle ne comptait que `schema`).
  it("generateObject with output 'enum': its values count in the bound", async () => {
    const prompt = 'x'.repeat(60_000);
    const values = Array.from({ length: 100 }, (_v, i) => `choice_${i}_${'v'.repeat(10)}`);
    stubFetch(() => ({
      ...objectReply(),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"result":"choice_0_vvvvvvvvvv"}' },
          finish_reason: 'stop',
        },
      ],
    }));
    await createLlmClient(DEEPSEEK)
      .generateObject({ output: 'enum', enum: values, prompt } as unknown as Parameters<
        ReturnType<typeof createLlmClient>['generateObject']
      >[0])
      .catch(() => null);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it("generateObject with output 'array': its element schema counts", async () => {
    stubFetch(objectReply);
    await createLlmClient(DEEPSEEK)
      .generateObject({ output: 'array', schema: CITY, prompt: 'cities' } as unknown as Parameters<
        ReturnType<typeof createLlmClient>['generateObject']
      >[0])
      .catch(() => null);
    expect(bodies).toHaveLength(1);
  });

  it('a forced toolChoice and a field the SDK may add tomorrow both count', async () => {
    stubFetch(() => chatCompletion('tool_calls', 20));
    await createLlmClient(DEEPSEEK).generateText({
      ...ARGS,
      toolChoice: { type: 'tool', toolName: 'save_memory' },
    });
    expect(bodies).toHaveLength(1);

    // A field the client does not know: counted, never skipped.
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({
      ...ARGS,
      providerOptions: { deepseek: { note: 'n'.repeat(70_000) } },
    } as typeof ARGS);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('generateObject whose prompt leaves less than the cap in the window states none', async () => {
    stubFetch(objectReply);
    const prompt = 'x'.repeat(70_000 * 4);

    await createLlmClient(DEEPSEEK)
      .generateObject({
        output: 'object',
        schema: CITY,
        prompt,
      } as Parameters<ReturnType<typeof createLlmClient>['generateObject']>[0])
      .catch(() => null);

    expect(128_000 - estimateContextTokens({ prompt })).toBeLessThan(TURN_OUTPUT_TOKEN_CAP);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it("streamText states the platform cap, or the caller's when lower", async () => {
    const stated: unknown[] = [];
    for (const maxOutputTokens of [undefined, 512, 131_072]) {
      stubStream();
      const res = mimo().streamText({
        prompt: 'count',
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
      expect(await res.text).toBe('1 2 3');
      stated.push(bodies[0]?.['max_tokens']);
    }

    expect(stated).toEqual([TURN_OUTPUT_TOKEN_CAP, 512, TURN_OUTPUT_TOKEN_CAP]);
  });

  it('a generateText that sends a prompt, not messages, has it counted against the window', async () => {
    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({ prompt: 'x'.repeat(1_000 * 4) });
    expect(bodies[0]?.['max_tokens']).toBe(TURN_OUTPUT_TOKEN_CAP);

    stubFetch(() => chatCompletion('stop', 20));
    await createLlmClient(DEEPSEEK).generateText({ prompt: 'x'.repeat(70_000 * 4) });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('a streamText prompt beyond the window on paper: the request goes, with no cap drawn from it', async () => {
    stubStream();

    await createLlmClient(DEEPSEEK).streamText({ prompt: 'x'.repeat(130_000 * 4) }).text;

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });
});
