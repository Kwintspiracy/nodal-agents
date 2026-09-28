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
import { LLMOutputLimitError, QuotaExhaustedError } from '../errors';
import { TURN_OUTPUT_TOKEN_CAP } from '@nodal-agents/shared';

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

/** Output tokens of a reply: at the cut of run 04229144 when cut, a normal turn otherwise. */
const outputFor = (reason: Unified): number => (reason === 'length' ? 131_072 : 1_200);

function generated(
  reason: Unified,
  withCalls = true,
  output = outputFor(reason),
): LanguageModelV3GenerateResult {
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
    usage: mockUsage(900, output),
    warnings: [],
  };
}

function streamedParts(reason: Unified, output = outputFor(reason)): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'working' },
    { type: 'text-end', id: 't' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'save_memory', input: '{"content":"x"}' },
    {
      type: 'finish',
      finishReason: { unified: reason, raw: reason },
      usage: mockUsage(900, output),
    },
  ];
}

function useModel(reason: Unified, withCalls = true, output = outputFor(reason)): void {
  currentModel = new MockLanguageModelV3({
    provider: 'openrouter',
    modelId: 'z-ai/glm-5.3',
    doGenerate: async () => generated(reason, withCalls, output),
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: streamedParts(reason, output) }),
    }),
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

// Revue Codex de #555, P1 : une sonde de conformance propose un outil pour
// LIRE l'appel, jamais pour l'exécuter. Refuser la réponse coupée la faisait
// conclure « ne sait pas appeler d'outil » devant un appel bien formé.
describe('a caller that only inspects gets the cut response as is @cap:suivre-execution/moteur', () => {
  it('inspectOnly: one-shot and streamed return the response with its length finish', async () => {
    useModel('length');
    const oneShot = await client().generateText(ARGS, { inspectOnly: true });
    expect(oneShot.finishReason).toBe('length');
    expect((oneShot.toolCalls ?? []).map((c) => c.toolName)).toEqual(['save_memory', 'file_write']);

    const streamed = await client().generateText(ARGS, { streamed: true, inspectOnly: true });
    expect(streamed.finishReason).toBe('length');
    expect((streamed.toolCalls ?? []).map((c) => c.toolName)).toEqual(['save_memory']);
  });

  it('the tool-call probe judges a well-formed call that hit the cap as well formed', async () => {
    const { toolCallSingle } = await import('../conformance/probes');
    currentModel = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.3',
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'w1',
            toolName: 'get_weather',
            input: '{"city":"Lyon"}',
          },
        ],
        finishReason: { unified: 'length', raw: 'length' },
        usage: mockUsage(50, 256),
        warnings: [],
      }),
    });

    const verdict = await toolCallSingle.run({ client: client() } as never);

    expect(verdict.status).toBe('pass');
  });
});

// #563 — the client states an output cap on every request, and a turn whose
// output reaches it is cut whatever finishReason says. Job da91bdbb
// (xiaomi/mimo-v2.6-pro, DeepInfra through OpenRouter): 65 536 output tokens,
// 307 tool calls, no 'length' reported, every call executed.
describe('a turn that reaches the stated output cap is refused, whatever finishReason says @cap:suivre-execution/moteur', () => {
  const CAP = TURN_OUTPUT_TOKEN_CAP;

  it('the request states the cap, one-shot and streamed', async () => {
    await client().generateText(ARGS);
    await client().generateText(ARGS, { streamed: true });

    expect(currentModel.doGenerateCalls[0]?.maxOutputTokens).toBe(CAP);
    expect(currentModel.doStreamCalls[0]?.maxOutputTokens).toBe(CAP);
  });

  it("a caller's own cap is the one stated, and the one judged", async () => {
    useModel('tool-calls', true, 512);

    await expect(client().generateText({ ...ARGS, maxOutputTokens: 512 })).rejects.toBeInstanceOf(
      LLMOutputLimitError,
    );
    expect(currentModel.doGenerateCalls[0]?.maxOutputTokens).toBe(512);
  });

  for (const reason of ['tool-calls', 'stop', 'length'] as const) {
    it(`reaching the cap under finishReason '${reason}' is refused, one-shot and streamed`, async () => {
      useModel(reason, true, CAP);
      const seen: LlmCallObservation[] = [];

      const oneShot = await client(seen)
        .generateText(ARGS)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(oneShot).toBeInstanceOf(LLMOutputLimitError);
      expect((oneShot as LLMOutputLimitError).usage.outputTokens).toBe(CAP);
      expect(seen[0]?.error).toMatch(/^LLMOutputLimitError: /);

      await expect(client().generateText(ARGS, { streamed: true })).rejects.toBeInstanceOf(
        LLMOutputLimitError,
      );
    });
  }

  it('one token under the cap with a normal finish is a turn like any other', async () => {
    useModel('tool-calls', true, CAP - 1);

    const res = await client().generateText(ARGS);

    expect(res.toolCalls.map((c) => c.toolName)).toEqual(['save_memory', 'file_write']);
  });

  it('a model with a lower ceiling is asked for that, and judged on it', async () => {
    currentModel = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'google/gemma-4-31b-it',
      doGenerate: async () => generated('stop', true, 16_384),
    });
    const gemma = createLlmClient({
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it',
      apiKey: 'k',
    });

    await expect(gemma.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
    expect(currentModel.doGenerateCalls[0]?.maxOutputTokens).toBe(16_384);
  });

  it('under failover each link states its own cap and is judged on it', async () => {
    const failing = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.3',
      // Billing refused: failover-worthy and never retried, so the chain moves on at once.
      doGenerate: async () => {
        throw new QuotaExhaustedError('openrouter', 'z-ai/glm-5.3', 'credits exhausted');
      },
    });
    const backup = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'google/gemma-4-31b-it',
      doGenerate: async () => generated('tool-calls', true, 16_384),
    });
    currentModel = failing;
    const primary = createLlmClient(
      { provider: 'openrouter', model: 'z-ai/glm-5.3', apiKey: 'k' },
      { hasFallback: true },
    );
    currentModel = backup;
    const secondary = createLlmClient({
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it',
      apiKey: 'k',
    });
    const chain = createFailoverFromClients([primary, secondary]);

    await expect(chain.generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
    expect(failing.doGenerateCalls[0]?.maxOutputTokens).toBe(CAP);
    expect(backup.doGenerateCalls[0]?.maxOutputTokens).toBe(16_384);
  });
});

