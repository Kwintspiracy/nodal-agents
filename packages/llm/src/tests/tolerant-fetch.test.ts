// tolerant-fetch.test.ts — regression coverage for the openai-compatible
// response normaliser. The live-caught failure pattern: DeepSeek V4 Pro on
// OpenRouter returns `choices[i].message.tool_calls[i].function.arguments`
// as an already-parsed object, AI SDK's strict-string schema rejects it,
// the job dies with "Invalid JSON response" → Retry exhausted.

import { describe, it, expect, vi } from 'vitest';
import { createTolerantFetch, normaliseChatResponseBody } from '../providers/tolerant-fetch';

// ─── normaliseChatResponseBody — pure transform ───────────────────────────────

describe('normaliseChatResponseBody', () => {
  it('coerces tool_call.function.arguments from object → JSON string', () => {
    const input = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'file_write', arguments: { path: 'x.md', content: 'hi' } },
              },
            ],
          },
        },
      ],
    });
    const out = normaliseChatResponseBody(input);
    const parsed = JSON.parse(out);
    const args = parsed.choices[0].message.tool_calls[0].function.arguments;
    expect(typeof args).toBe('string');
    expect(JSON.parse(args)).toEqual({ path: 'x.md', content: 'hi' });
  });

  it('coerces null arguments to empty-object JSON string', () => {
    const input = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: 'noop', arguments: null } }],
          },
        },
      ],
    });
    const out = normaliseChatResponseBody(input);
    const args = JSON.parse(out).choices[0].message.tool_calls[0].function.arguments;
    expect(args).toBe('{}');
  });

  it('coerces missing arguments to empty-object JSON string', () => {
    const input = JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'noop' } }] } }],
    });
    const out = normaliseChatResponseBody(input);
    const args = JSON.parse(out).choices[0].message.tool_calls[0].function.arguments;
    expect(args).toBe('{}');
  });

  it('coerces numeric arguments to string', () => {
    const input = JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'noop', arguments: 42 } }] } }],
    });
    const out = normaliseChatResponseBody(input);
    const args = JSON.parse(out).choices[0].message.tool_calls[0].function.arguments;
    expect(args).toBe('42');
  });

  it('passes a spec-compliant response through byte-identical (no allocation)', () => {
    const input = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'call_1', function: { name: 'x', arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    const out = normaliseChatResponseBody(input);
    expect(out).toBe(input);
  });

  it('passes non-tool responses through unchanged', () => {
    const input = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'just a text answer' } }],
    });
    expect(normaliseChatResponseBody(input)).toBe(input);
  });

  it('passes non-JSON bodies through unchanged (provider error HTML, etc.)', () => {
    const bad = '<html><body>503 backend error</body></html>';
    expect(normaliseChatResponseBody(bad)).toBe(bad);
  });

  it('passes JSON without choices unchanged (embeddings response shape, etc.)', () => {
    const input = JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] });
    expect(normaliseChatResponseBody(input)).toBe(input);
  });

  it('does not strip provider extras (reasoning_content, reasoning_details, …)', () => {
    // These extras are FINE under the schema (it uses looseObject at the top
    // level and z.object().strips by default everywhere else). Verify the
    // normaliser is conservative — it touches only what it must.
    const input = JSON.stringify({
      choices: [
        {
          message: {
            content: 'thought through it',
            reasoning_content: 'long chain of reasoning here',
            reasoning_details: { steps: 5 },
            tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{}' } }],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    const out = normaliseChatResponseBody(input);
    expect(out).toBe(input);
  });

  it('handles multiple choices and multiple tool_calls per choice', () => {
    const input = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'a', arguments: { x: 1 } } },
              { function: { name: 'b', arguments: '{"y":2}' } }, // already string, leave alone
            ],
          },
        },
        {
          message: {
            tool_calls: [{ function: { name: 'c', arguments: { z: 3 } } }],
          },
        },
      ],
    });
    const parsed = JSON.parse(normaliseChatResponseBody(input));
    expect(typeof parsed.choices[0].message.tool_calls[0].function.arguments).toBe('string');
    expect(parsed.choices[0].message.tool_calls[1].function.arguments).toBe('{"y":2}');
    expect(typeof parsed.choices[1].message.tool_calls[0].function.arguments).toBe('string');
  });
});

// ─── createTolerantFetch — boundary behaviour ─────────────────────────────────

describe('createTolerantFetch', () => {
  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('normalises only /chat/completions JSON responses', async () => {
    const upstream = vi.fn(async (url: string) => {
      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          choices: [
            { message: { tool_calls: [{ function: { name: 'x', arguments: { a: 1 } } }] } },
          ],
        });
      }
      // Embeddings endpoint — passthrough unchanged.
      return jsonResponse({ data: [{ embedding: [0.1] }] });
    });

    const fetch = createTolerantFetch(upstream as unknown as typeof globalThis.fetch);

    const chat = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
    const chatBody = (await chat.json()) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    expect(typeof chatBody.choices[0]?.message.tool_calls[0]?.function.arguments).toBe('string');

    const embeddings = await fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST' });
    const embBody = (await embeddings.json()) as { data: { embedding: number[] }[] };
    expect(embBody.data[0]?.embedding).toEqual([0.1]);
  });

  it('passes streaming (text/event-stream) responses through unchanged', async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const upstream = vi.fn(async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const fetch = createTolerantFetch(upstream as unknown as typeof globalThis.fetch);
    const r = await fetch('https://x.com/chat/completions');
    expect(await r.text()).toBe(sseBody);
  });

  it('passes error responses through (does not swallow upstream failures)', async () => {
    const upstream = vi.fn(async () =>
      jsonResponse({ error: { message: 'rate limited' } }, { status: 429 }),
    );
    const fetch = createTolerantFetch(upstream as unknown as typeof globalThis.fetch);
    const r = await fetch('https://x.com/chat/completions');
    expect(r.status).toBe(429);
    expect((await r.json()) as { error: { message: string } }).toEqual({
      error: { message: 'rate limited' },
    });
  });

  it('preserves status, statusText and headers on the rewritten response', async () => {
    const upstream = vi.fn(async () =>
      jsonResponse(
        {
          choices: [
            { message: { tool_calls: [{ function: { name: 'x', arguments: { a: 1 } } }] } },
          ],
        },
        {
          status: 200,
          statusText: 'OK',
          headers: { 'x-request-id': 'req_abc' },
        },
      ),
    );
    const fetch = createTolerantFetch(upstream as unknown as typeof globalThis.fetch);
    const r = await fetch('https://x.com/chat/completions');
    expect(r.status).toBe(200);
    expect(r.headers.get('x-request-id')).toBe('req_abc');
    expect(r.headers.get('content-type')).toContain('application/json');
  });
});
