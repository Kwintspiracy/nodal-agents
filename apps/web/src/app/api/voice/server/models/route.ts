// POST /api/voice/server/models — les modèles d'un serveur de la personne (#1048).
//
// La porte web de la route du runner (apps/runner/src/routes/voice-setting.ts).
// Relais pur : la part et le serveur à l'écran sont ceux du client, l'entité
// celle de la session. C'est le RUNNER qui joint le serveur, jamais le
// navigateur : l'adresse est lue depuis la machine qui la jointra au tour.

import { env } from '@/lib/env.ts';
import { proxyToRunner } from '@/lib/runner-proxy.ts';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return proxyToRunner(req, `${env.RUNNER_URL}/api/voice/server/models`, {
    method: 'POST',
    door: 'voice/server/models',
    body: async (session) => {
      const raw: unknown = await req.json().catch(() => null);
      const sent = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      return { part: sent['part'], server: sent['server'], entityId: session.entityId };
    },
  });
}
