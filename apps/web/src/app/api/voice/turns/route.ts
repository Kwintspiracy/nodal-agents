// POST /api/voice/turns — ouvrir un tour dit, depuis le navigateur (#942).
//
// La porte web des routes du tour vocal du runner (#941,
// apps/runner/src/routes/voice-turn.ts, dont l'en-tête décrit le protocole) :
// start ici, puis les morceaux (`[turnId]/chunks/[seq]`), la fin
// (`[turnId]/end`) et l'annulation (DELETE `[turnId]`).
//
// Un relais, rien de plus (règle du #948) : le tableau de bord passe par les
// routes qu'un module externe appelle, et aucune logique vocale ne vit dans
// Next. La seule chose que la porte écrit elle-même est l'ENTITÉ, prise sur la
// session : celle qu'un client enverrait est ignorée.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/turns`, {
    method: 'POST',
    door: 'voice/turns',
    body: async (session) => {
      const raw: unknown = await req.json().catch(() => null);
      const sent = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      // Les champs du protocole, recopiés tels quels : c'est le runner qui les
      // valide et qui dit ce qui ne va pas.
      return {
        conversationId: sent['conversationId'],
        format: sent['format'],
        sampleRate: sent['sampleRate'],
        entityId: session.entityId,
      };
    },
  });
}
