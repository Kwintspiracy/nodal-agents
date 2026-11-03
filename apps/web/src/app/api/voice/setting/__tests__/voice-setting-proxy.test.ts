// voice-setting-proxy.test.ts — la porte web de la voix (#969) est un RELAIS.
//
// Ce qui se prouve : l'entité vient de la session et jamais du client (dans la
// requête d'une lecture, dans le corps d'une écriture et d'un essai), le
// secret interne part vers le runner, et la réponse du runner revient telle
// quelle — un refus garde son statut et son code, un flux reste un flux. Les
// assertions portent sur la requête que le runner REÇOIT (invariant #5).

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

import { GET, PUT } from '../route.ts';
import { POST as sample } from '../../sample/route.ts';

type Received = { url: string; method: string; authorization: string | null; body: unknown };
let received: Received[];
let runnerAnswer: () => Response;

beforeEach(() => {
  received = [];
  session.current = { userId: 'u-1', entityId: 'entity-of-the-session' };
  runnerAnswer = () => Response.json({ ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      received.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
      });
      return runnerAnswer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the web door of the voice setting is a pass-through (#969) @cap:parler-a-un-agent/ecran', () => {
  // Mutation verified: `query` left out of the proxy (the URL sent as is) →
  // red, the runner gets no entity.
  it('read: the entity is the SESSION one, in the query, and the answer comes back as is', async () => {
    runnerAnswer = () => Response.json({ setting: null, sources: [] }, { status: 200 });
    const res = await GET(new Request('http://web.test/api/voice/setting?entityId=someone-else'));
    expect(received).toEqual([
      {
        url: 'http://runner.test/api/voice/setting?entityId=entity-of-the-session',
        method: 'GET',
        authorization: 'Bearer worker-secret',
        body: null,
      },
    ]);
    expect(await res.json()).toEqual({ setting: null, sources: [] });
  });

  it('write: the setting as sent, the entity of the session; a refusal keeps its status and code', async () => {
    runnerAnswer = () =>
      Response.json({ error: 'voice_not_offered', detail: 'x offers leo' }, { status: 409 });
    const setting = { source: 'openrouter', model: 'x-ai/grok-voice-tts-1.0', voice: 'Kore' };
    const res = await PUT(
      new Request('http://web.test/api/voice/setting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: 'someone-else', setting }),
      }),
    );
    expect(received).toEqual([
      {
        url: 'http://runner.test/api/voice/setting',
        method: 'PUT',
        authorization: 'Bearer worker-secret',
        body: { setting, entityId: 'entity-of-the-session' },
      },
    ]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'voice_not_offered', detail: 'x offers leo' });
  });

  it('sample: the sentence and the voice on screen, the entity of the session, the stream as a stream', async () => {
    runnerAnswer = () =>
      new Response('event: done\ndata: {"speechError":null}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    const res = await sample(
      new Request('http://web.test/api/voice/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: 'someone-else', text: 'Hello.' }),
      }),
    );
    expect(received).toEqual([
      {
        url: 'http://runner.test/api/voice/sample',
        method: 'POST',
        authorization: 'Bearer worker-secret',
        body: { text: 'Hello.', entityId: 'entity-of-the-session' },
      },
    ]);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: done\ndata: {"speechError":null}\n\n');
  });

  it('no session: refused before the runner is reached', async () => {
    session.current = null;
    const res = await GET(new Request('http://web.test/api/voice/setting'));
    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });
});
