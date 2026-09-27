// turn-clocks.test.ts — the two clocks of a streamed turn (#440)
//
// Every stream here is timed by the fake clock: a model that writes one token
// every ten seconds for twenty minutes runs in milliseconds. The streams go
// through the REAL `streamText` of the AI SDK and a mock model, so what is
// proven is what the job loop gets: the generateText-shaped result, or the
// LLMTimeoutError with the text written before the clock fired.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

import {
  computeTurnClocks,
  consumeUnderClocks,
  estimateContextTokens,
  estimateToolTokens,
  isLocalEndpoint,
  BETWEEN_TOKENS_MS,
  FIRST_TOKEN_BASE_MS,
  FIRST_TOKEN_OVER_50K_MS,
  FIRST_TOKEN_OVER_100K_MS,
  ABSOLUTE_CALL_MS,
  INVISIBLE_PRODUCTION_MS,
} from '../turn-clocks';
import type { TurnClocks, CallProgress } from '../turn-clocks';
import { LLMTimeoutError, LLMCallCancelledError, LLMStreamPartError } from '../errors';

// ─── A stream the fake clock drives ───────────────────────────────────────────

type Event = { atMs: number; part: LanguageModelV3StreamPart } | { atMs: number; close: true };

const finish: LanguageModelV3StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  },
};

/** A mock model whose stream emits each event at its time on the fake clock. */
function timedModel(events: Event[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          for (const e of events) {
            setTimeout(() => {
              try {
                if ('close' in e) controller.close();
                else controller.enqueue(e.part);
              } catch {
                // The consumer already cancelled the stream (a clock fired).
              }
            }, e.atMs);
          }
        },
      }),
    }),
  });
}

const text = (atMs: number, delta: string): Event => ({
  atMs,
  part: { type: 'text-delta', id: 't', delta },
});
const reasoning = (atMs: number, delta: string): Event => ({
  atMs,
  part: { type: 'reasoning-delta', id: 'r', delta },
});
const textStart = (atMs: number): Event => ({ atMs, part: { type: 'text-start', id: 't' } });
const textEnd = (atMs: number): Event => ({ atMs, part: { type: 'text-end', id: 't' } });
const end = (atMs: number): Event[] => [
  { atMs, part: finish },
  { atMs, close: true },
];

const CLOUD: TurnClocks = computeTurnClocks({ provider: 'openrouter' }, 1_000);
const PM = { provider: 'openrouter', model: 'mock-model' };

