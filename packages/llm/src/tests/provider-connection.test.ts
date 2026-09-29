// provider-connection.test.ts — no provider call waits on another's body (#608)
//
// On 2026-09-29 every LLM call of the runner took minutes while the same
// requests sent from another process answered in seconds. Node 26's `fetch`
// negotiates HTTP/2 with the hosted providers, and every call of the process
// then rides ONE connection per origin: a response body nobody reads keeps its
// stream open on it, and the provider holds the connection's other calls
// behind it. The runner makes every call of every job, chat turn and title in
// one process, so one abandoned body stalled all of them.
//
// Two properties, proved here against a LOCAL HTTP/2 provider stand-in (TLS,
// ALPN h2, like the real ones), never against a real provider:
//   1. a provider call never shares a connection with another call, so a body
//      left unread holds its own socket and nothing else;
//   2. every path that abandons a call cancels the response it leaves behind
//      (a stream that breaks, Stop, a turn clock, a probe that stops reading).
//
// Where the stall lives. Measured locally (#608), Node's own HTTP/2 client
// credits the CONNECTION window for a paused stream: four unread 4 MB bodies
// do not hold back a fifth call to a Node http2 server. openrouter.ai
// advertises 100 concurrent streams. So the stall reproduced against it comes
// from how the SERVER treats a connection that carries a stream its client
// does not consume, a behaviour no client controls. The stand-in models
// exactly that and nothing more: it advertises the default stream limit, and
// holds the answer to any new request arriving on a connection where one of
// its responses is stuck (written faster than the client reads it). A call
// that shares no connection with the unread one never meets that hold.

import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { createLlmClient } from '../client';
import { LLMCallCancelledError, LLMTimeoutError } from '../errors';
import { probeContextWindow } from '../probe-context';
import { providerFetch } from '../transport';
import { selfSignedLocalhostCert } from './_tls-fixture';

interface Served {
  path: string;
  prompt: string;
  closed: boolean;
}

let previousTlsSetting: string | undefined;
let tls: { key: string; cert: string };

const MODEL = 'z-ai/glm-5.3';

function sseChunk(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'gen-1',
    model: MODEL,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }],
  })}\n\n`;
}

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages;
  const last = messages?.filter((m) => m.role === 'user').at(-1)?.content;
  if (typeof last === 'string') return last;
  if (Array.isArray(last)) {
    return last.map((p) => (p as { text?: string }).text ?? '').join('');
  }
  return '';
}

/** Per connection (an HTTP/2 session or an HTTP/1.1 socket): responses the client is not reading. */
type Stuck = WeakMap<object, Set<Served>>;

function connectionOf(req: http2.Http2ServerRequest): object {
  return req.httpVersion === '2.0' ? (req.stream.session ?? req.socket) : req.socket;
}

/**
 * What the stand-in does, by the prompt it receives:
 *  - `hold`   streams without end (a long turn, or a body nobody reads);
 *  - `break`  writes a token, then an upstream error part, and stays open,
 *             as OpenRouter forwards a failure mid-stream (#478);
 *  - `mute`   sends its headers and never a token;
 *  - `no-headers` never answers at all: the model still thinking before
 *             the provider sends a single byte;
 *  - `processing` sends its headers, then only SSE comments, the
 *             keep-alive OpenRouter sends while the model thinks;
 *  - anything else is answered at once, streamed or not.
 */
function handle(
  stuck: Stuck,
  onConnection: (stuckHere: Set<Served>) => void,
  served: Served[],
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
): void {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', async () => {
    const conn = connectionOf(req);
    const stuckHere = stuck.get(conn) ?? new Set<Served>();
    stuck.set(conn, stuckHere);
    onConnection(stuckHere);
    // The server-side hold: nothing is answered on a connection while one of
    // its responses is not being read.
    while (stuckHere.size > 0 && !res.closed) await new Promise((r) => setTimeout(r, 20));
    const body = raw === '' ? {} : (JSON.parse(raw) as { stream?: boolean });
    const rec: Served = {
      path: req.url,
      prompt: lastUserText(body),
      closed: false,
    };
    served.push(rec);
    res.on('close', () => {
      rec.closed = true;
      stuckHere.delete(rec);
    });

    if (req.url.startsWith('/api/v0/models')) {
      // A refusal whose body never ends: only the client can release it.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.write('{"error":"no such endpoint"');
      return;
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `answer to ${rec.prompt}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        }),
      );
      return;
    }
    if (rec.prompt === 'no-headers') return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (rec.prompt === 'mute') return;
    if (rec.prompt === 'processing') {
      const keepAlive = setInterval(() => res.write(': OPENROUTER PROCESSING\n\n'), 50);
      res.on('close', () => clearInterval(keepAlive));
      return;
    }
    if (rec.prompt === 'break') {
      res.write(sseChunk('partial '));
      res.write(
        `data: ${JSON.stringify({ error: { message: 'upstream failed', code: 502 } })}\n\n`,
      );
      return;
    }
    if (rec.prompt === 'hold') {
      // Writes as fast as the client takes it. A write the client has not
      // taken 200 ms later means it stopped reading: the response is stuck
      // until it drains or closes. A client that reads never gets there.
      const pad = 'x'.repeat(16 * 1024);
      let blocked = false;
      let unread: ReturnType<typeof setTimeout> | undefined;
      const tick = setInterval(() => {
        if (rec.closed || blocked) return;
        if (!res.write(sseChunk(pad))) {
          blocked = true;
          unread = setTimeout(() => stuckHere.add(rec), 200);
        }
      }, 5);
      res.on('drain', () => {
        blocked = false;
        clearTimeout(unread);
        stuckHere.delete(rec);
      });
      res.on('close', () => {
        clearInterval(tick);
        clearTimeout(unread);
      });
      res.write(sseChunk('holding '));
      return;
    }
    res.write(sseChunk(`answer to ${rec.prompt}`));
    res.write(sseChunk('', 'stop'));
    res.end('data: [DONE]\n\n');
  });
}

