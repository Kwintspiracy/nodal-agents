// provider-call-deadline.test.ts — one authority on time for every provider
// call (#608)
//
// undici's own 300 s timeouts are off on the provider transport, so that they
// never cut a model the turn clocks allow 600 s of thinking. A call that brings
// no deadline of its own (an embedding written during a turn, a key test, a
// speech or image request) would then have none at all: a provider that
// accepts the connection and never answers would hang it for ever. The
// transport gives such a call a bounded default deadline, and never applies it
// to a call that brings its own.
//
// The default is shortened here through its documented override,
// NODAL_PROVIDER_CALL_TIMEOUT_MS, read when the transport is created.

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

const previous = vi.hoisted(() => {
  const value = process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'];
  process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'] = '400';
  return value;
});

import { createEmbeddingClient } from '../embeddings';
import { createLlmClient } from '../client';

afterAll(() => {
  if (previous === undefined) delete process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'];
  else process.env['NODAL_PROVIDER_CALL_TIMEOUT_MS'] = previous;
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** Accepts the request and never sends a header. */
const neverAnswers: http.RequestListener = () => {};

/** Thinks for 1.2 s in silence, then answers: past the default, well within the call's own clocks. */
const answersAfterThinking: http.RequestListener = (req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const streamed = (JSON.parse(raw || '{}') as { stream?: boolean }).stream === true;
    setTimeout(() => {
      if (!streamed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'thought' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: 'thought' }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    }, 1_200);
  });
};

describe('provider call deadline (#608) @cap:se-souvenir/moteur', () => {
  it('an embedding the provider never answers fails in bounded time, and says why', async () => {
    const baseURL = await serve(neverAnswers);
    const started = Date.now();

    const err = await createEmbeddingClient({ provider: 'openai', baseURL, apiKey: 'k' })
      .embed('remember this')
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(Date.now() - started).toBeLessThan(5_000);
    // The SDK wraps it; the transport's own words are in the chain.
    let messages = '';
    for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      messages += `${e.name}: ${e.message}\n`;
    }
    expect(messages).toContain(
      `TimeoutError: provider call to ${new URL(baseURL).origin} got no answer within 400 ms (no deadline was given by the caller)`,
    );
  });

  it('a streamed turn keeps its own clocks: thinking past the default is not cut', async () => {
    const baseURL = await serve(answersAfterThinking);
    const client = createLlmClient({ provider: 'openai-compatible', model: 'm', baseURL });

    const res = await client.generateText(
      { messages: [{ role: 'user', content: 'think' }] },
      { streamed: true, firstTokenTimeoutMs: 10_000 },
    );

    expect(res.text).toBe('thought');
  });

  it('a one-shot call keeps its own budget: thinking past the default is not cut', async () => {
    const baseURL = await serve(answersAfterThinking);
    const client = createLlmClient({ provider: 'openai-compatible', model: 'm', baseURL });

    const res = await client.generateText({ messages: [{ role: 'user', content: 'think' }] });

    expect(res.text).toBe('thought');
  });
});
