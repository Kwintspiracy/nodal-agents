// client-usage-reporting.test.ts — a turn without its output count, provider by provider (#563)
//
// Revue Nodal de #571 (28/09, P2) : un tour dont le fournisseur ne rapporte
// pas les jetons de sortie était refusé PARTOUT. Rien ne prouvait que DeepSeek,
// Groq, Mistral, Google, Ollama… les rapportent sur chaque chemin : chez l'un
// d'eux, chaque tour avec outils devenait rouge. Le refus ne vaut plus que là
// où l'absence est anormale, d'après une source par fournisseur
// (`REPORTS_OUTPUT_USAGE`). Ailleurs le tour passe, et le compte reste inconnu
// (null), jamais 0.
//
// Each case runs the REAL provider builder; only the transport is replaced, so
// the reply is parsed by the provider's own SDK, as in production. The reply
// carries one tool call and no usable output count: absent where the SDK
// tolerates its absence, 0 where its schema requires a number (the value a
// stream starts from when the event carrying the count never came).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';

import { createLlmClient } from '../client';
import { LLMOutputLimitError } from '../errors';
import type { ProviderConfig } from '../types';
import type { LlmCallObservation } from '../observe';

// The bound the client computes for each request never falls below the bytes
// it really sends (Nodal review of #571, pass 5): checked here on eleven
// providers' real builders, as in client-output-cap-wire.test.ts.
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

const ARGS = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'remember x' }],
  tools: {
    save_memory: { description: 'Save a fact', inputSchema: z.object({ content: z.string() }) },
  },
};

let urls: string[] = [];

function stub(body: unknown, sse = false): void {
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      if (sse) {
        const events = (body as unknown[]).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
        return new Response(events + 'data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** An OpenAI chat completion with one tool call; `usage` as given (omitted when undefined). */
function chat(usage?: Record<string, number>) {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'save_memory', arguments: '{"content":"x"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** The same turn, streamed as OpenAI chat chunks; the last chunk carries `usage` when given. */
function chatChunks(usage?: Record<string, number>) {
  return [
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'save_memory', arguments: '{"content":"x"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      ...(usage ? { usage } : {}),
    },
  ];
}

function anthropic(model: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'save_memory', input: { content: 'x' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    // The schema requires a number: 0 on a reply that wrote a call is not a count.
    usage: { input_tokens: 900, output_tokens: 0 },
  };
}

function anthropicEvents(model: string) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_memory', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"content":"x"}' },
    },
    { type: 'content_block_stop', index: 0 },
    // The stream ends without the `message_delta` that carries the output count.
    { type: 'message_stop' },
  ];
}

const mistralChat = (usage: Record<string, number>) => ({
  ...chat(usage),
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call00001', function: { name: 'save_memory', arguments: '{"content":"x"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});

const gemini = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'save_memory', args: { content: 'x' } } }],
      },
      finishReason: 'STOP',
    },
  ],
};

const ollamaChat = {
  model: 'llama-local',
  created_at: '2026-10-13T00:00:00Z',
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'save_memory', arguments: { content: 'x' } } }],
  },
  done: true,
  done_reason: 'stop',
};

const openaiResponse = {
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  model: 'gpt-5',
  status: 'completed',
  error: null,
  incomplete_details: null,
  output: [
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'save_memory',
      arguments: '{"content":"x"}',
      status: 'completed',
    },
  ],
};

type Case = {
  provider: ProviderConfig['provider'];
  config: ProviderConfig;
  reply: unknown;
  sse?: boolean;
  streamed?: boolean;
};

let seen: LlmCallObservation[] = [];

async function run(c: Case): Promise<unknown> {
  stub(c.reply, c.sse === true);
  seen = [];
  return createLlmClient(c.config, { onCall: (o) => seen.push(o) })
    .generateText(ARGS, c.streamed ? { streamed: true } : undefined)
    .then(
      (res) => res,
      (e: unknown) => e,
    );
}

const k = { apiKey: 'k' };