function run(model: MockLanguageModelV3, clocks: TurnClocks = CLOUD) {
  const p = consumeUnderClocks(
    (signal) =>
      streamText({ model, prompt: 'write', abortSignal: signal, maxRetries: 0, onError: () => {} }),
    clocks,
    PM,
  );
  // Settled state readable without awaiting — the fake clock drives the rest.
  const state: { value?: Awaited<typeof p>; error?: unknown; done: boolean } = { done: false };
  p.then(
    (v) => {
      state.value = v;
      state.done = true;
    },
    (e: unknown) => {
      state.error = e;
      state.done = true;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── The clocks ────────────────────────────────────────────────────────────────

describe('streamed turn clocks @cap:organiser-equipe/moteur', () => {
  it('a model writing one token every 10 s for 20 minutes is never cut', async () => {
    const tokens = Array.from({ length: 120 }, (_, i) => text(10_000 * (i + 1), `w${i} `));
    const state = run(timedModel([textStart(0), ...tokens, textEnd(1_200_000), ...end(1_200_000)]));

    await vi.advanceTimersByTimeAsync(1_200_001);

    expect(state.error).toBeUndefined();
    expect(state.done).toBe(true);
    expect(state.value?.text.split(' ').filter(Boolean)).toHaveLength(120);
    expect(state.value?.text.startsWith('w0 w1 w2')).toBe(true);
    expect(state.value?.usage.outputTokens).toBe(5);
  });

  it('a model that writes 30 s then goes silent 70 s expires between tokens, its text kept', async () => {
    const state = run(
      timedModel([
        textStart(1_000),
        text(1_000, 'The note begins. '),
        text(30_000, 'Second sentence.'),
        text(100_000, ' never arrives'),
        ...end(100_000),
      ]),
    );

    await vi.advanceTimersByTimeAsync(30_000 + BETWEEN_TOKENS_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(state.done).toBe(true);
    expect(state.error).toBeInstanceOf(LLMTimeoutError);
    const err = state.error as LLMTimeoutError;
    expect(err.reason).toBe('idle_between_tokens');
    expect(err.partialText).toBe('The note begins. Second sentence.');
    expect(err.timeoutMs).toBe(BETWEEN_TOKENS_MS);
  });

  it('a model silent before its first token expires at the first-token clock, nothing kept', async () => {
    const state = run(
      timedModel([
        textStart(FIRST_TOKEN_BASE_MS + 10_000),
        text(FIRST_TOKEN_BASE_MS + 10_000, 'late'),
        ...end(FIRST_TOKEN_BASE_MS + 20_000),
      ]),
    );

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_BASE_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.reason).toBe('idle_before_first_token');
    expect(err.partialText).toBe('');
  });

  // #583 : des modèles hébergés qui réfléchissent en silence (mimo, glm via
  // OpenRouter) étaient coupés à 120 s, 0 caractère reçu, alors que leurs
  // appels réussis durent jusqu'à 408 s. Deux coupures de suite faisaient
  // échouer le job. Le délai avant le premier jeton d'un modèle hébergé couvre
  // la réflexion silencieuse, à tout effort.
  it('a hosted model silent for 200 s before its first token, at no particular effort, completes', async () => {
    const state = run(
      timedModel([textStart(200_000), text(200_000, 'done'), textEnd(200_000), ...end(200_000)]),
    );

    await vi.advanceTimersByTimeAsync(200_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('done');
  });

  it('silent past the first-token clock of a hosted model: cut, with the same reason', async () => {
    const state = run(timedModel([textStart(310_000), text(310_000, 'late'), ...end(310_000)]));

    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.reason).toBe('idle_before_first_token');
    expect(err.timeoutMs).toBe(300_000);
    expect(err.partialText).toBe('');
  });

  it('on a 120K-token context the same 200 s silence before the first token does not expire', async () => {
    const clocks = computeTurnClocks({ provider: 'openrouter' }, 120_000);
    expect(clocks.firstTokenMs).toBe(FIRST_TOKEN_OVER_100K_MS);
    const state = run(
      timedModel([textStart(200_000), text(200_000, 'done'), textEnd(200_000), ...end(200_000)]),
      clocks,
    );

    await vi.advanceTimersByTimeAsync(200_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('done');
  });

  it('reasoning deltas are activity: 5 minutes of thinking out loud, then text, completes', async () => {
    const thinking = Array.from({ length: 30 }, (_, i) => reasoning(10_000 * (i + 1), 'hmm '));
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
        ...thinking,
        { atMs: 300_000, part: { type: 'reasoning-end', id: 'r' } },
        textStart(305_000),
        text(305_000, 'answer'),
        textEnd(305_000),
        ...end(305_000),
      ]),
    );

    await vi.advanceTimersByTimeAsync(305_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('answer');
    expect(state.value?.reasoningText).toContain('hmm hmm');
  });

  it('a local endpoint has no silence clock: 30 minutes of silence, then the answer', async () => {
    const clocks = computeTurnClocks({ provider: 'ollama' }, 200_000);
    const state = run(
      timedModel([
        textStart(1_800_000),
        text(1_800_000, 'slow but alive'),
        textEnd(1_800_000),
        ...end(1_800_000),
      ]),
      clocks,
    );

    await vi.advanceTimersByTimeAsync(1_800_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('slow but alive');
  });

  it('a local endpoint still stops at the absolute net, its text kept', async () => {
    const clocks = computeTurnClocks({ provider: 'ollama' }, 10);
    const tokens = Array.from({ length: 80 }, (_, i) => text(60_000 * (i + 1), 'x'));
    const state = run(timedModel([textStart(0), ...tokens]), clocks);

    await vi.advanceTimersByTimeAsync(ABSOLUTE_CALL_MS + 1);

    const err = state.error as LLMTimeoutError;
    expect(err.reason).toBe('absolute');
    expect(err.partialText).toBe('x'.repeat(59));
  });

  it('a stream cut AFTER a tool call keeps its text but is not resumable', async () => {
    const state = run(
      timedModel([
        textStart(1_000),
        text(1_000, 'I return my verdict.'),
        textEnd(1_000),
        { atMs: 2_000, part: { type: 'tool-input-start', id: 'c1', toolName: 'return_result' } },
        { atMs: 2_000, part: { type: 'tool-input-delta', id: 'c1', delta: '{"status":' } },
      ]),
    );

    await vi.advanceTimersByTimeAsync(2_000 + BETWEEN_TOKENS_MS + 1);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.partialText).toBe('I return my verdict.');
    expect(err.resumable).toBe(false);
  });

  it('a stream cut after a tool call and NO text was still served: not resumable, not silent', async () => {
    const state = run(
      timedModel([
        { atMs: 1_000, part: { type: 'tool-input-start', id: 'c1', toolName: 'return_result' } },
        { atMs: 1_000, part: { type: 'tool-input-delta', id: 'c1', delta: '{"status":' } },
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_000 + BETWEEN_TOKENS_MS + 1);

    const err = state.error as LLMTimeoutError;
    expect(err.partialText).toBe('');
    expect(err.resumable).toBe(false);
    expect(err.served).toBe(true);
  });

  it('counts every generated character — reasoning and tool arguments — not only the text', async () => {
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
        reasoning(1_000, 'r'.repeat(300)),
        { atMs: 1_000, part: { type: 'reasoning-end', id: 'r' } },
        textStart(1_000),
        text(1_000, 'hi'),
        { atMs: 2_000, part: { type: 'tool-input-start', id: 'c1', toolName: 'save_memory' } },
        { atMs: 2_000, part: { type: 'tool-input-delta', id: 'c1', delta: 'x'.repeat(50) } },
      ]),
    );

    await vi.advanceTimersByTimeAsync(2_000 + BETWEEN_TOKENS_MS + 1);

    const err = state.error as LLMTimeoutError;
    expect(err.partialText).toBe('hi');
    expect(err.generatedChars).toBe(300 + 2 + 50);
  });

  it('a text-start with no token after it is framing: first-token clock, not served', async () => {
    const state = run(timedModel([textStart(1_000)]));

    // Past the between-tokens clock (61 s): still waiting for the first token.
    await vi.advanceTimersByTimeAsync(1_000 + BETWEEN_TOKENS_MS + 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_BASE_MS);

    const err = state.error as LLMTimeoutError;
    expect(err.reason).toBe('idle_before_first_token');
    expect(err.served).toBe(false);
  });

  it('a stream silent from the start was not served', async () => {
    const state = run(timedModel([]));

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_BASE_MS + 1);

    expect((state.error as LLMTimeoutError).served).toBe(false);
  });

  it('a stream cut in plain text is resumable', async () => {
    const state = run(timedModel([textStart(1_000), text(1_000, 'half a note')]));

    await vi.advanceTimersByTimeAsync(1_000 + BETWEEN_TOKENS_MS + 1);

    expect((state.error as LLMTimeoutError).resumable).toBe(true);
  });

  it('Stop ends a stream that is still writing, at once, with what it wrote', async () => {
    const stop = new AbortController();
    const tokens = Array.from({ length: 360 }, (_, i) => text(10_000 * (i + 1), 'w '));
    const model = timedModel([textStart(0), ...tokens]);
    const p = consumeUnderClocks(
      (signal) =>
        streamText({
          model,
          prompt: 'write',
          abortSignal: signal,
          maxRetries: 0,
          onError: () => {},
        }),
      CLOUD,
      PM,
      stop.signal,
    );
    const state: { error?: unknown; done: boolean } = { done: false };
    p.then(
      () => (state.done = true),
      (e: unknown) => {
        state.error = e;
        state.done = true;
      },
    );

    await vi.advanceTimersByTimeAsync(95_000);
    expect(state.done).toBe(false);
    stop.abort();
    await vi.advanceTimersByTimeAsync(1);

    expect(state.done).toBe(true);
    expect(state.error).toBeInstanceOf(LLMCallCancelledError);
    expect((state.error as LLMCallCancelledError).partialText).toBe('w '.repeat(9));
  });

  // #478: OpenRouter forwards an upstream failure mid-stream as a PLAIN OBJECT.
  // Thrown as is, it was logged "[object Object]", never retried, and the job
  // failed as unknown_error (jobs c71d90f1 and 0afde65b, 24/09).
  it('a stream error that is a plain object becomes an Error that keeps its message and code', async () => {
    const payload = { error: { code: 502, message: 'Provider returned error' } };
    const state = run(timedModel([{ atMs: 2_000, part: { type: 'error', error: payload } }]));

    await vi.advanceTimersByTimeAsync(2_001);

    const err = state.error as LLMStreamPartError;
    expect(err).toBeInstanceOf(LLMStreamPartError);
    expect(err.message).toBe('502: Provider returned error');
    expect(err.statusCode).toBe(502);
    expect(err.raw).toBe(payload);
    // Kept for the code that needs it, never written out by a serialiser.
    expect(JSON.stringify(err)).not.toContain('Provider returned error');
  });

  it('a stream error BEFORE any text is thrown as the error it carries', async () => {
    const boom = new Error('upstream 502');
    const state = run(timedModel([{ atMs: 2_000, part: { type: 'error', error: boom } }]));

    await vi.advanceTimersByTimeAsync(2_001);

    expect(state.error).toBe(boom);
  });

  it('a stream that breaks after REASONING only was served: counted, not resumable, not a raw error', async () => {
    const boom = new Error('upstream 502');
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
        reasoning(1_000, 'r'.repeat(400)),
        { atMs: 2_000, part: { type: 'error', error: boom } },
      ]),
    );

    await vi.advanceTimersByTimeAsync(2_001);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.reason).toBe('stream_error');
    expect(err.served).toBe(true);
    expect(err.resumable).toBe(false);
    expect(err.partialText).toBe('');
    expect(err.generatedChars).toBe(400);
  });

  it('a stream that BREAKS after writing keeps its text as a resumable stream_error cut', async () => {
    const boom = new Error('upstream 502');
    const state = run(
      timedModel([
        textStart(1_000),
        text(1_000, 'Half of the '),
        text(1_500, 'note'),
        { atMs: 2_000, part: { type: 'error', error: boom } },
      ]),
    );

    await vi.advanceTimersByTimeAsync(2_001);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.reason).toBe('stream_error');
    expect(err.partialText).toBe('Half of the note');
    expect(err.resumable).toBe(true);
    expect(err.cause).toBe(boom);
    expect(err.message).toContain('upstream 502');
  });
});

