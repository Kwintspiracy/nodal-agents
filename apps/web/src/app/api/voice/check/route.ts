// POST /api/voice/check — l'état d'une part de la voix (#1048), depuis le navigateur.
//
// La porte web de la route du runner (apps/runner/src/routes/voice-setting.ts,
// dont l'en-tête décrit le contrat). Relais pur, comme `../setting/route.ts` :
// la part et le réglage à l'écran sont ceux du client, l'entité celle de la
// session. Un module externe demande le même état par la même route du runner.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/check`, {
    method: 'POST',
    door: 'voice/check',
    body: async (session) => {
      const raw: unknown = await req.json().catch(() => null);
      const sent = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      // Les champs du contrat, tels quels : c'est le runner qui les valide.
      return {
        part: sent['part'],
        ...(sent['speaking'] !== undefined ? { speaking: sent['speaking'] } : {}),
        ...(sent['listening'] !== undefined ? { listening: sent['listening'] } : {}),
        ...(sent['fresh'] !== undefined ? { fresh: sent['fresh'] } : {}),
        entityId: session.entityId,
      };
    },
  });
}