// Where the provider reports the count on every reply of that path, its
// absence is abnormal: the turn is refused, none of its calls returned.
const REFUSED: Array<[string, Case]> = [
  [
    'anthropic, one-shot',
    {
      provider: 'anthropic',
      config: { provider: 'anthropic', model: 'claude-opus-5', ...k },
      reply: anthropic('claude-opus-5'),
    },
  ],
  [
    'anthropic, streamed',
    {
      provider: 'anthropic',
      config: { provider: 'anthropic', model: 'claude-opus-5', ...k },
      reply: anthropicEvents('claude-opus-5'),
      sse: true,
      streamed: true,
    },
  ],
  [
    'openrouter, one-shot',
    {
      provider: 'openrouter',
      config: { provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', ...k },
      // OpenRouter's SDK requires the count: 0 on a reply that wrote a call.
      reply: chat({ prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 }),
    },
  ],
  [
    'openrouter, streamed',
    {
      provider: 'openrouter',
      config: { provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', ...k },
      reply: chatChunks(),
      sse: true,
      streamed: true,
    },
  ],
  [
    'deepseek, streamed',
    {
      provider: 'deepseek',
      config: { provider: 'deepseek', model: 'deepseek-chat', ...k },
      reply: chatChunks(),
      sse: true,
      streamed: true,
    },
  ],
  [
    'mistral, one-shot',
    {
      provider: 'mistral',
      config: { provider: 'mistral', model: 'mistral-large-latest', ...k },
      reply: mistralChat({ prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 }),
    },
  ],
];

// Where an absent count is the provider's normal behaviour, the turn goes on
// and the count stays unknown.
const PASSES: Array<[string, Case]> = [
  [
    'minimax, one-shot',
    {
      provider: 'minimax',
      config: { provider: 'minimax', model: 'MiniMax-M3', ...k },
      reply: anthropic('MiniMax-M3'),
    },
  ],
  [
    'openai, one-shot',
    {
      provider: 'openai',
      config: { provider: 'openai', model: 'gpt-5', ...k },
      reply: openaiResponse,
    },
  ],
  [
    'deepseek, one-shot',
    {
      provider: 'deepseek',
      config: { provider: 'deepseek', model: 'deepseek-chat', ...k },
      reply: chat(),
    },
  ],
  [
    'mistral, streamed',
    {
      provider: 'mistral',
      config: { provider: 'mistral', model: 'mistral-large-latest', ...k },
      reply: chatChunks(),
      sse: true,
      streamed: true,
    },
  ],
  [
    'groq, one-shot',
    {
      provider: 'groq',
      config: { provider: 'groq', model: 'llama-3.3-70b-versatile', ...k },
      reply: chat(),
    },
  ],
  [
    'groq, streamed',
    {
      provider: 'groq',
      config: { provider: 'groq', model: 'llama-3.3-70b-versatile', ...k },
      reply: chatChunks(),
      sse: true,
      streamed: true,
    },
  ],
  [
    'google, one-shot',
    {
      provider: 'google',
      config: { provider: 'google', model: 'gemini-3.5-flash', ...k },
      reply: gemini,
    },
  ],
  [
    'ollama, one-shot',
    {
      provider: 'ollama',
      config: { provider: 'ollama', model: 'llama-local' },
      reply: ollamaChat,
    },
  ],
  [
    'openai-compatible, one-shot',
    {
      provider: 'openai-compatible',
      config: {
        provider: 'openai-compatible',
        model: 'local-model',
        baseURL: 'http://127.0.0.1:1234/v1',
      },
      reply: chat(),
    },
  ],
  [
    'openai-compatible, streamed',
    {
      provider: 'openai-compatible',
      config: {
        provider: 'openai-compatible',
        model: 'local-model',
        baseURL: 'http://127.0.0.1:1234/v1',
      },
      reply: chatChunks(),
      sse: true,
      streamed: true,
    },
  ],
  [
    'moonshot, one-shot',
    {
      provider: 'moonshot',
      config: { provider: 'moonshot', model: 'kimi-k3', ...k },
      reply: chat(),
    },
  ],
];

describe('a turn whose output count is missing is refused only where the provider always reports it @cap:suivre-execution/moteur', () => {
  for (const [label, c] of REFUSED) {
    it(`${label}: refused as output_usage_not_reported, its count null`, async () => {
      const out = await run(c);

      expect(urls.length).toBeGreaterThan(0);
      expect(out).toBeInstanceOf(LLMOutputLimitError);
      const err = out as LLMOutputLimitError;
      expect(err.code).toBe('output_usage_not_reported');
      expect(err.usage.outputTokens).toBeNull();
      expect(err.toolCallCount).toBe(1);
      expect(seen[0]?.usage?.outputTokens).toBeNull();
    });
  }

  for (const [label, c] of PASSES) {
    it(`${label}: the turn comes back with its call, its output count unknown, never 0`, async () => {
      const out = await run(c);

      expect(urls.length).toBeGreaterThan(0);
      expect(out).not.toBeInstanceOf(Error);
      const res = out as Awaited<ReturnType<ReturnType<typeof createLlmClient>['generateText']>>;
      expect(res.toolCalls.map((t) => t.toolName)).toEqual(['save_memory']);
      // The llm_calls row says unknown, whatever the SDK put in its place.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.usage?.outputTokens).toBeNull();
      expect(seen[0]?.error).toBeNull();
    });
  }
});