// ─── Picking the clocks ────────────────────────────────────────────────────────

describe('computeTurnClocks @cap:organiser-equipe/moteur', () => {
  it('grows the first-token clock with the context, never the between-tokens one', () => {
    const at = (tokens: number) => computeTurnClocks({ provider: 'openrouter' }, tokens);
    expect(at(10_000).firstTokenMs).toBe(FIRST_TOKEN_BASE_MS);
    expect(at(60_000).firstTokenMs).toBe(FIRST_TOKEN_OVER_50K_MS);
    expect(at(150_000).firstTokenMs).toBe(FIRST_TOKEN_OVER_100K_MS);
    expect(new Set([at(10_000), at(60_000), at(150_000)].map((c) => c.betweenTokensMs))).toEqual(
      new Set([BETWEEN_TOKENS_MS]),
    );
  });

  it('a hosted model waits the hidden-thinking floor at every effort, only max raises it (#583)', () => {
    for (const reasoningEffort of [undefined, 'off', 'low', 'medium', 'high'] as const) {
      const c = computeTurnClocks(
        { provider: 'openrouter', ...(reasoningEffort ? { reasoningEffort } : {}) },
        1_000,
      );
      expect(c.firstTokenMs, String(reasoningEffort)).toBe(300_000);
      expect(c.betweenTokensMs).toBe(BETWEEN_TOKENS_MS);
    }
    expect(
      computeTurnClocks({ provider: 'anthropic', reasoningEffort: 'max' }, 1_000).firstTokenMs,
    ).toBe(600_000);
  });

  // #442 : trois niveaux, l'explicite gagne toujours sur l'implicite.
  it('the agent’s value replaces the implicit clock, raises and floors included', () => {
    const agent = { firstTokenTimeoutMs: 600_000 };
    // Plus haut que l'implicite : il gagne.
    expect(computeTurnClocks({ provider: 'openrouter' }, 1_000, agent).firstTokenMs).toBe(600_000);
    // Plus BAS que le relèvement de contexte et que le plancher d'effort : il gagne aussi.
    const court = { firstTokenTimeoutMs: 45_000 };
    expect(computeTurnClocks({ provider: 'openrouter' }, 150_000, court).firstTokenMs).toBe(45_000);
    expect(
      computeTurnClocks({ provider: 'anthropic', reasoningEffort: 'max' }, 1_000, court)
        .firstTokenMs,
    ).toBe(45_000);
    // Posé sur un modèle local, il s'applique : c'est le propriétaire qui l'a voulu.
    expect(computeTurnClocks({ provider: 'ollama' }, 1_000, court).firstTokenMs).toBe(45_000);
    // Le silence entre deux jetons ne bouge jamais.
    expect(computeTurnClocks({ provider: 'openrouter' }, 1_000, agent).betweenTokensMs).toBe(
      BETWEEN_TOKENS_MS,
    );
  });

  it('the run budget caps an IMPLICIT clock at half of what remains, never below 60 s', () => {
    // Reste 10 min : l'implicite de 300 s tient déjà sous la moitié (300 s).
    expect(
      computeTurnClocks({ provider: 'openrouter' }, 1_000, { remainingRunMs: 600_000 })
        .firstTokenMs,
    ).toBe(FIRST_TOKEN_BASE_MS);
    // Reste 4 min : la moitié, 120 s, sous l'implicite de 300 s.
    expect(
      computeTurnClocks({ provider: 'openrouter' }, 1_000, { remainingRunMs: 240_000 })
        .firstTokenMs,
    ).toBe(120_000);
    // Reste 3 min sur un effort max (600 s) : la moitié, 90 s.
    expect(
      computeTurnClocks({ provider: 'anthropic', reasoningEffort: 'max' }, 1_000, {
        remainingRunMs: 180_000,
      }).firstTokenMs,
    ).toBe(90_000);
    // Reste 20 s : le plancher de 60 s.
    expect(
      computeTurnClocks({ provider: 'openrouter' }, 1_000, { remainingRunMs: 20_000 }).firstTokenMs,
    ).toBe(60_000);
    // Un modèle local, infini sinon, est borné lui aussi.
    expect(
      computeTurnClocks({ provider: 'ollama' }, 1_000, { remainingRunMs: 600_000 }).firstTokenMs,
    ).toBe(300_000);
  });

  it('the run budget never caps the agent’s explicit value', () => {
    expect(
      computeTurnClocks({ provider: 'openrouter' }, 1_000, {
        firstTokenTimeoutMs: 600_000,
        remainingRunMs: 60_000,
      }).firstTokenMs,
    ).toBe(600_000);
  });

  it('knows a local endpoint by its host, never by the provider name alone', () => {
    expect(isLocalEndpoint({ provider: 'ollama' })).toBe(true);
    for (const url of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:8080/v1',
      'http://192.168.1.20:11434/v1',
      'http://10.0.0.5/v1',
      'http://172.20.0.2/v1',
      'http://studio.local:1234/v1',
      'http://[::1]:1234/v1',
    ]) {
      expect(isLocalEndpoint({ provider: 'openai-compatible', baseURL: url }), url).toBe(true);
    }
    for (const url of ['https://openrouter.ai/api/v1', 'https://172.32.0.1/v1', 'not a url']) {
      expect(isLocalEndpoint({ provider: 'openai-compatible', baseURL: url }), url).toBe(false);
    }
    expect(isLocalEndpoint({ provider: 'openrouter' })).toBe(false);
  });

  it('counts the tool schemas: a large whitelist moves a call to a longer first-token clock', async () => {
    const { z } = await import('zod');
    const tools: Record<string, { description: string; inputSchema: unknown }> = {};
    for (let i = 0; i < 200; i++) {
      tools[`mcp__server__tool_${i}`] = {
        description: 'd'.repeat(600),
        inputSchema: z.object({
          query: z.string().describe('q'.repeat(400)),
          limit: z.number().optional(),
        }),
      };
    }
    const toolTokens = await estimateToolTokens(tools);
    // 200 tools × (600 + 400 + schema framing) chars / 4 ≥ 50K tokens.
    expect(toolTokens).toBeGreaterThan(50_000);
    const clocks = computeTurnClocks({ provider: 'openrouter' }, 1_000 + toolTokens);
    expect(clocks.firstTokenMs).toBeGreaterThan(FIRST_TOKEN_BASE_MS);
  });

  it('estimates the context from text, not from image bytes', () => {
    const est = estimateContextTokens({
      system: 'x'.repeat(4_000),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'y'.repeat(4_000) }] },
        { role: 'user', content: [{ type: 'image', image: 'z'.repeat(400_000) }] },
      ],
    });
    expect(est).toBe(2_000);
  });
});

