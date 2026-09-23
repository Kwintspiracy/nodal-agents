// chat-live-route.test.ts — POST /api/chat/live, la porte web du tour suivi (#457).
//
// La page rouverte reçoit d'un bloc TOUT ce qui avait déjà été écrit : ce
// texte-là doit passer par le même masqueur que la suite (SECRET-001), sinon
// revenir sur une page montrerait une clé que la page d'origine avait masquée.
// Et quand aucun tour ne tourne, la porte le dit par un 204, pas par un flux vide.
//
// Le runner est simulé (`fetch`) avec la forme exacte que sa route rend ; la
// session et la base sont simulées au plus court : c'est la traduction de la
// porte qui est prouvée ici, pas le runner (voir `chat-live.test.ts`).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const CONV = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/server.ts', () => ({
  requireUserWithEntity: async () => ({ userId: 'u', entityId: 'e' }),
  // select().from().where().limit() → la conversation de l'entité.
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: CONV }] }) }) }),
  }),
}));
vi.mock('@/lib/env.ts', () => ({
  env: { WORKER_SECRET: 'test-secret', RUNNER_URL: 'http://runner.test' },
}));

let upstream: () => Response = () => new Response(null, { status: 204 });
const upstreamCalls: Array<{ url: string; body: unknown; auth: string | null }> = [];
vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  upstreamCalls.push({
    url,
    body: JSON.parse(String(init.body)),
    auth: new Headers(init.headers).get('Authorization'),
  });
  return upstream();
});

const sse = (...events: Array<[string, unknown]>): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

async function post(): Promise<Response> {
  const { POST } = await import('../../app/api/chat/live/route.ts');
  return POST(
    new Request('http://web.test/api/chat/live', {
      method: 'POST',
      body: JSON.stringify({ conversationId: CONV }),
    }),
  );
}

beforeEach(() => {
  upstreamCalls.length = 0;
});

describe('POST /api/chat/live @cap:parler-a-un-agent/moteur', () => {
  it('masque le texte déjà écrit comme la suite, et relaie start / delta / end', async () => {
    const secret = 'sk-ant-api03-QRSTUVWXYZ0123456789ABCDEFGHIJ'; // secrets:allow (fixture : clé factice)
    upstream = () =>
      sse(
        ['start', { text: `La clé est ${secret} et `, startedAt: 1234 }],
        ['delta', { text: 'la suite.' }],
        ['end', {}],
      );

    const res = await post();
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(upstreamCalls).toEqual([
      {
        url: 'http://runner.test/api/chat/live',
        body: { entityId: 'e', conversationId: CONV },
        auth: 'Bearer test-secret',
      },
    ]);
    expect(body).not.toContain(secret);
    expect(body).toContain('event: start\ndata: {"startedAt":1234}');
    // Le masqueur découpe à sa guise : c'est le texte RECOLLÉ qui compte.
    const text = [...body.matchAll(/event: delta\ndata: (.*)\n/g)]
      .map((m) => (JSON.parse(m[1]!) as { text: string }).text)
      .join('');
    expect(text).toBe('La clé est [secret masqué] (sk-) et la suite.');
    expect(body.trimEnd().endsWith('event: end\ndata: {}')).toBe(true);
  });

  it('aucun tour ne tourne : 204, pas un flux vide', async () => {
    upstream = () => new Response(null, { status: 204 });

    const res = await post();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});
