// events-route.test.ts — GET /api/events, la porte web du flux poussé (#944).
//
// La porte pose l'espace de la SESSION, jamais celui que la page affirmerait,
// relaie la reprise (`Last-Event-ID`), puis rend le flux du runner tel quel :
// ce qu'une page reçoit est ce qu'un module externe reçoit en lisant la route
// du runner (règle de #948). Le runner est simulé (`fetch`) ; le protocole, la
// reprise et l'isolement sont prouvés sur le vrai runner
// (`apps/runner/src/tests/events/job-events-flow.test.ts`).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const CONV = '11111111-1111-4111-8111-111111111111';

const session = vi.hoisted(() => ({ current: { userId: 'u', entityId: 'e' } as object | null }));
vi.mock('@/lib/server.ts', () => ({
  requireUserWithEntity: async () => {
    if (!session.current) throw new Error('unauthorized');
    return session.current;
  },
}));
vi.mock('@/lib/env.ts', () => ({
  env: { WORKER_SECRET: 'test-secret', RUNNER_URL: 'http://runner.test' },
}));

let upstream: () => Response = () => new Response(null, { status: 500 });
const upstreamCalls: Array<{ url: string; auth: string | null; lastEventId: string | null }> = [];
vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  const headers = new Headers(init.headers);
  upstreamCalls.push({
    url,
    auth: headers.get('Authorization'),
    lastEventId: headers.get('Last-Event-ID'),
  });
  return upstream();
});

const RUNNER_STREAM =
  'id: b:0\nevent: ready\ndata: {}\n\n' +
  'id: b:1\nevent: job.finished\ndata: {"type":"job.finished","jobId":"j1","reply":"Done."}\n\n';

async function get(query: string, headers: Record<string, string> = {}): Promise<Response> {
  const { GET } = await import('../../app/api/events/route.ts');
  return GET(new Request(`http://web.test/api/events${query}`, { headers }));
}

beforeEach(() => {
  upstreamCalls.length = 0;
  session.current = { userId: 'u', entityId: 'e' };
  upstream = () =>
    new Response(RUNNER_STREAM, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
});

describe('GET /api/events @cap:suivre-execution/moteur', () => {
  it("demande au runner l'espace de la session, relaie la reprise, et rend son flux tel quel", async () => {
    const res = await get(`?conversationId=${CONV}&entityId=forged`, { 'Last-Event-ID': 'b:7' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(await res.text()).toBe(RUNNER_STREAM);
    expect(upstreamCalls).toEqual([
      {
        // `entityId=forged` de la page n'arrive jamais au runner.
        url: `http://runner.test/api/events?entityId=e&conversationId=${CONV}`,
        auth: 'Bearer test-secret',
        lastEventId: 'b:7',
      },
    ]);
  });

  it('le refus du runner passe avec son code (une conversation hors de l’espace : 404)', async () => {
    upstream = () =>
      new Response(JSON.stringify({ error: 'conversation_not_found' }), { status: 404 });
    const res = await get(`?conversationId=${CONV}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'conversation_not_found' });
  });

  it('sans session, 401, et le runner n’est pas appelé', async () => {
    session.current = null;
    const res = await get('');
    expect(res.status).toBe(401);
    expect(upstreamCalls).toEqual([]);
  });

  it('une conversation illisible est refusée avant le runner', async () => {
    const res = await get('?conversationId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(upstreamCalls).toEqual([]);
  });
});