// #484 — job 82ecec67 : vingt et une minutes de production, 12 030 jetons, et
// rien ne disait ce qui s'écrivait — ni texte, ni appel d'outil terminé. Le
// flux dit désormais, pendant qu'il tourne, ce que le modèle produit : son
// raisonnement, les arguments de l'outil qu'il remplit (et lequel), son texte.
describe('what a streamed call is producing, while it produces it (#484)', () => {
  it('reports reasoning, the tool being filled and its argument size before the call ends', async () => {
    const seen: CallProgress[] = [];
    const model = timedModel([
      { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
      reasoning(1_000, 'r'.repeat(300)),
      { atMs: 1_000, part: { type: 'reasoning-end', id: 'r' } },
      { atMs: 2_000, part: { type: 'tool-input-start', id: 'c1', toolName: 'file_write' } },
      { atMs: 2_000, part: { type: 'tool-input-delta', id: 'c1', delta: 'x'.repeat(40) } },
      { atMs: 3_000, part: { type: 'tool-input-delta', id: 'c1', delta: 'y'.repeat(60) } },
    ]);
    void consumeUnderClocks(
      (signal) =>
        streamText({
          model,
          prompt: 'write',
          abortSignal: signal,
          maxRetries: 0,
          onError: () => {},
        }),
      CLOUD,
      PM,
      undefined,
      undefined,
      (p) => seen.push(p),
    ).catch(() => {});

    await vi.advanceTimersByTimeAsync(3_000);

    // Toujours en cours : aucune horloge n'a coupé, et on sait déjà ce qu'il écrit.
    expect(seen.at(-1)).toEqual({
      textChars: 0,
      reasoningChars: 300,
      toolInputChars: 100,
      toolName: 'file_write',
    });
    expect(seen[0]).toEqual({
      textChars: 0,
      reasoningChars: 300,
      toolInputChars: 0,
      toolName: null,
    });
  });
});

// #484, revue Codex — le plafond d'une production INVISIBLE. Chaque delta remet
// l'horloge de silence à zéro : un fournisseur qui envoie un caractère toutes
// les 59 s, ou un modèle qui ne fait que raisonner, tournait jusqu'au filet
// absolu d'une heure. Un texte ou un appel d'outil TERMINÉ relance le compte ;
// un rédacteur lent de TEXTE n'est jamais coupé par lui (test du haut).
describe('the ceiling on production that delivers nothing (#484) @cap:organiser-equipe/moteur', () => {
  it('reasoning only, one delta every 30 s, is cut at the ceiling, not at the hour', async () => {
    const deltas = Array.from({ length: 80 }, (_, i) => reasoning(30_000 * (i + 1), 'hmm '));
    const state = run(
      timedModel([{ atMs: 0, part: { type: 'reasoning-start', id: 'r' } }, ...deltas]),
    );

    await vi.advanceTimersByTimeAsync(INVISIBLE_PRODUCTION_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    const err = state.error as LLMTimeoutError;
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect(err.reason).toBe('invisible_production');
    expect(err.timeoutMs).toBe(INVISIBLE_PRODUCTION_MS);
    expect(err.served).toBe(true);
    expect(err.resumable).toBe(false);
  });

  it('tool arguments trickling one character every 59 s are cut at the ceiling', async () => {
    const deltas = Array.from({ length: 70 }, (_, i) => ({
      atMs: 59_000 * (i + 1),
      part: { type: 'tool-input-delta' as const, id: 'c1', delta: 'x' },
    }));
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'tool-input-start', id: 'c1', toolName: 'file_write' } },
        ...deltas,
      ]),
    );

    await vi.advanceTimersByTimeAsync(INVISIBLE_PRODUCTION_MS + 1);

    const err = state.error as LLMTimeoutError;
    expect(err.reason).toBe('invisible_production');
    expect(err.generatedChars).toBe(Math.floor(INVISIBLE_PRODUCTION_MS / 59_000));
  });

  it('text resets it: 15 minutes of reasoning, text, 15 more of reasoning, then the answer completes', async () => {
    const avant = Array.from({ length: 30 }, (_, i) => reasoning(30_000 * (i + 1), 'a '));
    const apres = Array.from({ length: 30 }, (_, i) => reasoning(900_000 + 30_000 * (i + 1), 'b '));
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
        ...avant,
        textStart(900_000),
        text(900_000, 'Plan: '),
        ...apres,
        text(1_800_000, 'done.'),
        textEnd(1_800_000),
        ...end(1_800_000),
      ]),
    );

    await vi.advanceTimersByTimeAsync(1_800_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('Plan: done.');
  });

  it('a local endpoint has no such ceiling: 25 minutes of reasoning, then the answer', async () => {
    const clocks = computeTurnClocks({ provider: 'ollama' }, 10);
    expect(clocks.invisibleProductionMs).toBe(Infinity);
    const deltas = Array.from({ length: 50 }, (_, i) => reasoning(30_000 * (i + 1), 'r '));
    const state = run(
      timedModel([
        { atMs: 0, part: { type: 'reasoning-start', id: 'r' } },
        ...deltas,
        textStart(1_500_000),
        text(1_500_000, 'ok'),
        textEnd(1_500_000),
        ...end(1_500_000),
      ]),
      clocks,
    );

    await vi.advanceTimersByTimeAsync(1_500_001);

    expect(state.error).toBeUndefined();
    expect(state.value?.text).toBe('ok');
  });

  it('the tool being filled is forgotten once its arguments end (progress)', async () => {
    const seen: CallProgress[] = [];
    const model = timedModel([
      { atMs: 1_000, part: { type: 'tool-input-start', id: 'c1', toolName: 'file_write' } },
      { atMs: 1_000, part: { type: 'tool-input-delta', id: 'c1', delta: '{}' } },
      { atMs: 2_000, part: { type: 'tool-input-end', id: 'c1' } },
      { atMs: 3_000, part: { type: 'reasoning-delta', id: 'r', delta: 'next' } },
    ]);
    void consumeUnderClocks(
      (signal) =>
        streamText({ model, prompt: 'w', abortSignal: signal, maxRetries: 0, onError: () => {} }),
      CLOUD,
      PM,
      undefined,
      undefined,
      (p) => seen.push(p),
    ).catch(() => {});

    await vi.advanceTimersByTimeAsync(3_000);

    expect(seen.some((p) => p.toolName === 'file_write')).toBe(true);
    expect(seen.at(-1)?.toolName).toBeNull();
    expect(seen.at(-1)?.reasoningChars).toBe(4);
  });
});