interface StandIn {
  baseURL: string;
  served: Served[];
  /** Responses written faster than their client reads them, on any connection. */
  stuckCount: () => number;
  close: () => Promise<void>;
}

const running: StandIn[] = [];

/**
 * One provider stand-in per test, on its own origin: a call one test leaves
 * open can never be what stalls the next test.
 */
async function standIn(): Promise<StandIn> {
  const served: Served[] = [];
  const stuck: Stuck = new WeakMap();
  const everStuck = new Set<Set<Served>>();
  const server = http2.createSecureServer({ ...tls, allowHTTP1: true }, (req, res) =>
    handle(stuck, (set) => everStuck.add(set), served, req, res),
  );
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => sessions.add(s));
  const sockets = new Set<Socket>();
  server.on('secureConnection', (sock) => sockets.add(sock));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const it: StandIn = {
    baseURL: `https://localhost:${port}/api/v1`,
    served,
    stuckCount: () => [...everStuck].reduce((n, set) => n + set.size, 0),
    close: async () => {
      // Held streams would keep close() waiting: the connections go first.
      for (const s of sessions) s.destroy();
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(it);
  return it;
}

beforeAll(() => {
  // The stand-in's certificate is self-signed; this worker trusts it.
  previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  tls = selfSignedLocalhostCert();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

afterAll(() => {
  if (previousTlsSetting === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
});

const clientOf = (p: StandIn) =>
  createLlmClient({ provider: 'openrouter', model: MODEL, apiKey: 'k', baseURL: p.baseURL });

/** The value, or the word `stalled` once `ms` have passed. */
function within<T>(ms: number, p: Promise<T>): Promise<T | 'stalled'> {
  return Promise.race([p, new Promise<'stalled'>((r) => setTimeout(() => r('stalled'), ms))]);
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const servedFor = (p: StandIn, prompt: string): Served | undefined =>
  p.served.find((s) => s.prompt === prompt);

describe('provider connections (#608) @cap:parler-a-un-agent/moteur', () => {
  it('a call completes while another call to the same provider lies unread', async () => {
    const p = await standIn();
    const holder = new AbortController();
    // A response nobody reads, on the transport every provider call takes:
    // what a caller that stops reading leaves behind. (The SDK's own stream
    // API is no such case: it reads its body whether or not anyone consumes it.)
    const unread = await providerFetch(`${p.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hold' }] }),
      signal: holder.signal,
    });
    expect(unread.status).toBe(200);
    // The server now has a response on that connection its client is not reading.
    expect(await until(() => p.stuckCount() > 0, 5_000)).toBe(true);

    const title = await within(
      5_000,
      clientOf(p).generateText({ messages: [{ role: 'user', content: 'title please' }] }),
    );
    // One-shot and streamed calls alike.
    const turn = await within(
      5_000,
      clientOf(p).generateText(
        { messages: [{ role: 'user', content: 'turn please' }] },
        { streamed: true },
      ),
    );
    holder.abort();

    expect(title === 'stalled' ? title : title.text).toBe('answer to title please');
    expect(turn === 'stalled' ? turn : turn.text).toBe('answer to turn please');
  });

  it('a stream that breaks mid-answer releases its response, and the next call answers', async () => {
    const p = await standIn();
    const err = await clientOf(p)
      .generateText({ messages: [{ role: 'user', content: 'break' }] }, { streamed: true })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).partialText).toBe('partial ');
    // The stand-in never ends that stream: only the client can close it.
    expect(await until(() => servedFor(p, 'break')?.closed === true, 2_000)).toBe(true);

    const next = await within(
      5_000,
      clientOf(p).generateText({ messages: [{ role: 'user', content: 'after break' }] }),
    );
    expect(next === 'stalled' ? next : next.text).toBe('answer to after break');
  });

  it('Stop during a streamed turn releases its response, and the next call answers', async () => {
    const p = await standIn();
    const stop = new AbortController();
    const call = clientOf(p).generateText(
      { messages: [{ role: 'user', content: 'hold' }] },
      {
        streamed: true,
        abortSignal: stop.signal,
        onTextDelta: () => stop.abort(),
      },
    );
    const err = await call.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMCallCancelledError);
    const held = p.served.filter((s) => s.prompt === 'hold').at(-1);
    expect(await until(() => held?.closed === true, 2_000)).toBe(true);

    const next = await within(
      5_000,
      clientOf(p).generateText({ messages: [{ role: 'user', content: 'after stop' }] }),
    );
    expect(next === 'stalled' ? next : next.text).toBe('answer to after stop');
  });

  // The two Stops of 2026-09-29 before the stall (02:19:44 and 02:27:21 UTC)
  // both cut a call that had received 0 characters, 22-24 s in: before the
  // first byte of the answer, or after the headers with only keep-alives.
  for (const [prompt, when] of [
    ['no-headers', 'before the response headers'],
    ['processing', 'after the headers, with only keep-alives received'],
  ] as const) {
    it(`Stop ${when} releases the request, and the next call answers`, async () => {
      const p = await standIn();
      const stop = new AbortController();
      const call = clientOf(p).generateText(
        { messages: [{ role: 'user', content: prompt }] },
        { streamed: true, abortSignal: stop.signal },
      );
      expect(await until(() => servedFor(p, prompt) !== undefined, 5_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      stop.abort();
      const err = await call.catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LLMCallCancelledError);
      expect((err as LLMCallCancelledError).partialText).toBe('');
      expect(await until(() => servedFor(p, prompt)?.closed === true, 2_000)).toBe(true);

      const next = await within(
        5_000,
        clientOf(p).generateText({ messages: [{ role: 'user', content: 'after stop' }] }),
      );
      expect(next === 'stalled' ? next : next.text).toBe('answer to after stop');
    });
  }

  it('an expired first-token clock releases its response, and the next call answers', async () => {
    const p = await standIn();
    const err = await clientOf(p)
      .generateText(
        { messages: [{ role: 'user', content: 'mute' }] },
        { streamed: true, firstTokenTimeoutMs: 200 },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).reason).toBe('idle_before_first_token');
    expect(await until(() => servedFor(p, 'mute')?.closed === true, 2_000)).toBe(true);

    const next = await within(
      5_000,
      clientOf(p).generateText({ messages: [{ role: 'user', content: 'after clock' }] }),
    );
    expect(next === 'stalled' ? next : next.text).toBe('answer to after clock');
  });

  it('a context probe that is refused cancels the body it will not read', async () => {
    const p = await standIn();
    // A timeout far beyond the assertion: the release must not be the timeout's.
    const window = await probeContextWindow({ baseURL: p.baseURL, timeoutMs: 10_000 });

    expect(window).toBeNull();
    const probe = p.served.find((s) => s.path.startsWith('/api/v0/models'));
    expect(await until(() => probe?.closed === true, 2_000)).toBe(true);
  });
});