// Revue Codex de #571, P1 (a) : un plafond d'appelant AU-DESSUS du plafond
// plateforme était énoncé tel quel. Un appelant qui demandait 131 072
// reproduisait #563 : le fournisseur coupait à 65 536 sans `length`, et le tour
// passait. Le plafond énoncé est le plus bas des deux, jamais celui de
// l'appelant seul.
describe("a caller's cap never raises the platform's @cap:suivre-execution/moteur", () => {
  const CAP = TURN_OUTPUT_TOKEN_CAP;

  it('a caller asking 131 072 states the platform cap, and a reply reaching it is refused', async () => {
    useModel('tool-calls', true, CAP);

    const oneShot = await client()
      .generateText({ ...ARGS, maxOutputTokens: 131_072 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(oneShot).toBeInstanceOf(LLMOutputLimitError);
    expect(currentModel.doGenerateCalls[0]?.maxOutputTokens).toBe(CAP);

    await expect(
      client().generateText({ ...ARGS, maxOutputTokens: 131_072 }, { streamed: true }),
    ).rejects.toBeInstanceOf(LLMOutputLimitError);
    expect(currentModel.doStreamCalls[0]?.maxOutputTokens).toBe(CAP);
  });

  it("a caller above a model's lower ceiling states that ceiling, and is judged on it", async () => {
    currentModel = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'google/gemma-4-31b-it',
      doGenerate: async () => generated('stop', true, 16_384),
    });
    const gemma = createLlmClient({
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it',
      apiKey: 'k',
    });

    await expect(gemma.generateText({ ...ARGS, maxOutputTokens: 20_000 })).rejects.toBeInstanceOf(
      LLMOutputLimitError,
    );
    expect(currentModel.doGenerateCalls[0]?.maxOutputTokens).toBe(16_384);
  });
});

// Revue Codex de #571, P1 (b) : une réponse SANS nombre de jetons de sortie
// (usage absent ou non fini) valait 0, donc « sous le plafond » : un faux vert.
// Aucune autre mesure fiable n'existe dans le client : les caractères reçus ne
// bornent pas les jetons (un jeton peut faire un octet ou des dizaines). Quand
// l'usage manque, le plafond ne se juge donc que sur `finishReason`, et ce fait
// est dit, pas masqué : la ligne llm_calls garde `outputTokens` à null et le
// client l'écrit dans le journal. La barrière indépendante de l'usage est le
// refus d'un tour trop gros en appels (#564).
describe('a turn whose output tokens are not reported @cap:suivre-execution/moteur', () => {
  function useModelWithoutOutputUsage(reason: Unified, output: unknown = undefined): void {
    const usage = {
      inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: output as number | undefined, text: undefined, reasoning: undefined },
    };
    currentModel = new MockLanguageModelV3({
      provider: 'openrouter',
      modelId: 'z-ai/glm-5.3',
      doGenerate: async () => ({ ...generated(reason), usage }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: streamedParts(reason).map((p) => (p.type === 'finish' ? { ...p, usage } : p)),
        }),
      }),
    });
  }

  for (const output of [undefined, Number.NaN] as const) {
    it(`output tokens ${String(output)}: the turn is not read as under the cap, the gap is said and kept null`, async () => {
      useModelWithoutOutputUsage('tool-calls', output);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const seen: LlmCallObservation[] = [];
      try {
        const oneShot = await client(seen).generateText(ARGS);
        const streamed = await client().generateText(ARGS, { streamed: true });

        // Nothing else to judge on: the turn comes back, as the provider sent it.
        expect(oneShot.toolCalls.map((c) => c.toolName)).toEqual(['save_memory', 'file_write']);
        expect(streamed.toolCalls.map((c) => c.toolName)).toEqual(['save_memory']);
        // The llm_calls row says "not reported", never a guessed 0.
        expect(seen[0]?.usage?.outputTokens).toBeNull();
        // And the log says what could not be judged, for whom, against which cap.
        const said = warn.mock.calls.map((c) => c.map(String).join(' '));
        const gap = said.filter((l) => l.includes('output tokens not reported'));
        expect(gap).toHaveLength(2);
        expect(gap[0]).toContain('openrouter/z-ai/glm-5.3');
        expect(gap[0]).toContain(String(TURN_OUTPUT_TOKEN_CAP));
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("without output tokens, a 'length' finish is still refused", async () => {
    useModelWithoutOutputUsage('length');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(client().generateText(ARGS)).rejects.toBeInstanceOf(LLMOutputLimitError);
      await expect(client().generateText(ARGS, { streamed: true })).rejects.toBeInstanceOf(
        LLMOutputLimitError,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a call offering no tools is not a turn: no gap to report', async () => {
    useModelWithoutOutputUsage('stop');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await client().generateText({ system: 's', messages: ARGS.messages });
      const said = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(said.filter((l) => l.includes('output tokens not reported'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
