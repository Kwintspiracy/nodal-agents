// route-cut-reason.test.ts — la porte web relaie la raison d'une coupure
// jusqu'au navigateur (#484, revue Codex passe 4). Elle ne relayait que
// `error` : `cutReason` se perdait entre le runner et l'écran.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/server.ts', () => {
  const chaine = {
    from: () => chaine,
    leftJoin: () => chaine,
    where: () => chaine,
    limit: async () => [{ agentId: 'agent-1', agentActive: true }],
  };
  return {
    getDb: () => ({ select: () => chaine }),
    requireUserWithEntity: async () => ({ userId: 'u', entityId: 'e' }),
  };
});
vi.mock('@/lib/env.ts', () => ({
  env: { WORKER_SECRET: 'secret', RUNNER_URL: 'http://runner.test' },
}));

import { POST } from '../route.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/chat/stream relays the cut reason (#484) @cap:parler-a-un-agent/ecran', () => {
  it('an llm_cut error event reaches the browser with its cutReason', async () => {
    const runner = new Response(
      'event: error\ndata: {"error":"llm_cut","cutReason":"invisible_production"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(runner)),
    );

    const res = await POST(
      new Request('http://localhost/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '11111111-1111-4111-8111-111111111111',
          message: 'monte la vidéo',
        }),
      }),
    );
    const corps = await res.text();

    expect(corps).toContain('event: error');
    const data = corps.slice(corps.indexOf('data: ') + 6).split('\n')[0]!;
    expect(JSON.parse(data)).toEqual({ error: 'llm_cut', cutReason: 'invisible_production' });
  });
});
