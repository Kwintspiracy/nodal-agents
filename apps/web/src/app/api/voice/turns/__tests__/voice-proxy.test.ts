// voice-proxy.test.ts — la porte web du tour vocal (#942) est un RELAIS.
//
// Ce qui se prouve : l'entité vient de la session et jamais du client, le
// secret interne part vers le runner, le corps d'un morceau arrive au runner
// octet pour octet, et la réponse du runner revient telle quelle (statut et
// corps) — un code d'erreur n'est ni traduit ni avalé. Les assertions portent
// sur la requête que le runner REÇOIT (invariant #5).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const session = vi.hoisted(() => ({
  current: { userId: 'u-1', entityId: 'entity-of-the-session' } as {
    userId: string;
    entityId: string;
  } | null,
}));
vi.mock('@/lib/server.ts', () => ({
  requireUserWithEntity: async () => {
    if (session.current === null) throw new Error('unauthorized');
    return session.current;
  },
}));
vi.mock('@/lib/env.ts', () => ({
  env: { WORKER_SECRET: 'worker-secret', RUNNER_URL: 'http://runner.test' },
}));

import { POST as start } from '../route.ts';
import { DELETE as cancel } from '../[turnId]/route.ts';
import { POST as end } from '../[turnId]/end/route.ts';
import { POST as chunk } from '../[turnId]/chunks/[seq]/route.ts';

type Received = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};
let received: Received[];
let runnerAnswer: () => Response;

beforeEach(() => {
  received = [];
  session.current = { userId: 'u-1', entityId: 'entity-of-the-session' };
  runnerAnswer = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
      const contentType = headers.get('content-type');
      received.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        contentType,
        body:
          raw === null
            ? null
            : contentType === 'application/json'
              ? (JSON.parse(new TextDecoder().decode(raw)) as unknown)
              : [...raw],
      });
      return runnerAnswer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const params = <T>(p: T): { params: Promise<T> } => ({ params: Promise.resolve(p) });

describe('the web door of the voice turn is a pass-through (#942) @cap:parler-a-un-agent/ecran', () => {
  it('start: the entity is the SESSION one, never the one a client sends', async () => {
    runnerAnswer = () => new Response(JSON.stringify({ turnId: 't-9' }), { status: 201 });
    const res = await start(
      new Request('http://web.test/api/voice/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: 'someone-else',
          conversationId: 'c-1',
          format: 'audio/pcm',
          sampleRate: 16000,
        }),
      }),
    );
    expect(received).toEqual([
      {
        url: 'http://runner.test/api/voice/turns',
        method: 'POST',
        authorization: 'Bearer worker-secret',
        contentType: 'application/json',
        body: {
          conversationId: 'c-1',
          format: 'audio/pcm',
          sampleRate: 16000,
          entityId: 'entity-of-the-session',
        },
      },
    ]);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ turnId: 't-9' });
  });

  it('a chunk reaches the runner byte for byte, at its turn and rank', async () => {
    runnerAnswer = () => new Response(JSON.stringify({ received: 4 }), { status: 200 });
    const res = await chunk(
      new Request('http://web.test/api/voice/turns/t-9/chunks/3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([0, 255, 7, 128]),
      }),
      params({ turnId: 't-9', seq: '3' }),
    );
    expect(received).toEqual([
      {
        url: 'http://runner.test/api/voice/turns/t-9/chunks/3',
        method: 'POST',
        authorization: 'Bearer worker-secret',
        contentType: 'application/octet-stream',
        body: [0, 255, 7, 128],
      },
    ]);
    expect(await res.json()).toEqual({ received: 4 });
  });

  it('end: the runner stream comes back as it is, event by event, as it is written (#943)', async () => {
    // A stream the test writes while the browser reads: the first event must
    // reach the browser before the runner has written the last one.
    let write!: (s: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        write = (s) => c.enqueue(new TextEncoder().encode(s));
        close = () => c.close();
      },
    });
    runnerAnswer = () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    const browser = new AbortController();
    const res = await end(
      new Request('http://web.test/api/voice/turns/t-9/end', {
        method: 'POST',
        signal: browser.signal,
      }),
      params({ turnId: 't-9' }),
    );
    expect(received.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST http://runner.test/api/voice/turns/t-9/end',
    ]);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const transcript = 'event: transcript\ndata: {"transcript":"Hi","durationMs":900}\n\n';
    write(transcript);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(transcript);
    const done = 'event: done\ndata: {"reply":"Hello."}\n\n';
    write(done);
    close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(done);
    expect((await reader.read()).done).toBe(true);
  });

  it('the browser gone, the request to the runner is abandoned with it (#943)', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Response('', { status: 200 });
      }),
    );
    const browser = new AbortController();
    await end(
      new Request('http://web.test/api/voice/turns/t-9/end', {
        method: 'POST',
        signal: browser.signal,
      }),
      params({ turnId: 't-9' }),
    );
    expect(signals[0]!.aborted).toBe(false);
    browser.abort();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('a runner refusal is relayed with its status and code, not translated', async () => {
    runnerAnswer = () =>
      new Response(JSON.stringify({ error: 'transcription_failed', detail: 'provider 500' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    const res = await end(
      new Request('http://web.test/api/voice/turns/t-9/end', { method: 'POST' }),
      params({ turnId: 't-9' }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'transcription_failed', detail: 'provider 500' });
  });

  it('cancel: a DELETE of that turn', async () => {
    runnerAnswer = () => new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    const res = await cancel(
      new Request('http://web.test/api/voice/turns/t-9', { method: 'DELETE' }),
      params({ turnId: 't-9' }),
    );
    expect(received.map((r) => `${r.method} ${r.url} ${r.authorization ?? ''}`)).toEqual([
      'DELETE http://runner.test/api/voice/turns/t-9 Bearer worker-secret',
    ]);
    expect(await res.json()).toEqual({ cancelled: true });
  });

  it('no session: 401, and nothing reaches the runner', async () => {
    session.current = null;
    const res = await start(
      new Request('http://web.test/api/voice/turns', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c-1', format: 'audio/pcm', sampleRate: 16000 }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(received).toEqual([]);
  });

  it('a path segment cannot climb out of the voice routes', async () => {
    await cancel(
      new Request('http://web.test/api/voice/turns/x', { method: 'DELETE' }),
      params({ turnId: '../../chat/stop' }),
    );
    expect(received.map((r) => r.url)).toEqual([
      'http://runner.test/api/voice/turns/..%2F..%2Fchat%2Fstop',
    ]);
  });
});
