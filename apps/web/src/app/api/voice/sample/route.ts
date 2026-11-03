// POST /api/voice/sample — « Play a sample » des réglages (#969).
//
// La porte web de la route du runner (apps/runner/src/routes/voice-setting.ts).
// Relais pur, comme `../setting/route.ts` : la phrase et la voix essayée sont
// celles du client, l'entité celle de la session. La réponse (un flux SSE de
// morceaux de voix, comme la fin d'un tour dit) passe en flux.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/sample`, {
    method: 'POST',
    door: 'voice/sample',
    body: async (session) => {
      const raw: unknown = await req.json().catch(() => null);
      const sent = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      return {
        text: sent['text'],
        ...(sent['setting'] !== undefined ? { setting: sent['setting'] } : {}),
        entityId: session.entityId,
      };
    },
  });
}
