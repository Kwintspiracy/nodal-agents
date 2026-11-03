// GET / PUT /api/voice/setting — la voix de l'espace, depuis le navigateur (#969).
//
// La porte web de la route du runner (apps/runner/src/routes/voice-setting.ts,
// dont l'en-tête décrit le contrat). Un relais, rien de plus (règle du #948) :
// un module externe lit et choisit la voix par la même route. La seule chose
// que la porte écrit elle-même est l'ENTITÉ, prise sur la session : celle
// qu'un client enverrait est ignorée.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/setting`, {
    method: 'GET',
    door: 'voice/setting',
    query: (session) => ({ entityId: session.entityId }),
  });
}

export async function PUT(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/setting`, {
    method: 'PUT',
    door: 'voice/setting',
    body: async (session) => {
      const raw: unknown = await req.json().catch(() => null);
      const sent = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      // Le réglage tel quel : c'est le runner qui le valide et qui dit ce qui ne va pas.
      return { setting: sent['setting'], entityId: session.entityId };
    },
  });
}