describe('a FINISHED tool call resets the invisible-production ceiling (#484) @cap:organiser-equipe/moteur', () => {
  it('15 minutes of arguments, the call completes, 15 more of reasoning: not cut', async () => {
    const { z } = await import('zod');
    const { tool } = await import('ai');
    const args = Array.from({ length: 30 }, (_, i) => ({
      atMs: 30_000 * (i + 1),
      part: { type: 'tool-input-delta' as const, id: 'c1', delta: ' ' },
    }));
    const suite = Array.from({ length: 30 }, (_, i) => reasoning(900_000 + 30_000 * (i + 1), 'r'));
    const model = timedModel([
      { atMs: 0, part: { type: 'tool-input-start', id: 'c1', toolName: 'note' } },
      ...args,
      { atMs: 900_000, part: { type: 'tool-input-end', id: 'c1' } },
      {
        atMs: 900_000,
        part: { type: 'tool-call', toolCallId: 'c1', toolName: 'note', input: '{}' },
      },
      { atMs: 900_000, part: { type: 'reasoning-start', id: 'r' } },
      ...suite,
      ...end(1_800_000),
    ]);
    const state: { error?: unknown; done: boolean } = { done: false };
    consumeUnderClocks(
      (signal) =>
        streamText({
          model,
          prompt: 'w',
          tools: { note: tool({ inputSchema: z.object({}) }) },
          abortSignal: signal,
          maxRetries: 0,
          onError: () => {},
          // Le client appelle `streamText` avec ses propres outils ; le type
          // d'un jeu d'outils précis n'est pas celui de `ToolSet`.
        }) as unknown as ReturnType<typeof streamText>,
      CLOUD,
      PM,
    ).then(
      () => (state.done = true),
      (e: unknown) => {
        state.error = e;
        state.done = true;
      },
    );

    await vi.advanceTimersByTimeAsync(1_800_001);

    expect(state.error).toBeUndefined();
    expect(state.done).toBe(true);
  });
});
